/** ExoMind 知识飞轮 DSH 插件入口:
 *  Phase 1 工具面(exomind_search/entity/query)+ Phase 2 自动召回
 *  (agent/pre-step → 有界 BM25 检索 → <exomind_context> 注入,fail-open)。 */
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import Schema from "@deepseek-ai/schemastery";

import { ExoMindClient } from "./api.js";
import { registerCapture } from "./capture.js";
import { resolveTarget } from "./config.js";
import { exomindMessageSource } from "./message-source.js";
import { directUserQuery, recallTimeoutMs, renderRecallText, TurnRecallGate } from "./recall.js";
import { registerExomindTools, type ToolOptions } from "./tools.js";

export const name = "exomind-flywheel";
export const inject = ["tools"];

export interface Config {
  baseUrl: string;
  apiKey: string;
  searchTimeoutMs: number;
  queryTimeoutMs: number;
  maxResultChars: number;
  recallEnabled: boolean;
  recallTimeoutMs: number;
  recallLimit: number;
  recallMaxChars: number;
  captureEnabled: boolean;
  captureMinUserChars: number;
  captureMinAssistantChars: number;
  captureMaxChars: number;
}

export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string()
    .default("")
    .description("ExoMind API 地址;留空继承 ~/.exomind/config.json 或环境变量"),
  apiKey: Schema.string().default("").description("API Key;留空继承 exomind login 写入的凭据"),
  searchTimeoutMs: Schema.number().min(1_000).default(15_000).description("search/entity 超时(ms)"),
  queryTimeoutMs: Schema.number().min(10_000).default(180_000).description("LLM 问答超时(ms)"),
  maxResultChars: Schema.number().min(500).default(6_000).description("工具结果长度上限(字符)"),
  recallEnabled: Schema.boolean()
    .default(true)
    .description("每条直接用户 turn 前自动注入一次检索结果"),
  recallTimeoutMs: Schema.number()
    .min(200)
    .default(2_000)
    .description("自动召回超时(ms);前台硬上限 3000,只能更短"),
  recallLimit: Schema.number().step(1).min(1).max(10).default(3).description("自动召回候选数"),
  recallMaxChars: Schema.number().min(200).default(3_000).description("注入上下文长度上限(字符)"),
  captureEnabled: Schema.boolean()
    .default(true)
    .description("会话结束自动把任务与结论沉淀进知识飞轮(异步,幂等)"),
  captureMinUserChars: Schema.number().min(1).default(8).description("沉淀门槛:用户消息最少字符数"),
  captureMinAssistantChars: Schema.number()
    .min(1)
    .default(100)
    .description("沉淀门槛:助手结论最少字符数"),
  captureMaxChars: Schema.number().min(500).default(8_000).description("存档正文长度上限(字符)"),
});

interface RecallHit {
  title?: string;
  path?: string;
  content?: string;
  snippet?: string;
}

interface RecallOptions extends ToolOptions {
  recallTimeoutMs: number;
  recallLimit: number;
  recallMaxChars: number;
}

/** agent/pre-step waterfall:先放行默认决策,再在原消息后追加召回消息。
 *  只对含 source.kind==='user' 的步召回(工具循环/插件消息/自身召回消息都不触发),
 *  同一逻辑 turn 去重;任何异常 fail-open 返回原决策。 */
export function registerRecall(
  ctx: Context,
  options: RecallOptions,
  gate: TurnRecallGate = new TurnRecallGate(),
): () => void {
  return ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision.kind !== "enter") return decision;
    const query = directUserQuery(decision.messages);
    // query 含自身召回消息(前缀 <exomind_context>)时 directUserQuery 已按 source 排除;
    // 此处长度门槛挡掉单字符噪声。
    if (query.length < 2 || !gate.claim(payload.agent, payload.turn)) return decision;
    try {
      const target = resolveTarget(
        { baseUrl: options.baseUrl, apiKey: options.apiKey },
        options.resolveEnv,
      );
      const client = new ExoMindClient(target.baseUrl, target.apiKey, options.fetchImpl);
      const result = (await client.get("/search", {
        query: { q: query.slice(0, 200), limit: options.recallLimit },
        timeoutMs: recallTimeoutMs(options.recallTimeoutMs),
        signal: payload.signal,
        retries: 0, // 前台预算内不重试,超时即放弃
      })) as { results?: RecallHit[] };
      const text = renderRecallText(result.results ?? [], options.recallMaxChars);
      if (!text) return decision;
      const recallMessage = createUserMessage({
        content: [{ type: "text", text }],
        source: exomindMessageSource("recall"),
      });
      return { ...decision, messages: [...decision.messages, recallMessage] };
    } catch {
      return decision; // fail-open:检索失败/超时/未登录都不阻塞宿主
    }
  });
}

/** Cordis 4 契约:apply 的返回值即 disposer(可为 promise,fiber 释放时等待)。
 *  沉淀管线的 drain 在 dispose 时有界等待在途提交(headless 退出窗口内完成秒回)。 */
export function apply(ctx: Context, config: Config): () => Promise<void> {
  const disposers: Array<() => void> = [];
  if (config.recallEnabled) {
    disposers.push(registerRecall(ctx, { ...config }));
  }
  disposers.push(registerExomindTools(ctx, config));
  const drain = config.captureEnabled
    ? registerCapture(ctx, { ...config })
    : async (): Promise<void> => undefined;
  return async (): Promise<void> => {
    for (const dispose of disposers.splice(0)) dispose();
    await drain();
  };
}
