/** Phase 3 后台沉淀:积累 session/event 里的用户/助手消息,
 *  session/disposed 时经 POST /ingest/async 秒回提交(client_key 幂等),
 *  服务端 bg_jobs 异步抽取(1-3min)——插件进程只需活到提交完成。
 *  质量门槛挡噪声:用户消息与助手结论都够长才存,寒暄/空转不入飞轮。 */
import { createHash } from "node:crypto";

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-session"; // Events 类型增强:session/event 等

import { ExoMindClient } from "./api.js";
import { resolveTarget, type ResolveEnv } from "./config.js";

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
      if (text) this.userTexts.push(text);
      return;
    }
    if (event.type === "assistant/message") {
      const data = event.data as { message?: MessageLike };
      // 中断的流是半截输出,不进存档
      if (data?.message?.interrupted) return;
      const text = blocksText(data?.message);
      if (text) this.assistantTexts.push(text);
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

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 注册沉淀管线,返回 drain 函数:等待在途提交(有界),供插件 dispose 时调用。 */
export function registerCapture(ctx: Context, options: CaptureOptions): () => Promise<void> {
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
      const digest = buffer.buildDigest({
        minUserChars: options.captureMinUserChars,
        minAssistantChars: options.captureMinAssistantChars,
        maxChars: options.captureMaxChars,
      });
      if (!digest) return;
      const target = resolveTarget(
        { baseUrl: options.baseUrl, apiKey: options.apiKey },
        options.resolveEnv,
      );
      const client = new ExoMindClient(target.baseUrl, target.apiKey, options.fetchImpl);
      // 尽力而为:提交失败(未登录/断网/超时)只丢弃本条,绝不影响宿主
      pending.push(
        client
          .post("/ingest/async", {
            body: {
              content: digest.content,
              title: digest.title,
              tags: ["dsh", "会话存档"],
              client_key: deriveClientKey(digest.content),
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
