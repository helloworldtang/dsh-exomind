/** ExoMind 知识飞轮 DSH 插件入口(Phase 1 工具版):
 *  只注册三个只读工具,不挂 agent/pre-step(自动召回是 Phase 2,
 *  届时需把检索约束在 DSH 前台 3 秒 SLA 内)。 */
import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";

import { registerExomindTools } from "./tools.js";

export const name = "exomind-flywheel";
export const inject = ["tools"];

export interface Config {
  baseUrl: string;
  apiKey: string;
  searchTimeoutMs: number;
  queryTimeoutMs: number;
  maxResultChars: number;
}

export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string()
    .default("")
    .description("ExoMind API 地址;留空继承 ~/.exomind/config.json 或环境变量"),
  apiKey: Schema.string().default("").description("API Key;留空继承 exomind login 写入的凭据"),
  searchTimeoutMs: Schema.number().min(1_000).default(15_000).description("search/entity 超时(ms)"),
  queryTimeoutMs: Schema.number().min(10_000).default(180_000).description("LLM 问答超时(ms)"),
  maxResultChars: Schema.number().min(500).default(6_000).description("工具结果长度上限(字符)"),
});

/** Cordis 4 契约:apply 的返回值即 disposer(fiber 释放时调用)。 */
export function apply(ctx: Context, config: Config): () => void {
  return registerExomindTools(ctx, config);
}
