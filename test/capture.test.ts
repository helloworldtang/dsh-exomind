/** 质量点:①积累过滤(插件召回不算用户消息,中断流不进存档)
 *  ②质量门槛(寒暄/空转不入飞轮) ③client_key 幂等格式与稳定性
 *  ④session/disposed 触发秒回提交,body 形状正确,失败吞掉
 *  ⑤drain 有界等待在途提交完成。 */
import assert from "node:assert/strict";
import test from "node:test";

import { CaptureBuffer, deriveClientKey, registerCapture } from "../src/capture.js";

function userEvent(text: string, kind = "user"): { type: string; data: unknown } {
  return {
    type: "user/message",
    data: { content: [{ type: "text", text }], source: { kind } },
  };
}

function assistantEvent(text: string, interrupted = false): { type: string; data: unknown } {
  return {
    type: "assistant/message",
    data: {
      message: { content: [{ type: "text", text }], interrupted },
    },
  };
}

const LONG_ANSWER =
  "这是一段足够长的助手结论,超过一百个字符的门槛,用来验证质量门槛的判断逻辑。" +
  "Cordis 4 的清理契约是 apply() 返回 disposer,没有 dispose 事件,这点和旧版 cordis 不同。".repeat(
    2,
  );

const GATE = { minUserChars: 8, minAssistantChars: 100, maxChars: 8_000 };
const CAPTURE_OPTS = {
  captureEnabled: true,
  captureMinUserChars: 8,
  captureMinAssistantChars: 100,
  captureMaxChars: 8_000,
};

interface CapLogEntry {
  level: string;
  text: string;
}

function makeCaptureCtx(): {
  ctx: unknown;
  listeners: Map<string, (...args: unknown[]) => void>;
  logs: CapLogEntry[];
} {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const logs: CapLogEntry[] = [];
  const on = (name: string, fn: (...args: unknown[]) => void): (() => void) => {
    listeners.set(name, fn);
    return () => listeners.delete(name);
  };
  const logger = (): { info: (t: string) => void; warn: (t: string) => void } => ({
    info: (text) => logs.push({ level: "info", text }),
    warn: (text) => logs.push({ level: "warn", text }),
  });
  return { ctx: { on, logger }, listeners, logs };
}

test("积累过滤:插件召回消息不算用户输入;中断流不进存档", () => {
  const buffer = new CaptureBuffer();
  buffer.onEvent(
    userEvent("<exomind_context>召回内容</exomind_context>", "plugin:exomind-flywheel"),
  );
  buffer.onEvent(userEvent("tool output", "tool"));
  buffer.onEvent(userEvent("正经的用户提问,超过八个字"));
  buffer.onEvent(assistantEvent("半截输出", true));
  buffer.onEvent(assistantEvent(LONG_ANSWER));
  const digest = buffer.buildDigest(GATE);
  assert.ok(digest);
  assert.match(digest.content, /正经的用户提问/);
  assert.doesNotMatch(digest.content, /召回内容|tool output|半截输出/);
  assert.match(digest.content, /任务:正经的用户提问/);
  assert.match(digest.title, /^DSH 会话:/);
});

test("质量门槛:用户消息太短或助手结论太短都不存", () => {
  const short = new CaptureBuffer();
  short.onEvent(userEvent("hi"));
  short.onEvent(assistantEvent(LONG_ANSWER));
  assert.equal(short.buildDigest(GATE), null);
  const thin = new CaptureBuffer();
  thin.onEvent(userEvent("这是一个正经的问题"));
  thin.onEvent(assistantEvent("太短"));
  assert.equal(thin.buildDigest(GATE), null);
});

test("client_key:dsh- 前缀 48 位,同内容稳定,异内容不同", () => {
  const key = deriveClientKey("内容甲");
  assert.match(key, /^dsh-[0-9a-f]{44}$/);
  assert.equal(key, deriveClientKey("内容甲"));
  assert.notEqual(key, deriveClientKey("内容乙"));
});

/** 按 URL 记录请求,POST 只解析 body —— dispose 现在会并行发 /suggest-topics GET,
 *  计数必须按端点区分,不能再数总 fetch 次数。 */
function makeRecordingFetch(
  bodies: Array<{ url: string; body: unknown }>,
  responder?: (url: string) => unknown,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    bodies.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const payload = responder?.(url) ?? {};
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
}

test("session/disposed 触发 /ingest/async 提交;drain 等待完成;提交失败被吞", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const okFetch = makeRecordingFetch(calls, (url) =>
    url.includes("/ingest/async") ? { job_id: "job-1" } : { topics: [] },
  );
  const { ctx, listeners } = makeCaptureCtx();
  const drain = registerCapture(ctx as never, {
    ...CAPTURE_OPTS,
    baseUrl: "https://api.example.com",
    apiKey: "k-1",
    fetchImpl: okFetch,
  });
  const session = {};
  listeners.get("session/event")?.(session, userEvent("这个会话值得被沉淀下来吗"));
  listeners.get("session/event")?.(session, assistantEvent(LONG_ANSWER));
  listeners.get("session/disposed")?.(session);
  await drain();
  const posts = calls.filter((c) => c.url.includes("/ingest/async"));
  assert.equal(posts.length, 1);
  const body = posts[0]!.body as {
    content: string;
    title: string;
    tags: string[];
    origin: string;
    client_key: string;
  };
  assert.match(body.client_key, /^dsh-[0-9a-f]{44}$/);
  assert.deepEqual(body.tags, ["dsh", "会话存档"]);
  assert.equal(body.origin, "dsh-plugin"); // 复活率回查的过滤键
  assert.match(body.title, /^DSH 会话:/);

  // 失败路径:断网/500 → 提交被吞,drain 正常返回
  const failFetch = (async () =>
    new Response(JSON.stringify({ detail: "down" }), { status: 500 })) as typeof fetch;
  const drain2 = registerCapture(ctx as never, {
    ...CAPTURE_OPTS,
    baseUrl: "https://api.example.com",
    apiKey: "k-1",
    fetchImpl: failFetch,
  });
  const s2 = {};
  listeners.get("session/event")?.(s2, userEvent("另一个正经的会话问题"));
  listeners.get("session/event")?.(s2, assistantEvent(LONG_ANSWER));
  listeners.get("session/disposed")?.(s2);
  await assert.doesNotReject(drain2());
});

test("质量门槛外的会话不触发提交", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = makeRecordingFetch(calls);
  const { ctx, listeners } = makeCaptureCtx();
  registerCapture(ctx as never, {
    ...CAPTURE_OPTS,
    baseUrl: "https://api.example.com",
    apiKey: "k-1",
    fetchImpl,
  });
  const session = {};
  listeners.get("session/event")?.(session, userEvent("hi"));
  listeners.get("session/event")?.(session, assistantEvent("ok"));
  listeners.get("session/disposed")?.(session);
  assert.equal(calls.filter((c) => c.url.includes("/ingest/async")).length, 0);
});

test("dispose 顺带取一条选题建议,与知情提示同通道输出;失败静默", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = makeRecordingFetch(calls, (url) =>
    url.includes("/suggest-topics")
      ? { topics: [{ topic: "ExoMind 电台分发", reason: "图谱中电台节点密集但缺分发侧" }] }
      : {},
  );
  const { ctx, listeners, logs } = makeCaptureCtx();
  const drain = registerCapture(ctx as never, {
    ...CAPTURE_OPTS,
    baseUrl: "https://api.example.com",
    apiKey: "k-1",
    fetchImpl,
  });
  const session = {};
  listeners.get("session/event")?.(session, userEvent("聊聊选题建议的输出位置"));
  listeners.get("session/event")?.(session, assistantEvent(LONG_ANSWER));
  listeners.get("session/disposed")?.(session);
  await drain();
  assert.ok(
    calls.some((c) => c.url.includes("/suggest-topics")),
    "建议请求已发起",
  );
  const line = logs.find((l) => l.level === "info" && l.text.includes("建议下一步深挖"));
  assert.ok(line && line.text.includes("ExoMind 电台分发"), "建议一行含主题");
});

test("缓冲有界:超长会话条数封顶(保首条+最近),单条截断,digest 仍可构建", () => {
  const buffer = new CaptureBuffer();
  buffer.onEvent(userEvent("最初的任务描述,超过八个字"));
  for (let i = 0; i < 300; i++) buffer.onEvent(userEvent(`后续第 ${i} 条用户消息,足够长`));
  buffer.onEvent(assistantEvent("x".repeat(50_000)));
  assert.equal(buffer.userTexts.length, 100);
  assert.equal(buffer.userTexts[0], "最初的任务描述,超过八个字"); // 首条=任务标题来源,不丢
  assert.ok(buffer.assistantTexts[0]!.length <= 8_000); // 单条截断,防长粘贴撑内存
  const digest = buffer.buildDigest(GATE);
  assert.ok(digest);
  assert.match(digest.content, /任务:最初的任务描述/);
});

test("出站收口脱敏:命中的 secret 打码后才提交,client_key 按打码后内容计算", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = makeRecordingFetch(calls);
  const { ctx, listeners, logs } = makeCaptureCtx();
  const drain = registerCapture(ctx as never, {
    ...CAPTURE_OPTS,
    baseUrl: "https://api.example.com",
    apiKey: "k-1",
    fetchImpl,
  });
  const session = {};
  listeners.get("session/event")?.(
    session,
    userEvent("帮我看下这个 key 为什么 401: sk-abcdef0123456789abcdef0123456789"),
  );
  listeners.get("session/event")?.(session, assistantEvent(LONG_ANSWER));
  listeners.get("session/disposed")?.(session);
  await drain();
  const posts = calls.filter((c) => c.url.includes("/ingest/async"));
  assert.equal(posts.length, 1);
  const body = posts[0]!.body as { content: string; client_key: string };
  assert.match(body.content, /sk-a\*\*\*REDACTED\*\*\*/);
  assert.doesNotMatch(body.content, /0123456789abcdef0123456789/);
  assert.equal(body.client_key, deriveClientKey(body.content));
  const warn = logs.find((l) => l.level === "warn");
  assert.ok(warn && JSON.parse(warn.text).masked >= 1, "打码埋点一行");
});

test("出站收口脱敏:命中超阈值整条放弃,不发起提交", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = makeRecordingFetch(calls);
  const { ctx, listeners, logs } = makeCaptureCtx();
  registerCapture(ctx as never, {
    ...CAPTURE_OPTS,
    baseUrl: "https://api.example.com",
    apiKey: "k-1",
    fetchImpl,
  });
  const session = {};
  listeners.get("session/event")?.(
    session,
    userEvent(
      Array.from({ length: 12 }, (_, i) => `sk-key${i}0123456789abcdef0123456789`).join("\n"),
    ),
  );
  listeners.get("session/event")?.(session, assistantEvent(LONG_ANSWER));
  listeners.get("session/disposed")?.(session);
  assert.equal(calls.filter((c) => c.url.includes("/ingest/async")).length, 0);
  const warn = logs.find((l) => l.level === "warn" && l.text.includes("dropped"));
  assert.ok(warn && JSON.parse(warn.text).dropped === true, "放弃埋点一行");
});
