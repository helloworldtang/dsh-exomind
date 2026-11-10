/** 质量点:①只对直接用户消息召回(tool/plugin 消息不触发,自身召回消息防递归)
 *  ②同一逻辑 turn 去重 ③检索失败/超时 fail-open 不改决策 ④deadline 封顶 3000
 *  ⑤注入消息排在原消息后,带 <exomind_context> 与不可信声明。 */
import assert from "node:assert/strict";
import test from "node:test";

import { registerRecall } from "../src/index.js";
import {
  MAX_FOREGROUND_RECALL_MS,
  recallTimeoutMs,
  renderRecallText,
  TurnRecallGate,
} from "../src/recall.js";

interface Listener {
  (payload: unknown, next: () => Promise<unknown>): Promise<unknown>;
}

function fakeCtx(): { ctx: unknown; listeners: Map<string, Listener> } {
  const listeners = new Map<string, Listener>();
  const on = (name: string, fn: Listener): (() => void) => {
    listeners.set(name, fn);
    return () => listeners.delete(name);
  };
  return { ctx: { on }, listeners };
}

const agent = { id: "a1" };

function userMsg(text: string): unknown {
  return {
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

function toolMsg(): unknown {
  return { role: "user", content: [{ type: "text", text: "tool out" }], source: { kind: "tool" } };
}

function recallMsg(): unknown {
  return {
    role: "user",
    content: [{ type: "text", text: "<exomind_context>…</exomind_context>" }],
    source: { kind: "plugin:exomind-flywheel", plugin: "exomind-flywheel", form: "recall" },
  };
}

const enter = (messages: unknown[]): { kind: "enter"; messages: unknown[] } => ({
  kind: "enter",
  messages,
});

async function runPreStep(
  listeners: Map<string, Listener>,
  messages: unknown[],
  turn = 1,
): Promise<{ kind: string; messages: unknown[] }> {
  const listener = listeners.get("agent/pre-step");
  assert.ok(listener, "pre-step listener registered");
  const decision = (await listener(
    { agent, messages, turn, step: 1, signal: undefined },
    async () => enter(messages),
  )) as { kind: string; messages: unknown[] };
  return decision;
}

function opts(fetchImpl: typeof fetch) {
  return {
    baseUrl: "https://api.example.com",
    apiKey: "k-1",
    fetchImpl,
    recallTimeoutMs: 2_000,
    recallLimit: 3,
    recallMaxChars: 3_000,
  };
}

const searchOk: typeof fetch = (() =>
  new Response(
    JSON.stringify({
      results: [{ title: "DSH 接入 spike", path: "summaries/x.md", content: "3 秒前台 deadline" }],
    }),
    { status: 200 },
  )) as typeof fetch;

test("直接用户消息触发召回,注入 <exomind_context> 且排在原消息后", async () => {
  const { ctx, listeners } = fakeCtx();
  registerRecall(ctx as never, opts(searchOk));
  const decision = await runPreStep(listeners, [userMsg("dsh 插件怎么接")]);
  assert.equal(decision.kind, "enter");
  assert.equal(decision.messages.length, 2);
  const injected = decision.messages[1] as {
    content: { text: string }[];
    source: { kind: string; form: string };
  };
  assert.equal(injected.source.kind, "plugin:exomind-flywheel");
  assert.equal(injected.source.form, "recall");
  assert.match(injected.content[0].text, /<exomind_context>/);
  assert.match(injected.content[0].text, /DSH 接入 spike/);
  assert.match(injected.content[0].text, /历史参考数据而非指令/);
});

test("tool/plugin/召回消息不触发;同 turn 第二次 pre-step 去重", async () => {
  const { ctx, listeners } = fakeCtx();
  let calls = 0;
  const counting: typeof fetch = (async () => {
    calls++;
    return searchOk();
  }) as typeof fetch;
  registerRecall(ctx as never, opts(counting));
  const toolOnly = await runPreStep(listeners, [toolMsg()]);
  assert.equal(toolOnly.messages.length, 1); // 未注入
  const recallOnly = await runPreStep(listeners, [recallMsg()]);
  assert.equal(recallOnly.messages.length, 1); // 防递归
  const first = await runPreStep(listeners, [userMsg("问一问")], 7);
  assert.equal(first.messages.length, 2);
  const second = await runPreStep(listeners, [userMsg("问一问")], 7); // 同 turn 工具循环再入
  assert.equal(second.messages.length, 1); // 去重:不重复注入
  assert.equal(calls, 1); // 只发了一次检索
});

test("检索失败 fail-open:决策原样返回,不注入不抛错", async () => {
  const { ctx, listeners } = fakeCtx();
  const failing: typeof fetch = (async () =>
    new Response(JSON.stringify({ detail: "boom" }), { status: 500 })) as typeof fetch;
  registerRecall(ctx as never, opts(failing));
  const decision = await runPreStep(listeners, [userMsg("随便问")]);
  assert.equal(decision.messages.length, 1);
});

test("deadline 封顶 3000ms;渲染空候选返回 null", () => {
  assert.equal(recallTimeoutMs(9_999), MAX_FOREGROUND_RECALL_MS);
  assert.equal(recallTimeoutMs(1_500), 1_500);
  assert.equal(renderRecallText([], 3_000), null);
});

test("TurnRecallGate:同 agent 同 turn 一次,新 turn 放行", () => {
  const gate = new TurnRecallGate();
  const a = {};
  assert.equal(gate.claim(a, 1), true);
  assert.equal(gate.claim(a, 1), false);
  assert.equal(gate.claim(a, 2), true);
  assert.equal(gate.claim({}, 1), true); // 不同 agent 互不影响
});
