/** 召回采纳信号:注入之后,agent 是直接用了注入内容,还是仍主动调 ExoMind 工具。
 *  数据源全部来自 session 事件流,session 内自洽——不依赖 agent↔session 映射:
 *  turn/start 维护当前 turn → user/message(source=本插件 recall)标记该 turn 已注入
 *  → tool/call(exomind_search/entity/query)打 followup:"<工具名>"(注入不足/深化信号)
 *  → turn/end 仍无跟进打 followup:"none"。
 *  采纳率 = none / (none + 工具跟进),可直接从 exomind-recall 日志统计——
 *  这是召回择优/降级开关(TODO)的启动证据。 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-session"; // Events 类型增强:session/event

/** 计入「跟进」的工具:检索/查实体/深问都是「注入之外再看一眼」。
 *  exomind_suggest 是选题推荐,不是检索行为,不计入。 */
const FOLLOWUP_TOOLS = new Set(["exomind_search", "exomind_entity", "exomind_query"]);

interface SessionFollowup {
  /** 最近一次 turn/start 的序号:recall 注入发生在 turn 内,消息事件本身不带 turn。 */
  currentTurn: number;
  /** 已注入但尚未观察到工具跟进的 turn 集合。 */
  injectedTurns: Set<number>;
}

export function registerFollowup(ctx: Context): () => void {
  const logger = ctx.logger("exomind-recall");
  const sessions = new WeakMap<object, SessionFollowup>();
  const state = (session: object): SessionFollowup => {
    let s = sessions.get(session);
    if (!s) {
      s = { currentTurn: 0, injectedTurns: new Set() };
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
        const source = (event.data as { source?: { kind?: string; form?: string } })?.source;
        if (source?.kind === "plugin:exomind-flywheel" && source.form === "recall") {
          s.injectedTurns.add(s.currentTurn);
        }
        return;
      }
      if (event.type === "tool/call") {
        const data = event.data as { turn?: number; name?: string };
        if (!data.turn || !FOLLOWUP_TOOLS.has(data.name ?? "")) return;
        if (s.injectedTurns.delete(data.turn)) {
          logger.info(JSON.stringify({ turn: data.turn, followup: data.name }));
        }
        return;
      }
      if (event.type === "turn/end") {
        const turn = (event.data as { turn?: number })?.turn;
        if (turn != null && s.injectedTurns.delete(turn)) {
          logger.info(JSON.stringify({ turn, followup: "none" }));
        }
      }
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
