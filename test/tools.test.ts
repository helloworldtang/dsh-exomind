/** 质量点:①search 结果渲染含标题/召回路 ②entity 404 给可行动提示而非报错
 *  ③401 凭据错误翻译成带指引的 isError ④query 引用页随答案返回。 */
import assert from "node:assert/strict";
import test from "node:test";

import { registerExomindTools } from "../src/tools.js";

interface ToolDef {
  name: string;
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>;
}

function fakeCtx(): { ctx: unknown; tools: ToolDef[] } {
  const tools: ToolDef[] = [];
  function register(tool: ToolDef): () => void {
    tools.push(tool);
    return () => undefined;
  }
  return { ctx: { tools: { register } }, tools };
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

test("注册三个工具;search 渲染标题与召回路", async () => {
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
  assert.equal(tools.length, 3);
  const result = await toolByName(tools, "exomind_search").execute({ query: "dsh" }, exec);
  assert.match(result.text as string, /找到 1 条结果/);
  assert.match(result.text as string, /DSH 接入 spike/);
  assert.match(result.text as string, /召回路: bm25\+vector/);
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
