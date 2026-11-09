/** 凭据解析:DSH 行配置 > 环境变量 > ~/.exomind/config.json(exomind-cli 共享)> 默认值。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_BASE_URL = "https://exomind-api.ai-as.cn";

/** ~/.exomind/config.json 的字段(exomind-cli 写入,本插件只读)。 */
export interface ExomindFileConfig {
  base_url?: string;
  api_key?: string;
}

/** 可注入的环境/主目录,便于测试;生产路径走真实 process.env 与 os.homedir()。 */
export interface ResolveEnv {
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

/** 读 ~/.exomind/config.json;文件缺失或损坏返回空对象(未登录场景静默降级)。 */
export function readExomindFileConfig(env: ResolveEnv = {}): ExomindFileConfig {
  const home = env.homeDir ?? process.env.HOME ?? "";
  try {
    return JSON.parse(
      readFileSync(join(home, ".exomind", "config.json"), "utf-8"),
    ) as ExomindFileConfig;
  } catch {
    return {};
  }
}

export interface Target {
  baseUrl: string;
  apiKey: string;
}

/**
 * 解析最终请求目标。优先级(高 → 低):
 * 1. DSH 行配置(baseUrl/apiKey 显式填写)
 * 2. 环境变量 EXOMIND_BASE_URL / EXOMIND_API_KEY
 * 3. ~/.exomind/config.json(与 exomind-cli 共享,`exomind login` 写入)
 * 4. 默认 base_url;apiKey 无默认——未配置时首个请求会得到明确的未登录错误
 */
export function resolveTarget(
  rowConfig: { baseUrl?: string; apiKey?: string },
  env: ResolveEnv = {},
): Target {
  const e = env.env ?? process.env;
  const file = readExomindFileConfig(env);
  return {
    baseUrl:
      rowConfig.baseUrl?.trim() ||
      e.EXOMIND_BASE_URL?.trim() ||
      file.base_url?.trim() ||
      DEFAULT_BASE_URL,
    apiKey: rowConfig.apiKey?.trim() || e.EXOMIND_API_KEY?.trim() || file.api_key?.trim() || "",
  };
}
