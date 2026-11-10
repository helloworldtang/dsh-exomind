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

test("session/disposed 触发 /ingest/async 提交;drain 等待完成;提交失败被吞", async () => {
  const bodies: unknown[] = [];
  const okFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify({ job_id: "job-1" }), { status: 200 });
  }) as typeof fetch;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const on = (name: string, fn: (...args: unknown[]) => void): (() => void) => {
    listeners.set(name, fn);
    return () => listeners.delete(name);
  };
  const drain = registerCapture({ on } as never, {
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
  assert.equal(bodies.length, 1);
  const body = bodies[0] as { content: string; title: string; tags: string[]; client_key: string };
  assert.match(body.client_key, /^dsh-[0-9a-f]{44}$/);
  assert.deepEqual(body.tags, ["dsh", "会话存档"]);
  assert.match(body.title, /^DSH 会话:/);

  // 失败路径:断网/500 → 提交被吞,drain 正常返回
  const failFetch = (async () =>
    new Response(JSON.stringify({ detail: "down" }), { status: 500 })) as typeof fetch;
  const drain2 = registerCapture({ on } as never, {
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
  const bodies: unknown[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(init?.body);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const on = (name: string, fn: (...args: unknown[]) => void): (() => void) => {
    listeners.set(name, fn);
    return () => listeners.delete(name);
  };
  registerCapture({ on } as never, {
    ...CAPTURE_OPTS,
    baseUrl: "https://api.example.com",
    apiKey: "k-1",
    fetchImpl,
  });
  const session = {};
  listeners.get("session/event")?.(session, userEvent("hi"));
  listeners.get("session/event")?.(session, assistantEvent("ok"));
  listeners.get("session/disposed")?.(session);
  assert.equal(bodies.length, 0);
});
