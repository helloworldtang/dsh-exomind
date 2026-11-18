/** 凭据解析:DSH 行配置 > 环境变量 > ~/.exomind/config.json(exomind-cli 共享)> 默认值。 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
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
  /** 测试注入;生产用 node:os 的 homedir(Windows 下落 USERPROFILE)。 */
  homedir?: () => string;
}

/** JSON 损坏告警去重:resolveTarget 每次工具调用都会执行,同一路径只警告一次。 */
const warnedPaths = new Set<string>();

/** 读 ~/.exomind/config.json;所有候选位置都无文件返回空对象(未登录场景静默降级),
 *  解析失败(文件存在但损坏)打一条警告后继续试下一候选,不留无声死局。 */
export function readExomindFileConfig(env: ResolveEnv = {}): ExomindFileConfig {
  const e = env.env ?? process.env;
  const resolveHomedir = env.homedir ?? homedir;
  // 候选主目录:显式注入(测试隔离,只用它)> os.homedir() > HOME(仅当不同)。
  // 写入方 exomind-cli 落盘在 os.homedir()/.exomind(不读 HOME),homedir 优先才对齐:
  // ①Windows 下 Git Bash/MSYS 的 HOME 是 POSIX 形态(/c/Users/x),Node 拼出的路径
  //   解析不到 cli 按 USERPROFILE 落盘的文件;②mac/linux 自定义 HOME 同理错位。
  // HOME 保留为兜底:homedir 无文件而用户手工把 config 放在 $HOME 时仍可读到。
  const candidates = env.homeDir
    ? [env.homeDir]
    : [...new Set([resolveHomedir(), e.HOME].filter((v): v is string => !!v))];
  for (const home of candidates) {
    const path = join(home, ".exomind", "config.json");
    try {
      const raw = readFileSync(path, "utf-8");
      // Windows 记事本保存的 JSON 可能带 BOM,JSON.parse 不认,剥掉再解析
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      return JSON.parse(text) as ExomindFileConfig;
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === "ENOENT") continue; // 该候选无文件,试下一个
      if (!warnedPaths.has(path)) {
        warnedPaths.add(path);
        console.warn(`[dsh-exomind] ${path} 存在但解析失败,已忽略文件凭据:`, e2);
      }
    }
  }
  return {};
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
