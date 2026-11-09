/** 只读工具面:exomind_search / exomind_entity / exomind_query。
 *  注册形状对齐 MemOS DSH adapter(ctx.tools.register + defineTool),
 *  输出统一走 {text} 契约,供 DSH 渲染为工具结果。 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

import { ApiError, ExoMindClient } from "./api.js";
import { resolveTarget, type ResolveEnv } from "./config.js";

export interface ToolOptions {
  baseUrl?: string;
  apiKey?: string;
  searchTimeoutMs?: number;
  queryTimeoutMs?: number;
  maxResultChars?: number;
  /** 测试注入:环境/主目录。 */
  resolveEnv?: ResolveEnv;
  /** 测试注入:fetch 实现。 */
  fetchImpl?: typeof fetch;
}

const JSON_OUTPUT = {
  schema: {
    type: "object" as const,
    additionalProperties: true,
    properties: {
      text: { type: "string" as const, required: true },
    },
  },
  render: (_args: unknown, value: Record<string, unknown>) => [
    {
      type: "text" as const,
      text: typeof value["text"] === "string" ? value["text"] : JSON.stringify(value),
    },
  ],
} as const;

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`参数 ${field} 必须是非空字符串`);
  }
  return value.trim();
}

function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…(截断)`;
}

/** 把 API 错误翻译成模型可读、可行动的失败信息(throw → DSH 标记 isError)。 */
function toToolError(e: unknown, what: string): Error {
  if (e instanceof ApiError && e.status === 401) {
    return new Error(
      `ExoMind 未登录或凭据无效(调用 ${what} 时):运行 \`exomind login\` 写入 ~/.exomind/config.json 后重试。`,
      { cause: e },
    );
  }
  return new Error(`ExoMind ${what} 失败: ${e instanceof Error ? e.message : String(e)}`, {
    cause: e,
  });
}

interface SearchHit {
  title?: string;
  path?: string;
  content?: string;
  snippet?: string;
  score?: number;
  legs?: string[];
}

function formatSearchResult(result: unknown, maxChars: number): { text: string; count: number } {
  const hits = (result as { results?: SearchHit[] })?.results ?? [];
  if (!hits.length) return { text: "未找到匹配结果。可尝试 exomind_query 做深度问答。", count: 0 };
  const lines: string[] = [`找到 ${hits.length} 条结果:`];
  let used = 0;
  hits.forEach((hit, i) => {
    const title = hit.title ?? hit.path ?? `(未命名 #${i + 1})`;
    let line = `\n${i + 1}. ${title}`;
    if (hit.path && hit.path !== title) line += `\n   ${hit.path}`;
    const snippet = hit.snippet ?? hit.content;
    if (snippet) line += `\n   ${String(snippet).slice(0, 200)}`;
    if (hit.score != null) line += `\n   score: ${hit.score}`;
    if (Array.isArray(hit.legs) && hit.legs.length) line += `\n   召回路: ${hit.legs.join("+")}`;
    if (used + line.length > maxChars) {
      lines.push(`\n(其余 ${hits.length - i} 条因长度上限省略)`);
      return;
    }
    used += line.length;
    lines.push(line);
  });
  return { text: lines.join(""), count: hits.length };
}

function formatEntityResult(entity: unknown, relations: unknown): string {
  const e = entity as { description?: string; aliases?: string[]; type?: string } | undefined;
  const r = relations as { relations?: unknown[] } | undefined;
  const parts: string[] = [];
  if (e?.description) parts.push(clip(String(e.description), 2000));
  if (Array.isArray(e?.aliases) && e.aliases.length) parts.push(`别名: ${e.aliases.join("、")}`);
  const rels = Array.isArray(r?.relations) ? r.relations : [];
  if (rels.length) {
    const relLines = rels.slice(0, 30).map((rel) => {
      const rr = rel as { name?: string; relation?: string; target?: string };
      return `  - ${rr.name ?? rr.target ?? "?"} (${rr.relation ?? "related"})`;
    });
    parts.push(`关联实体 (${rels.length}):\n${relLines.join("\n")}`);
  }
  return parts.join("\n\n") || "(实体存在,但暂无描述与关系)";
}

export function registerExomindTools(ctx: Context, options: ToolOptions): () => void {
  const searchTimeoutMs = options.searchTimeoutMs ?? 15_000;
  const queryTimeoutMs = options.queryTimeoutMs ?? 180_000;
  const maxResultChars = options.maxResultChars ?? 6_000;

  /** 每次调用时解析目标:DSH 常驻进程中 `exomind login` 换 key 无需重启。 */
  const client = (): ExoMindClient => {
    const target = resolveTarget(
      { baseUrl: options.baseUrl, apiKey: options.apiKey },
      options.resolveEnv,
    );
    return new ExoMindClient(target.baseUrl, target.apiKey, options.fetchImpl);
  };

  const disposers: Array<() => void> = [];
  try {
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: "exomind_search",
          description:
            "在 ExoMind 知识飞轮中做全文/语义检索(秒级)。找实体、经验、踩坑记录时先用它。" +
            "需要跨概念综合或深问题的 LLM 问答时改用 exomind_query。",
          parameters: {
            query: {
              type: "string",
              required: true,
              description: "检索关键词(支持中英文)。",
            },
            limit: { type: "integer", description: "返回条数上限(1-50,默认 10)。" },
            hybrid: {
              type: "boolean",
              description: "启用向量语义混合检索:字面搜不到或需同义/跨语言匹配时。",
            },
            rerank: { type: "boolean", description: "LLM 精排(更准但更慢)。" },
          },
          output: JSON_OUTPUT,
          isConcurrencySafe: () => true,
          async execute(args, exec) {
            const query = requireText(args.query, "query");
            try {
              const result = await client().get("/search", {
                query: {
                  q: query,
                  limit:
                    typeof args.limit === "number" ? Math.min(Math.max(args.limit, 1), 50) : 10,
                  hybrid: args.hybrid === true,
                  rerank: args.rerank === true,
                },
                timeoutMs: searchTimeoutMs,
                signal: exec.signal,
              });
              const formatted = formatSearchResult(result, maxResultChars);
              return { text: formatted.text, count: formatted.count, query };
            } catch (e) {
              throw toToolError(e, "search");
            }
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: "exomind_entity",
          description:
            "查看 ExoMind 知识飞轮中一个实体的详情与关联关系(定义、别名、关联实体)。" +
            "实体名可从 exomind_search 结果的标题中获得。",
          parameters: {
            name: { type: "string", required: true, description: "实体名称。" },
            relations: {
              type: "boolean",
              description: "是否附带关联实体列表(默认 true)。",
            },
            depth: { type: "integer", description: "关系展开深度(1-3,默认 1)。" },
          },
          output: JSON_OUTPUT,
          isConcurrencySafe: () => true,
          async execute(args, exec) {
            const name = requireText(args.name, "name");
            try {
              const c = client();
              const entity = await c.get(`/entities/${encodeURIComponent(name)}`, {
                timeoutMs: searchTimeoutMs,
                signal: exec.signal,
              });
              let relations: unknown = null;
              if (args.relations !== false) {
                relations = await c.get(`/relations/${encodeURIComponent(name)}`, {
                  query: {
                    depth:
                      typeof args.depth === "number" ? Math.min(Math.max(args.depth, 1), 3) : 1,
                  },
                  timeoutMs: searchTimeoutMs,
                  signal: exec.signal,
                });
              }
              return { text: clip(formatEntityResult(entity, relations), maxResultChars), name };
            } catch (e) {
              if (e instanceof ApiError && e.status === 404) {
                return {
                  text: `未找到实体「${name}」。可先用 exomind_search 定位准确名称。`,
                  name,
                };
              }
              throw toToolError(e, "entity");
            }
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: "exomind_query",
          description:
            "对 ExoMind 知识飞轮做深度 LLM 问答(检索+生成,通常 1-2 分钟,慢)。" +
            "仅用于 exomind_search 无法回答、需要跨多页知识综合的深问题。",
          parameters: {
            question: { type: "string", required: true, description: "完整的问题。" },
            tags: {
              type: "string",
              description: "可选,空格分隔的标签过滤(如 exomind 踩坑记录)。",
            },
          },
          output: JSON_OUTPUT,
          isConcurrencySafe: () => true,
          async execute(args, exec) {
            const question = requireText(args.question, "question");
            const body: { question: string; tags?: string[] } = { question };
            if (typeof args.tags === "string" && args.tags.trim()) {
              body.tags = args.tags.trim().split(/\s+/);
            }
            try {
              const result = (await client().post("/query", {
                body,
                timeoutMs: queryTimeoutMs,
                signal: exec.signal,
              })) as { answer?: string; pages?: string[]; pages_used?: number; model?: string };
              const pages = Array.isArray(result.pages) ? result.pages : [];
              const cited = pages.length
                ? `\n\n引用 ${result.pages_used ?? pages.length} 页:\n${pages
                    .map((p) => `  • ${p}`)
                    .join("\n")}`
                : "";
              return {
                text: clip(result.answer || "(无回答)", maxResultChars) + cited,
                question,
              };
            } catch (e) {
              throw toToolError(e, "query");
            }
          },
        }),
      ),
    );
  } catch (e) {
    for (const dispose of disposers) dispose();
    throw e;
  }

  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
}
