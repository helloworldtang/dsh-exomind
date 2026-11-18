/** 质量点:①只对直接用户消息召回(tool/plugin 消息不触发,自身召回消息防递归)
 *  ②同一逻辑 turn 去重 ③检索失败/超时 fail-open 不改决策 ④deadline 封顶 3000
 *  ⑤注入消息排在原消息后,带 <exomind_context> 与不可信声明
 *  ⑥查询构造:当下意图优先(尾部填充/超窗取尾/回溯上限/空消息过滤)
 *  ⑦每次召回一行结构化埋点,成功与失败都留痕。 */
import assert from "node:assert/strict";
import test from "node:test";

import { registerRecall } from "../src/index.js";
import {
  buildRecallQuery,
  MAX_BACKFILL_MESSAGES,
  MAX_FOREGROUND_RECALL_MS,
  MAX_QUERY_CHARS,
  recallTimeoutMs,
  renderRecallText,
  TurnRecallGate,
} from "../src/recall.js";

interface Listener {
  (payload: unknown, next: () => Promise<unknown>): Promise<unknown>;
}

interface LogEntry {
  level: string;
  text: string;
}

function fakeCtx(): { ctx: unknown; listeners: Map<string, Listener>; logs: LogEntry[] } {
  const listeners = new Map<string, Listener>();
  const logs: LogEntry[] = [];
  const on = (name: string, fn: Listener): (() => void) => {
    listeners.set(name, fn);
    return () => listeners.delete(name);
  };
  const logger = (): { info: (t: string) => void; warn: (t: string) => void } => ({
    info: (text) => logs.push({ level: "info", text }),
    warn: (text) => logs.push({ level: "warn", text }),
  });
  return { ctx: { on, logger }, listeners, logs };
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

test("查询构造:当下意图优先,长会话从末条回填,开场白被窗口挤出", () => {
  const { query, usedMessages } = buildRecallQuery([
    userMsg("开场白背景描述,项目历史与无关细节。".repeat(10)) as never, // 180 字,装不下
    userMsg("中间轮次的过渡问题,继续铺垫") as never,
    userMsg("现在真正想问的:召回查询怎么构造") as never,
  ]);
  assert.match(query, /现在真正想问的/);
  assert.match(query, /中间轮次的过渡问题/); // 装得下的近距离历史保留
  assert.doesNotMatch(query, /开场白背景/);
  assert.ok(query.length <= MAX_QUERY_CHARS);
  assert.equal(usedMessages, 2); // 末条完整 + 装得下的一条历史
});

test("查询构造:单条超窗取尾部(意图完整落在查询末尾)", () => {
  const head = "先铺垫背景".repeat(45); // 225 字,超窗
  const tail = "最后才是真正的问题";
  const { query, usedMessages } = buildRecallQuery([userMsg(`${head}${tail}`) as never]);
  assert.equal(query.length, MAX_QUERY_CHARS);
  assert.ok(query.endsWith(tail), "意图(句尾)完整保留在查询末尾");
  assert.doesNotMatch(query.slice(0, 5), /先铺垫背景/, "铺垫头部被截掉一段");
  assert.equal(usedMessages, 1);
});

test("查询构造:回溯上限挡短消息连发;历史整条装不下即停", () => {
  const messages = Array.from({ length: 30 }, (_, i) => userMsg(`第${i}条短消息`));
  const { query, usedMessages } = buildRecallQuery(messages as never[]);
  assert.equal(usedMessages, MAX_BACKFILL_MESSAGES);
  assert.match(query, /第29条短消息/); // 最新在内
  assert.doesNotMatch(query, /第0条短消息|第10条短消息/); // 上限之外的不回填
  // 历史装不下整条:末条占满大半窗口后,再往前只在装得下时继续
  const oneLong = buildRecallQuery([userMsg("好"), userMsg("继续"), userMsg("短问题") as never]);
  assert.equal(oneLong.usedMessages, 3); // 全装得下
});

test("查询构造:空文本块与全空白消息不产生内容", () => {
  const messages = [
    { content: [{ type: "text", text: "   " }], source: { kind: "user" } },
    {
      content: [
        { type: "text", text: "正经提问" },
        { type: "text", text: "" },
      ],
      source: { kind: "user" },
    },
  ];
  const { query, usedMessages } = buildRecallQuery(messages as never[]);
  assert.equal(query, "正经提问");
  assert.equal(usedMessages, 1);
});

test("埋点:成功召回打一行 info(warn) 结构化日志,字段齐全", async () => {
  const { ctx, listeners, logs } = fakeCtx();
  registerRecall(ctx as never, opts(searchOk));
  await runPreStep(listeners, [userMsg("问一个正经问题")]);
  const info = logs.find((l) => l.level === "info");
  assert.ok(info, "成功路径有 info 埋点");
  const parsed = JSON.parse(info!.text) as Record<string, unknown>;
  for (const key of ["turn", "qChars", "msgs", "hits", "ms", "injected"]) assert.ok(key in parsed);
  assert.equal(parsed.injected, true);
  const { ctx: ctx2, listeners: l2, logs: logs2 } = fakeCtx();
  const failing: typeof fetch = (async () =>
    new Response(JSON.stringify({ detail: "boom" }), { status: 500 })) as typeof fetch;
  registerRecall(ctx2 as never, opts(failing));
  await runPreStep(l2, [userMsg("再问一个问题")]);
  const warn = logs2.find((l) => l.level === "warn");
  assert.ok(warn, "失败路径有 warn 埋点");
  const parsed2 = JSON.parse(warn!.text) as Record<string, unknown>;
  assert.equal(parsed2.injected, false);
  assert.ok(typeof parsed2.err === "string" && parsed2.err);
});
