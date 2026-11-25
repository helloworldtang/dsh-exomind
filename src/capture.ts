/** Phase 3 后台沉淀:积累 session/event 里的用户/助手消息,
 *  session/disposed 时经 POST /ingest/async 秒回提交(client_key 幂等),
 *  服务端 bg_jobs 异步抽取(1-3min)——插件进程只需活到提交完成。
 *  质量门槛挡噪声:用户消息与助手结论都够长才存,寒暄/空转不入飞轮。 */
import { createHash } from "node:crypto";

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-session"; // Events 类型增强:session/event 等

import { ExoMindClient } from "./api.js";
import { resolveTarget, type ResolveEnv } from "./config.js";
import { sanitizeDigest } from "./sanitize.js";
import { DSH_ORIGIN } from "./revival.js";

export interface CaptureOptions {
  baseUrl?: string;
  apiKey?: string;
  captureEnabled: boolean;
  captureMinUserChars: number;
  captureMinAssistantChars: number;
  captureMaxChars: number;
  /** 测试注入。 */
  resolveEnv?: ResolveEnv;
  fetchImpl?: typeof fetch;
  /** 提交超时(ms);默认 10s,含一次瞬时重试。 */
  submitTimeoutMs?: number;
  /** 测试注入时钟/等待。 */
  sleep?: (ms: number) => Promise<void>;
}

interface TextBlock {
  type: string;
  text?: string;
}

interface MessageLike {
  content?: TextBlock[];
  source?: { kind?: string };
  interrupted?: boolean;
}

/** 单条消息入库前截断:存档渲染单条最多用 400 字(用户)/合计 maxChars(助手),
 *  入库即截防超长会话(大量长粘贴)内存无界累积;门槛只看长度下限,截断不影响判断。 */
const MAX_ENTRY_CHARS = 8_000;
/** 每侧最多保留条数:首条(任务标题来源)+ 最近若干条,超出的中间旧消息丢弃。 */
const MAX_ENTRIES = 100;

function pushBounded(texts: string[], text: string): void {
  texts.push(text.slice(0, MAX_ENTRY_CHARS));
  if (texts.length > MAX_ENTRIES) texts.splice(1, texts.length - MAX_ENTRIES);
}

/** 一个会话的积累缓冲。 */
export class CaptureBuffer {
  userTexts: string[] = [];
  assistantTexts: string[] = [];

  onEvent(event: { type: string; data?: unknown }): void {
    if (event.type === "user/message") {
      const message = event.data as MessageLike;
      // 只记直接用户消息:工具结果/插件注入(含本插件召回)不算用户输入
      if (message.source?.kind !== "user") return;
      const text = blocksText(message);
      if (text) pushBounded(this.userTexts, text);
      return;
    }
    if (event.type === "assistant/message") {
      const data = event.data as { message?: MessageLike };
      // 中断的流是半截输出,不进存档
      if (data?.message?.interrupted) return;
      const text = blocksText(data?.message);
      if (text) pushBounded(this.assistantTexts, text);
    }
  }

  buildDigest(options: {
    minUserChars: number;
    minAssistantChars: number;
    maxChars: number;
  }): { content: string; title: string } | null {
    const user = this.userTexts.join("\n").trim();
    const assistant = this.assistantTexts.join("\n\n").trim();
    if (user.length < options.minUserChars || assistant.length < options.minAssistantChars) {
      return null;
    }
    const task = this.userTexts[0].slice(0, 120);
    const clip = (text: string, cap: number): string =>
      text.length <= cap ? text : `${text.slice(0, cap)}…(截断)`;
    const userSection = this.userTexts
      .slice(0, 20)
      .map((text) => `- ${clip(text, 400)}`)
      .join("\n");
    const content = [
      "DSH 会话存档(DeepSeek Harness × ExoMind 知识飞轮自动沉淀)。",
      "",
      `任务:${task}`,
      "",
      "用户消息:",
      userSection,
      "",
      "助手结论:",
      clip(assistant, options.maxChars),
    ].join("\n");
    if (content.length > 50_000) return null; // 服务端上限,超长放弃(理论上不会:已按 maxChars 截断)
    return { content, title: `DSH 会话:${task.slice(0, 60)}` };
  }
}

function blocksText(message: MessageLike | undefined): string {
  if (!message?.content) return "";
  return message.content
    .filter((block) => block.type === "text" && block.text?.trim())
    .map((block) => block.text!.trim())
    .join("\n")
    .trim();
}

/** 提交幂等键,格式对齐 exomind-cli(前缀-44hex,总长 48,服务端 8~64 合法集):
 *  同内容重试/重投得到同 key,服务端第一跳复用已有 job,不产生重复。 */
export function deriveClientKey(seed: string): string {
  return `dsh-${createHash("sha256").update(seed, "utf-8").digest("hex").slice(0, 44)}`;
}

/** unref:兜底等待只为「有在途提交」而设;没有在途请求时,这个定时器不得拖住事件循环
 *  (否则宿主自然退出要多等到它到期)。 */
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());

/** 注册沉淀管线,返回 drain 函数:等待在途提交(有界),供插件 dispose 时调用。 */
export function registerCapture(ctx: Context, options: CaptureOptions): () => Promise<void> {
  const logger = ctx.logger("exomind-capture");
  // 知情提示(每进程一次):默认上传是产品的命,但用户必须知道传了什么、怎么关
  logger.info(
    "ExoMind 会话沉淀已开启:会话结束后将把「任务+用户消息+助手结论」(经结构化密钥脱敏)" +
      "上传知识飞轮,成为后续会话的自动召回素材;配置 captureEnabled: false 可关闭。",
  );
  const buffers = new WeakMap<object, CaptureBuffer>();
  const pending: Promise<unknown>[] = [];
  const sleep = options.sleep ?? defaultSleep;

  const disposers = [
    ctx.on("session/event", (session: object, event: { type: string; data?: unknown }) => {
      let buffer = buffers.get(session);
      if (!buffer) {
        buffer = new CaptureBuffer();
        buffers.set(session, buffer);
      }
      buffer.onEvent(event);
    }),
    ctx.on("session/disposed", (session: object) => {
      const buffer = buffers.get(session);
      if (!buffer) return;
      const target = resolveTarget(
        { baseUrl: options.baseUrl, apiKey: options.apiKey },
        options.resolveEnv,
      );
      const client = new ExoMindClient(target.baseUrl, target.apiKey, options.fetchImpl);
      // 主动建议(飞轮的「驱动下一轮摄入」腿):沉淀提交后顺带取一条选题建议,
      // 与知情提示同通道输出;失败静默,不打扰退出流程
      pending.push(
        client
          .get("/suggest-topics", { query: { count: 1 }, timeoutMs: 5_000 })
          .then((result) => {
            const topic = (
              result as {
                topics?: Array<{ topic?: string; reason?: string; unique_angle?: string }>;
              }
            )?.topics?.[0];
            if (!topic?.topic) return;
            const why = topic.reason ?? topic.unique_angle;
            logger.info(
              `ExoMind 建议下一步深挖: ${topic.topic}${why ? ` — ${String(why).slice(0, 120)}` : ""}`,
            );
          })
          .catch(() => undefined),
      );
      const digest = buffer.buildDigest({
        minUserChars: options.captureMinUserChars,
        minAssistantChars: options.captureMinAssistantChars,
        maxChars: options.captureMaxChars,
      });
      if (!digest) return;
      // 出站收口脱敏:对最终出站的 content+title 做最后一扫,无旁路
      const sanitized = sanitizeDigest(digest.content, digest.title);
      if (sanitized.masked > 0) {
        logger.warn(JSON.stringify({ masked: sanitized.masked, dropped: sanitized.dropped }));
      }
      if (sanitized.dropped) return; // 命中过多:视为密钥清单粘贴,整条放弃
      // 尽力而为:提交失败(未登录/断网/超时)只丢弃本条,绝不影响宿主
      pending.push(
        client
          .post("/ingest/async", {
            body: {
              content: sanitized.content,
              title: sanitized.title,
              tags: ["dsh", "会话存档"],
              // 服务端 ingest_log 的 log_source:dsh 沉淀页的回查过滤键(复活率数据源)
              origin: DSH_ORIGIN,
              client_key: deriveClientKey(sanitized.content),
            },
            timeoutMs: options.submitTimeoutMs ?? 10_000,
          })
          .catch(() => undefined),
      );
    }),
  ];

  return async (): Promise<void> => {
    for (const dispose of disposers) dispose();
    // 有界等待在途提交(headless 进程退出前的窗口内完成秒回提交)
    await Promise.race([Promise.allSettled(pending), sleep(3_000)]);
  };
}
