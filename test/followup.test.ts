/** 质量点:①注入落账(turn/start 后本插件 recall 消息)标记该 turn
 *  ②注入后调 exomind_search/entity/query → followup:"<工具名>",每 turn 一次
 *  ③turn 结束仍无跟进 → followup:"none"(采纳率 = none/(none+tool))
 *  ④exomind_suggest 与无关工具不计入跟进 ⑤无注入的 turn 全程不打。 */
import assert from "node:assert/strict";
import test from "node:test";

import { registerFollowup } from "../src/followup.js";

interface LogEntry {
  level: string;
  text: string;
}

function fakeCtx(): {
  ctx: unknown;
  listeners: Map<string, (...args: unknown[]) => void>;
  logs: LogEntry[];
} {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const logs: LogEntry[] = [];
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

const turnStart = (turn: number) => ({ type: "turn/start", data: { turn } });
const turnEnd = (turn: number) => ({ type: "turn/end", data: { turn } });
const toolCall = (turn: number, name: string) => ({
  type: "tool/call",
  data: { turn, step: 1, callId: "c1", name, arguments: "{}" },
});
const recallMessage = () => ({
  type: "user/message",
  data: {
    content: [{ type: "text", text: "<exomind_context>…</exomind_context>" }],
    source: { kind: "plugin:exomind-flywheel", plugin: "exomind-flywheel", form: "recall" },
  },
});
function followups(logs: LogEntry[]): Array<{ turn: number; followup: string }> {
  return logs
    .filter((l) => l.text.includes("followup"))
    .map((l) => JSON.parse(l.text) as { turn: number; followup: string });
}

test("注入后调检索工具 → followup 记工具名;turn 结束无跟进 → followup none", () => {
  const { ctx, listeners, logs } = fakeCtx();
  registerFollowup(ctx as never);
  const session = {};
  const emit = (event: { type: string; data?: unknown }) =>
    listeners.get("session/event")?.(session, event);

  // turn 1:注入 → 调 exomind_search → 记工具名;后续同 turn 再调只记一次
  emit(turnStart(1));
  emit(recallMessage());
  emit(toolCall(1, "exomind_search"));
  emit(toolCall(1, "exomind_entity"));
  // turn 2:注入 → 无跟进 → turn/end 记 none
  emit(turnStart(2));
  emit(recallMessage());
  emit(turnEnd(2));
  // turn 3:无注入,调工具不打
  emit(turnStart(3));
  emit(toolCall(3, "exomind_search"));
  emit(turnEnd(3));

  assert.deepEqual(followups(logs), [
    { turn: 1, followup: "exomind_search" },
    { turn: 2, followup: "none" },
  ]);
});

test("exomind_suggest 与无关工具不计入跟进;非 recall 的插件消息不标记", () => {
  const { ctx, listeners, logs } = fakeCtx();
  registerFollowup(ctx as never);
  const session = {};
  const emit = (event: { type: string; data?: unknown }) =>
    listeners.get("session/event")?.(session, event);

  emit(turnStart(1));
  emit(recallMessage());
  emit(toolCall(1, "exomind_suggest")); // 选题推荐不是检索行为
  emit(toolCall(1, "bash"));
  emit(turnEnd(1));

  // turn 2:同插件但 form 不是 recall(如未来的其他注入形态)不标记
  emit(turnStart(2));
  emit({
    type: "user/message",
    data: { content: [], source: { kind: "plugin:exomind-flywheel", form: "note" } },
  });
  emit(turnEnd(2));

  assert.deepEqual(followups(logs), [{ turn: 1, followup: "none" }]);
});

test("多会话互不干扰(各自维护注入 turn 集合)", () => {
  const { ctx, listeners, logs } = fakeCtx();
  registerFollowup(ctx as never);
  const s1 = {};
  const s2 = {};
  const emit = (session: object, event: { type: string; data?: unknown }) =>
    listeners.get("session/event")?.(session, event);

  emit(s1, turnStart(1));
  emit(s1, recallMessage());
  emit(s2, turnStart(1)); // s2 的同号 turn 无注入
  emit(s2, toolCall(1, "exomind_search"));
  emit(s2, turnEnd(1));
  emit(s1, turnEnd(1));

  assert.deepEqual(followups(logs), [{ turn: 1, followup: "none" }]);
});
