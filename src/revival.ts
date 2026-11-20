/** 复活率:召回命中的页里,有多少来自本插件此前的会话沉淀——
 *  「上一场会话的沉淀成为下一场的召回」从叙事变成可观测数字。
 *  数据源:GET /ingest/recent?feed=1 —— 每条带 channel(= ingest 请求 origin 的透传,
 *  item.source 是展示名,别用)与 created/updated pages;channel=dsh-plugin 的页集合
 *  与召回命中 path 求交集。
 *  硬约束:绝不在前台召回路径上等网络——peek() 只读缓存(未就绪返回 null,
 *  埋点省略 revived 字段),refresh() 单飞后台预热,TTL 过期沿用旧集直到换新。
 *  不落任何本地文件(守住 README 的零残留承诺),进程内缓存即全部状态。 */
import { ExoMindClient } from "./api.js";
import { resolveTarget, type ResolveEnv } from "./config.js";

/** /ingest/async 的 origin 字段值:服务端 ingest_log 的 log_source,回查时的过滤键。 */
export const DSH_ORIGIN = "dsh-plugin";

/** 拉取窗口:最近 100 条摄入(每会话一条,覆盖近期全部 dsh 沉淀)。 */
const RECENT_LIMIT = 100;
const DEFAULT_TTL_MS = 10 * 60_000;

interface RecentItem {
  /** 摄入渠道 = ingest 请求的 origin 透传(线上实证 2026-11-20:claude-session/hook-auto)。
   *  注意别用 item.source——那是展示名(公众号/作者),人工摄入恒为空。 */
  channel?: string;
  created_pages?: string[];
  updated_pages?: string[];
}

export interface RegistryOptions {
  baseUrl?: string;
  apiKey?: string;
  resolveEnv?: ResolveEnv;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
}

export class DshPageRegistry {
  private pages: Set<string> | null = null;
  private fetchedAt = 0;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly options: RegistryOptions = {}) {}

  /** 同步窥视:缓存就绪返回交集数;未就绪返回 null(调用方省略 revived 字段)。 */
  peek(paths: readonly (string | undefined)[]): number | null {
    if (!this.pages) return null;
    let revived = 0;
    for (const p of paths) {
      if (p && this.pages.has(p)) revived++;
    }
    return revived;
  }

  /** 后台刷新(单飞 + TTL):fire-and-forget,任何失败沿用旧集(fail-open)。 */
  refresh(): void {
    const ttl = this.options.ttlMs ?? DEFAULT_TTL_MS;
    if (this.pages && Date.now() - this.fetchedAt < ttl) return;
    if (this.refreshing) return;
    this.refreshing = this.fetch().finally(() => {
      this.refreshing = null;
    });
  }

  private async fetch(): Promise<void> {
    try {
      const target = resolveTarget(
        { baseUrl: this.options.baseUrl, apiKey: this.options.apiKey },
        this.options.resolveEnv,
      );
      const client = new ExoMindClient(target.baseUrl, target.apiKey, this.options.fetchImpl);
      const result = (await client.get("/ingest/recent", {
        query: { feed: 1, limit: RECENT_LIMIT },
        timeoutMs: 10_000,
      })) as { items?: RecentItem[] };
      const pages = new Set<string>();
      for (const item of result.items ?? []) {
        if (item.channel !== DSH_ORIGIN) continue;
        for (const p of [...(item.created_pages ?? []), ...(item.updated_pages ?? [])]) {
          pages.add(p);
        }
      }
      this.pages = pages;
      this.fetchedAt = Date.now();
    } catch {
      // fail-open:拉不到就沿用旧集(没有则继续 peek=null),埋点缺字段不报错
    }
  }
}
