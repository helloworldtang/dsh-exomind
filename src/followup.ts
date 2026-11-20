/** 召回采纳信号:注入之后,agent 是用了注入内容,还是绕开它另起炉灶。
 *  数据源全部来自 session 事件流,session 内自洽——不依赖 agent↔session 映射。
 *  每个有注入的 turn 在 turn/end 打**一行**汇总埋点:
 *    {turn, followup: "<工具名>"|"none", adopted: true|false}
 *  - followup = 该 turn 内 agent 调过的第一个 exomind 检索工具(注入不足/绕开信号);
 *  - adopted = 助手回答文本中出现了注入命中页的标题(正向采纳:注入内容真被用了)。
 *  三档读法:none+adopted=纯采纳(最好) / 工具+adopted=顺着注入深挖 /
 *           工具+!adopted=绕开重查 / none+!adopted=可能被忽略。
 *  adopted 是子串代理:模型转述可能不含原标题 → 偏低估;标题过短(<4字)易误命中 → 弃用。 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-session"; // Events 类型增强:session/event

/** 计入「跟进」的工具:检索/查实体/深问都是「注入之外再看一眼」。
 *  exomind_suggest 是选题推荐,不是检索行为,不计入。 */
const FOLLOWUP_TOOLS = new Set(["exomind_search", "exomind_entity", "exomind_query"]);

/** 标题参与采纳匹配的最小长度:过短(「复习」「工具」)极易在长回答里误命中。 */
const MIN_TITLE_CHARS = 4;

interface TurnRecord {
  /** 注入命中页的标题(从召回消息文本解析,渲染格式 `\d+. 标题 (路径)`)。 */
  titles: string[];
  /** 该 turn 内调过的第一个 exomind 检索工具名(未调过保持 null)。 */
  followup: string | null;
  /** 该 turn 的助手回答累积文本(中断流不记)。 */
  assistantText: string;
}

interface SessionFollowup {
  /** 最近一次 turn/start 的序号:recall 注入发生在 turn 内,消息事件本身不带 turn。 */
  currentTurn: number;
  turns: Map<number, TurnRecord>;
}

/** 从召回消息文本解析命中页标题(自包含:不依赖注入侧传参,只认落账的渲染产物)。 */
export function parseRecallTitles(text: string): string[] {
  const titles: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*\d+\.\s+(.+?)(?:\s+\([^()]*\))?\s*$/.exec(line);
    if (m?.[1]) titles.push(m[1]);
  }
  return titles;
}

function blocksText(message: { content?: { type?: string; text?: string }[] } | undefined): string {
  if (!message?.content) return "";
  return message.content
    .filter((block) => block.type === "text" && block.text?.trim())
    .map((block) => block.text!.trim())
    .join("\n");
}

/** 采纳判定:注入标题(去空白)作为子串出现在助手回答里。 */
function isAdopted(record: TurnRecord): boolean {
  const answer = record.assistantText.replace(/\s+/g, "");
  return record.titles.some((title) => {
    const t = title.replace(/\s+/g, "");
    return t.length >= MIN_TITLE_CHARS && answer.includes(t);
  });
}

export function registerFollowup(ctx: Context): () => void {
  const logger = ctx.logger("exomind-recall");
  const sessions = new WeakMap<object, SessionFollowup>();
  const state = (session: object): SessionFollowup => {
    let s = sessions.get(session);
    if (!s) {
      s = { currentTurn: 0, turns: new Map() };
      sessions.set(session, s);
    }
    return s;
  };

  const disposers = [
    ctx.on("session/event", (session: object, event: { type: string; data?: unknown }) => {
      const s = state(session);
      if (event.type === "turn/start") {
        s.currentTurn = (event.data as { turn?: number })?.turn ?? 0;
        return;
      }
      // 注入落账的信号:本插件 form='recall' 的 user/message(与 capture 同口径,
      // 只认真实提交进事件流的注入,pre-step 返回值不算数)
      if (event.type === "user/message") {
        const data = event.data as { source?: { kind?: string; form?: string }; content?: unknown };
        if (data?.source?.kind !== "plugin:exomind-flywheel" || data.source.form !== "recall") {
          return;
        }
        const titles = parseRecallTitles(blocksText(data as never));
        if (titles.length)
          s.turns.set(s.currentTurn, { titles, followup: null, assistantText: "" });
        return;
      }
      if (event.type === "assistant/message") {
        const data = event.data as {
          turn?: number;
          message?: { content?: { type?: string; text?: string }[]; interrupted?: boolean };
        };
        // 中断的流是半截输出,不进采纳判定
        if (!data?.turn || data.message?.interrupted) return;
        const record = s.turns.get(data.turn);
        if (record) record.assistantText += `\n${blocksText(data.message)}`;
        return;
      }
      if (event.type === "tool/call") {
        const data = event.data as { turn?: number; name?: string };
        const record = data.turn != null ? s.turns.get(data.turn) : undefined;
        if (record && !record.followup && FOLLOWUP_TOOLS.has(data.name ?? "")) {
          record.followup = data.name!;
        }
        return;
      }
      if (event.type === "turn/end") {
        const turn = (event.data as { turn?: number })?.turn;
        if (turn == null) return;
        const record = s.turns.get(turn);
        if (!record) return;
        s.turns.delete(turn);
        logger.info(
          JSON.stringify({ turn, followup: record.followup ?? "none", adopted: isAdopted(record) }),
        );
      }
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
