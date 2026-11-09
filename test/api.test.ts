/** 质量点:①鉴权与 UA 头、URL/query 编码 ②瞬时错误退避重试 ③未配 key 直接报可行动错误。 */
import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, ExoMindClient, USER_AGENT } from "../src/api.js";

function res(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

test("请求带 Bearer 与显式 UA,query 正确编码", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const client = new ExoMindClient("https://api.example.com/", "k-1", async (url, init) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string> });
    return res(200, { ok: true });
  });
  await client.get("/search", {
    query: { q: "知识 飞轮", limit: 10, hybrid: true, rerank: undefined },
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.example.com/search?q=%E7%9F%A5%E8%AF%86+%E9%A3%9E%E8%BD%AE&limit=10&hybrid=true",
  );
  assert.equal(calls[0].headers.Authorization, "Bearer k-1");
  assert.match(calls[0].headers["User-Agent"], /^dsh-exomind\/\d+\.\d+\.\d+$/);
  assert.equal(calls[0].headers["User-Agent"], USER_AGENT);
});

test("503 瞬时错误退避后成功,非瞬时的 401 不重试", async () => {
  let n = 0;
  const transient = new ExoMindClient("https://api.example.com", "k-1", async () => {
    n++;
    return n === 1 ? res(503, { detail: "bad gateway" }) : res(200, { ok: true });
  });
  assert.deepEqual(await transient.get("/stats"), { ok: true });
  assert.equal(n, 2);

  let m = 0;
  const auth = new ExoMindClient("https://api.example.com", "k-1", async () => {
    m++;
    return res(401, { detail: "invalid key" });
  });
  await assert.rejects(
    auth.get("/stats"),
    (e: unknown) => e instanceof ApiError && e.status === 401,
  );
  assert.equal(m, 1);
});

test("未配置 apiKey 时不发请求,抛出带登录指引的 401", async () => {
  let called = 0;
  const client = new ExoMindClient("https://api.example.com", "", async () => {
    called++;
    return res(200, {});
  });
  await assert.rejects(
    client.get("/search", { query: { q: "x" } }),
    (e: unknown) => e instanceof ApiError && e.status === 401 && e.detail.includes("exomind login"),
  );
  assert.equal(called, 0);
});
