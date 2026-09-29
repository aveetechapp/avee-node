import { fullJitter, parseRetryAfter, sleep } from "./backoff.js";
import {
  AstraConnectionError,
  AstraError,
  AstraHttpError,
  AstraTimeoutError,
  AstraValidationError,
  clip,
  isRetryableStatus,
  type Problem,
} from "./errors.js";

export type Query = ReadonlyArray<readonly [string, string]>;

export interface HttpConfig {
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  maxRetryDelayMs: number;
  maxResponseBytes: number;
  headers: Readonly<Record<string, string>>;
  fetch: typeof fetch;
}

const ERROR_BODY_LIMIT = 64 * 1024;
const RETRY_BASE_MS = 250;

export function joinUrl(baseUrl: string, path: string, query: Query = []): URL {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(path.replace(/^\/+/, ""), base);
  for (const [k, v] of query) url.searchParams.append(k, v);
  return url;
}

export async function readBounded(res: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (!res.body) return { text: "", truncated: false };
  if (declared > limit) {
    await res.body.cancel().catch(() => undefined);
    return { text: "", truncated: true };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      await reader.cancel().catch(() => undefined);
      return { text: decode(chunks, total), truncated: true };
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { text: decode(chunks, total), truncated: false };
}

function decode(chunks: Uint8Array[], total: number): string {
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export async function httpError(res: Response, url: string): Promise<AstraHttpError> {
  const { text } = await readBounded(res, ERROR_BODY_LIMIT).catch(() => ({ text: "" }));
  let problem: Problem | undefined;
  let detail = clip(text.trim());
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("json")) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      if (typeof body.title === "string" && typeof body.status === "number") {
        problem = {
          type: typeof body.type === "string" ? body.type : "about:blank",
          title: body.title,
          status: body.status,
          detail: typeof body.detail === "string" ? body.detail : "",
        };
        detail = clip(problem.detail || problem.title);
      } else if (typeof body.errmsg === "string") {
        detail = clip(body.errmsg);
      }
    } catch {
      detail = clip(text.trim());
    }
  }
  return new AstraHttpError({
    status: res.status,
    url,
    body: text,
    problem,
    retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    detail,
  });
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

export class HttpTransport {
  readonly config: HttpConfig;

  constructor(config: HttpConfig) {
    this.config = config;
  }

  async getJson(path: string, query: Query, signal?: AbortSignal, accept: readonly number[] = []): Promise<unknown> {
    const url = joinUrl(this.config.baseUrl, path, query).toString();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(url, signal, accept);
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        const delay = this.retryDelay(err, attempt);
        if (delay === undefined) throw err;
        await sleep(delay, signal);
        if (signal?.aborted) throw signal.reason;
      }
    }
  }

  private retryDelay(err: unknown, attempt: number): number | undefined {
    if (attempt >= this.config.maxRetries) return undefined;
    const backoff = fullJitter(attempt, RETRY_BASE_MS, this.config.maxRetryDelayMs);
    if (err instanceof AstraHttpError) {
      if (!isRetryableStatus(err.status)) return undefined;
      if (err.retryAfterMs === undefined) return backoff;
      return err.retryAfterMs <= this.config.maxRetryDelayMs ? err.retryAfterMs : undefined;
    }
    if (err instanceof AstraTimeoutError || err instanceof AstraConnectionError) return backoff;
    return undefined;
  }

  private async attempt(url: string, signal: AbortSignal | undefined, accept: readonly number[]): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await this.config.fetch(url, {
        method: "GET",
        headers: { accept: "application/json", ...this.config.headers },
        signal: controller.signal,
      });
      if (!res.ok && !(accept.includes(res.status) && isJsonBody(res))) throw await httpError(res, url);
      const { text, truncated } = await readBounded(res, this.config.maxResponseBytes);
      if (truncated) throw new AstraValidationError(`response from ${url} exceeds ${this.config.maxResponseBytes} bytes`);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new AstraValidationError(`response from ${url} is not JSON`);
      }
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      if (timedOut) throw new AstraTimeoutError(`request to ${url} timed out after ${this.config.timeoutMs} ms`);
      if (err instanceof AstraError || isAbort(err)) throw err;
      throw new AstraConnectionError(`request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function isJsonBody(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";
}
