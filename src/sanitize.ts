/** 出站脱敏:沉淀 payload 在 POST 前对最终出站字节(content + title)做最后一扫。
 *  收口原则:无论 digest 组装逻辑怎么改,出站必经这里,没有旁路(title 是独立
 *  字段,扫组装过程会漏掉它)。只检结构化 credential 形态(前缀/长度强约束,
 *  中文语料下误报近零);无结构敏感内容(prose 密码/客户数据)超出正则能力,
 *  由插件启用时的知情提示兜底。 */

export interface SanitizeResult {
  content: string;
  title: string;
  /** 命中并打码的敏感片段数。 */
  masked: number;
  /** true = 命中过多(整段基本是密钥清单而非正常会话),放弃本次上传。 */
  dropped: boolean;
}

/** 打码保留前缀长度:够认出"这里曾有个 key",不够还原。 */
const KEEP_PREFIX = 4;
/** 放弃阈值:正常调试会话不会贴这么多密钥,超过视为密钥清单粘贴。 */
const DROP_THRESHOLD = 10;

const mask = (match: string): string => `${match.slice(0, KEEP_PREFIX)}***REDACTED***`;

interface SecretPattern {
  re: RegExp;
  replace: (match: string) => string;
}

/** 结构化 credential 清单:起步宜窄,误杀比漏杀伤害低(漏的还有服务端第二道)。 */
const SECRET_PATTERNS: SecretPattern[] = [
  // PEM 私钥块(整块替换,块内任意字符含换行)
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => "[REDACTED:PEM 私钥块]",
  },
  // OpenAI / Anthropic / bigmodel 系 sk- 前缀 key
  { re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, replace: mask },
  // AWS Access Key ID
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: mask },
  // GitHub token(classic gh?_ 与 fine-grained)
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g, replace: mask },
  { re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, replace: mask },
  // Slack token
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: mask },
  // Google API key
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: mask },
  // JWT(三段 base64url,首段以 eyJ 开头)
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: mask },
  // Authorization: Bearer(贴 curl 命令场景,保留字面 Bearer 便于阅读)
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, replace: () => "Bearer ***REDACTED***" },
];

/** 对即将出站的 content 与 title 逐模式扫描打码;命中超阈值整条放弃。 */
export function sanitizeDigest(content: string, title: string): SanitizeResult {
  let masked = 0;
  const sanitized = [content, title].map((text) => {
    let result = text;
    for (const { re, replace } of SECRET_PATTERNS) {
      result = result.replace(re, (...args: unknown[]) => {
        masked++;
        return replace(args[0] as string);
      });
    }
    return result;
  });
  return {
    content: sanitized[0] as string,
    title: sanitized[1] as string,
    masked,
    dropped: masked > DROP_THRESHOLD,
  };
}
