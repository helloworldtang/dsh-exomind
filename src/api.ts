/** ExoMind REST 客户端:Bearer 认证 + 显式 UA + 超时 + 瞬时错误重试。
 *  对齐 exomind-cli src/api.ts 的行为(除幂等读命令的重试在这里内联)。 */
import pkg from "../package.json" with { type: "json" };

export const USER_AGENT = `dsh-exomind/${pkg.version}`;

export class ApiError extends Error {
  status: number;
  detail: string;
  /** true = 客户端主动超时中止,重试只会再等一个满超时,不值得重试。 */
  timedOut: boolean;

  constructor(status: number, detail: string, timedOut = false) {
    super(`HTTP ${status}: ${detail}`);
    this.status = status;
    this.detail = detail;
    this.timedOut = timedOut;
  }
}

/** 瞬时错误(502/503/504/网络故障,不含超时与 429):值得退避重试。 */
export function isTransientError(e: unknown): boolean {
  return (
    e instanceof ApiError && ([502, 503, 504].includes(e.status) || (e.status === 0 && !e.timedOut))
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  /** 外部中止信号(如 DSH 工具执行的 exec.signal)。 */
  signal?: AbortSignal;
  /** 瞬时错误重试次数,默认 2(读命令幂等,安全可重试)。 */
  retries?: number;
}

/** 可注入 fetch 便于测试;生产用 Node 22 全局 fetch。 */
export type FetchLike = typeof fetch;

export class ExoMindClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private fetchImpl: FetchLike = fetch,
  ) {}

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): string {
    const base = this.baseUrl.replace(/\/+$/, "");
    let url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== "") params.append(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    return url;
  }

  private async request(method: string, path: string, opts: RequestOptions): Promise<unknown> {
    if (!this.apiKey) {
      throw new ApiError(
        401,
        "未配置 ExoMind API Key。运行 `exomind login` 写入 ~/.exomind/config.json,或在插件配置/环境变量 EXOMIND_API_KEY 中提供。",
      );
    }
    const controller = new AbortController();
    const timeout = opts.timeoutMs ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeout);
    const onExternalAbort = (): void => controller.abort();
    opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      const res = await this.fetchImpl(this.buildUrl(path, opts.query), {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          // 显式 UA 替代 undici 默认的 "node":服务端访问日志按 ua= 分桶各客户端流量
          "User-Agent": USER_AGENT,
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        let detail = text || res.statusText;
        try {
          const parsed = JSON.parse(text) as { detail?: string; message?: string };
          detail = parsed.detail || parsed.message || detail;
        } catch {
          /* 保留原始文本 */
        }
        throw new ApiError(res.status, String(detail).slice(0, 800));
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e instanceof Error && e.name === "AbortError") {
        throw new ApiError(0, `请求超时或被中止 (${timeout}ms): ${method} ${path}`, true);
      }
      throw new ApiError(0, `网络错误: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  /** GET + 瞬时错误短退避重试(0.5s/1s,静默)。 */
  async get(path: string, opts: RequestOptions = {}): Promise<unknown> {
    const retries = opts.retries ?? 2;
    let attempt = 0;
    for (;;) {
      try {
        return await this.request("GET", path, opts);
      } catch (e) {
        if (!isTransientError(e) || attempt >= retries) throw e;
        await sleep(500 * 2 ** attempt);
        attempt++;
      }
    }
  }

  /** POST /query 等长操作:默认不重试(LLM 问答非幂等,重试白等一个满超时)。 */
  post(path: string, opts: RequestOptions = {}): Promise<unknown> {
    return this.request("POST", path, { ...opts, retries: 0 });
  }
}
