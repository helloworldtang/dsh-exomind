/** 质量点:①search 结果渲染含标题/召回路 ②entity 404 给可行动提示而非报错
 *  ③401 凭据错误翻译成带指引的 isError ④query 引用页随答案返回
 *  ⑤suggest 渲染选题/理由/相关实体,count 钳制
 *  ⑥ingest:body 带 origin/client_key/标签族;密钥打码后提交;密钥清单拒绝并给可行动错误;短内容拒绝。 */
import assert from "node:assert/strict";
import test from "node:test";

import { registerExomindTools } from "../src/tools.js";

interface ToolDef {
  name: string;
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>;
}

function fakeCtx(): { ctx: unknown; tools: ToolDef[]; logs: string[] } {
  const tools: ToolDef[] = [];
  const logs: string[] = [];
  function register(tool: ToolDef): () => void {
    tools.push(tool);
    return () => undefined;
  }
  const logger = (): { info: (t: string) => void; warn: (t: string) => void } => ({
    info: (text) => logs.push(text),
    warn: (text) => logs.push(text),
  });
  return { ctx: { tools: { register }, logger }, tools, logs };
}

const exec = { signal: undefined };

function fetchJson(handler: (url: string) => { status: number; body: unknown }): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const { status, body } = handler(String(input));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

function opts(fetchImpl: typeof fetch) {
  return { baseUrl: "https://api.example.com", apiKey: "k-1", fetchImpl };
}

function toolByName(tools: ToolDef[], name: string): ToolDef {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} registered`);
  return tool;
}

test("注册五个工具;search 渲染标题与召回路", async () => {
  const { ctx, tools } = fakeCtx();
  registerExomindTools(
    ctx as never,
    opts(
      fetchJson(() => ({
        status: 200,
        body: {
          results: [
            {
              title: "DSH 接入 spike",
              path: "summaries/x.md",
              content: "3 秒前台 deadline",
              score: 8.1,
              legs: ["bm25", "vector"],
            },
          ],
        },
      })),
    ),
  );
  assert.equal(tools.length, 5);
  const result = await toolByName(tools, "exomind_search").execute({ query: "dsh" }, exec);
  assert.match(result.text as string, /找到 1 条结果/);
  assert.match(result.text as string, /DSH 接入 spike/);
  assert.match(result.text as string, /召回路: bm25\+vector/);
});

test("suggest 返回选题建议,渲染主题/理由/相关实体;count 超界钳制", async () => {
  const urls: string[] = [];
  const { ctx, tools } = fakeCtx();
  registerExomindTools(
    ctx as never,
    opts(
      fetchJson((url) => {
        urls.push(url);
        return {
          status: 200,
          body: {
            topics: [
              {
                topic: "ExoMind 电台分发",
                reason: "电台节点密集但缺分发侧沉淀",
                related: ["记忆电台", "分发链路"],
              },
            ],
            count: 1,
          },
        };
      }),
    ),
  );
  const result = await toolByName(tools, "exomind_suggest").execute({ count: 99 }, exec);
  assert.match(result.text as string, /ExoMind 电台分发/);
  assert.match(result.text as string, /电台节点密集但缺分发侧沉淀/);
  assert.match(result.text as string, /记忆电台、分发链路/);
  assert.ok(urls[0]!.includes("count=10"), `count 钳制到上限: ${urls[0]}`);
});

test("entity 404 返回提示文本;401 抛出带 exomind login 指引的错误", async () => {
  const { ctx, tools } = fakeCtx();
  registerExomindTools(ctx as never, {
    ...opts(
      fetchJson((url) =>
        url.includes("/entities/")
          ? { status: 200, body: { description: "知识飞轮本体", aliases: ["ExoMind"] } }
          : url.includes("/relations/")
            ? { status: 200, body: { relations: [{ name: "复习", relation: "uses" }] } }
            : { status: 404, body: { detail: "not found" } },
      ),
    ),
  });
  const entity = await toolByName(tools, "exomind_entity").execute({ name: "ExoMind" }, exec);
  assert.match(entity.text as string, /知识飞轮本体/);
  assert.match(entity.text as string, /复习/);

  const { ctx: ctx2, tools: tools2 } = fakeCtx();
  registerExomindTools(ctx2 as never, {
    baseUrl: "https://api.example.com",
    apiKey: "k-bad",
    fetchImpl: fetchJson(() => ({ status: 401, body: { detail: "invalid" } })),
  });
  await assert.rejects(
    toolByName(tools2, "exomind_search").execute({ query: "x" }, exec),
    (e: unknown) => e instanceof Error && e.message.includes("exomind login"),
  );
});

test("query 返回答案与引用页", async () => {
  const { ctx, tools } = fakeCtx();
  registerExomindTools(
    ctx as never,
    opts(
      fetchJson(() => ({
        status: 200,
        body: { answer: "答:3 秒。", pages: ["summaries/spike.md"], pages_used: 1, model: "m" },
      })),
    ),
  );
  const result = await toolByName(tools, "exomind_query").execute(
    { question: "DSH 前台上限?" },
    exec,
  );
  assert.match(result.text as string, /答:3 秒。/);
  assert.match(result.text as string, /• summaries\/spike\.md/);
});

const INGEST_CONTENT =
  "背景:DSH 前台召回有 3 秒硬上限不可配置。结论:自动召回只走 BM25(实测 0.3s)," +
  "hybrid(1.2s)与 LLM query 绝不进前台;依据是 10 倍余量原则。";

test("ingest 提交异步摄入:body 带 origin/client_key/标签族,返回进度提示", async () => {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const { ctx, tools } = fakeCtx();
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    posts.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ job_id: "job-9", status: "pending" }), { status: 200 });
  }) as typeof fetch;
  registerExomindTools(ctx as never, opts(fetchImpl));
  const result = await toolByName(tools, "exomind_ingest").execute(
    { content: INGEST_CONTENT, title: "DSH 前台召回预算", tags: "dsh 性能" },
    exec,
  );
  assert.match(result.text as string, /已提交知识飞轮/);
  assert.match(result.text as string, /job_id=job-9/);
  const body = posts[0]!.body as {
    content: string;
    title: string;
    tags: string[];
    origin: string;
    client_key: string;
  };
  assert.equal(body.origin, "dsh-plugin");
  assert.deepEqual(body.tags, ["dsh", "性能", "dsh", "agent存档"]); // 用户标签在前,标签族在后
  assert.match(body.client_key, /^dsh-[0-9a-f]{44}$/);
  assert.equal(body.title, "DSH 前台召回预算");
});

test("ingest 脱敏:零星密钥打码后照常提交;密钥清单拒绝且错误可行动", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ job_id: "job-10" }), { status: 200 });
  }) as typeof fetch;
  const { ctx, tools } = fakeCtx();
  registerExomindTools(ctx as never, opts(fetchImpl));
  const secret = await toolByName(tools, "exomind_ingest").execute(
    {
      content:
        "排查 401 的经验:先看 token 是否过期,例如 sk-abcdef0123456789abcdef0123456789 形态的 key," +
        "再查 JWKS 缓存;根因通常是时钟漂移导致签名校验失败,修法是同步 NTP 后重启服务。",
      title: "OIDC 401 排查",
    },
    exec,
  );
  assert.match(secret.text as string, /已提交/);
  assert.match(String(posts[0]!.content), /sk-a\*\*\*REDACTED\*\*\*/); // 打码后才出站

  const trove = await toolByName(tools, "exomind_ingest")
    .execute(
      {
        content:
          "密钥清单备份:" +
          Array.from({ length: 12 }, (_, i) => `sk-key${i}0123456789abcdef0123456789`).join("\n") +
          "以上是全部,记录完毕,内容凑够五十字以通过长度门槛。",
      },
      exec,
    )
    .then(
      () => null,
      (e: Error) => e,
    );
  assert.ok(trove instanceof Error && /密钥/.test(trove.message), "密钥清单拒绝且说明原因");
  assert.equal(posts.length, 1, "拒绝路径不发起上传");
});

test("ingest 质量门:过短/超长内容拒绝,不发起上传", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = (async () => {
    calls++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const { ctx, tools } = fakeCtx();
  registerExomindTools(ctx as never, opts(fetchImpl));
  const short = await toolByName(tools, "exomind_ingest")
    .execute({ content: "太短" }, exec)
    .then(
      () => null,
      (e: Error) => e,
    );
  assert.ok(short instanceof Error && /50 字/.test(short.message));
  assert.equal(calls, 0);
});
