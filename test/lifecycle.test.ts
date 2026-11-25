/** 质量点(真 Cordis 4 运行时 + 真 dsh-tools ToolsService,只替换 systemPrompt 与 ExoMind 服务端):
 *  ①卸载等待 apply 返回的 disposer——在途沉淀提交完成前 dispose 不落定
 *    (v0.7.4 回归:Cordis 对带 .prototype 的 apply 走 new,返回值被当成实例丢弃,drain 从未执行)
 *  ②卸载后登记的影响全部撤销:工具不可见、pre-step 不再注入、session/disposed 不再提交
 *  ③卸载过程不留 ref 着事件循环的定时器(否则无在途提交时进程退出多挂 3 秒)。 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";
import ToolsService from "@deepseek-ai/dsh-tools";

import * as plugin from "../src/index.js";

/** 最小 systemPrompt 替身:ToolsService 构造时只调用 tools() 挂一段提示词渲染回调。 */
class FakeSystemPrompt extends Service {
  constructor(ctx: Context) {
    super(ctx, "systemPrompt");
  }

  tools(): () => void {
    return () => {};
  }
}

interface FakeExoMind {
  baseUrl: string;
  /** 服务端已收到 /ingest/async(尚未应答)。 */
  postArrived: Promise<void>;
  /** 放行在途的 /ingest/async 应答。 */
  releasePost: () => void;
  /** 已收到的请求(method + path),按到达顺序。 */
  requests: string[];
  close: () => Promise<void>;
}

/** 本地假 ExoMind(127.0.0.1,不出网):/ingest/async 的应答由测试放行,其余立即应答。 */
function startFakeExoMind(): Promise<FakeExoMind> {
  let announceArrived = (): void => {};
  const postArrived = new Promise<void>((resolve) => {
    announceArrived = resolve;
  });
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? "";
    requests.push(`${req.method} ${path}`);
    req.resume();
    if (path.startsWith("/ingest/async")) {
      announceArrived();
      void gate.then(() => res.end('{"job_id":"job-1"}'));
      return;
    }
    if (path.startsWith("/search")) {
      res.end(
        JSON.stringify({ results: [{ title: "踩坑记录:tar 保 uid 崩溃", path: "raw/x.md" }] }),
      );
      return;
    }
    res.end('{"topics":[]}');
  });
  return new Promise<FakeExoMind>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        postArrived,
        releasePost: release,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** 按真实加载路径挂载:假 systemPrompt → 真 ToolsService → 插件模块对象原样交给 ctx.plugin
 *  (与 cordis-plugin-loader 的 unwrapExports 后 registry.plugin(plugin, config) 同形——
 *  模块对象的形状正是质量点①的被测对象)。 */
async function boot(baseUrl: string) {
  const ctx = new Context();
  const systemPrompt = ctx.plugin(FakeSystemPrompt);
  const tools = ctx.plugin(ToolsService, {});
  await systemPrompt;
  await tools;
  const fiber = ctx.plugin(plugin, { baseUrl, apiKey: "test-key" });
  await fiber; // 依赖满足、apply 执行完
  return { ctx, fiber };
}

/** 一场够质量门槛的会话(用户 ≥8 字、助手 ≥100 字)结束:触发沉淀提交。 */
function feedSession(ctx: Context, session: object): void {
  ctx.emit("session/event", session, {
    type: "user/message",
    data: {
      content: [{ type: "text", text: "请帮我排查会话存档在退出时丢失的问题" }],
      source: { kind: "user" },
    },
  });
  ctx.emit("session/event", session, {
    type: "assistant/message",
    data: {
      turn: 1,
      message: { content: [{ type: "text", text: "助手结论".repeat(60) }], interrupted: false },
    },
  });
  ctx.emit("session/disposed", session);
}

/** 走一遍 agent/pre-step waterfall:默认决策 1 条用户消息,插件注入召回则变 2 条。 */
function runPreStep(ctx: Context): Promise<{ kind: string; messages: unknown[] }> {
  const userMessage = {
    role: "user",
    content: [{ type: "text", text: "tar 保 uid 崩溃怎么修" }],
    source: { kind: "user" },
  };
  return ctx.waterfall(ctx, "agent/pre-step", { agent: {}, turn: 1 }, async () => ({
    kind: "enter",
    messages: [userMessage],
  }));
}

const countPosts = (requests: readonly string[]): number =>
  requests.filter((request) => request.includes("/ingest/async")).length;

test("卸载等待在途沉淀提交:提交未完成前 dispose 不落定,完成后才返回", async () => {
  const api = await startFakeExoMind();
  try {
    const { ctx, fiber } = await boot(api.baseUrl);
    feedSession(ctx, {});
    await api.postArrived;

    let settled = false;
    const disposing = fiber.dispose().then(() => {
      settled = true;
    });
    // 让出一拍:运行时若没接住 apply 的返回值,卸载只走微任务,此刻已经落定
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      settled,
      false,
      "在途提交完成前卸载不得返回——宿主(Ctrl-C 路径)随后就 process.exit",
    );

    api.releasePost();
    await disposing;
  } finally {
    api.close();
  }
});

test("卸载后登记的影响全部撤销:工具不可见、pre-step 不再注入、session/disposed 不再提交", async () => {
  const api = await startFakeExoMind();
  try {
    const { ctx, fiber } = await boot(api.baseUrl);
    // 阳性对照:卸载前三项影响都在
    assert.equal(ctx.tools.definitions().length, 5);
    assert.equal((await runPreStep(ctx)).messages.length, 2);
    feedSession(ctx, {});
    await api.postArrived;
    api.releasePost();

    await fiber.dispose();

    assert.equal(ctx.tools.definitions().length, 0);
    assert.equal((await runPreStep(ctx)).messages.length, 1);
    const postsBefore = countPosts(api.requests);
    feedSession(ctx, {});
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(countPosts(api.requests), postsBefore);
  } finally {
    api.close();
  }
});

test("卸载过程不留 ref 着事件循环的定时器(无在途提交时进程可立即退出)", async () => {
  const api = await startFakeExoMind();
  try {
    const { fiber } = await boot(api.baseUrl);
    const timers: NodeJS.Timeout[] = [];
    const original = globalThis.setTimeout;
    globalThis.setTimeout = ((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const timer = original(fn, ms, ...args);
      timers.push(timer);
      return timer;
    }) as typeof setTimeout;
    try {
      await fiber.dispose();
    } finally {
      globalThis.setTimeout = original;
    }
    assert.ok(timers.length > 0, "drain 起了兜底定时器");
    assert.ok(
      timers.every((timer) => !timer.hasRef()),
      "卸载期间创建的定时器都必须 unref,否则进程退出被拖到定时器到期",
    );
  } finally {
    api.close();
  }
});
