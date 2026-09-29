import {
  AveeApiError,
  AveeConnectionError,
  AveeError,
  AveePaymentError,
  AveeTimeoutError,
  AveeValidationError,
  type RateLimit,
} from "./errors.js";
import { Mismatch } from "./decode.js";
import type { Problem } from "./generated/models.js";
import type { Call } from "./request.js";
import { decodeRequired, type Payer, type PaymentReceipt, parseReceipt, signPayment } from "./x402.js";

export interface HttpConfig {
  baseUrl: string;
  apiKey: string | undefined;
  timeoutMs: number;
  maxRetries: number;
  maxRetryDelayMs: number;
  maxResponseBytes: number;
  headers: Readonly<Record<string, string>>;
  fetch: typeof fetch;
  payer: Payer | undefined;
}

export interface ResponseInfo {
  operation: string;
  status: number;
  requestId: string | undefined;
  rateLimit: RateLimit;
  payment: PaymentReceipt | undefined;
}

const RETRY_BASE_MS = 250;

function fullJitter(attempt: number, baseMs: number, capMs: number): number {
  return Math.floor(Math.random() * Math.min(capMs, baseMs * 2 ** Math.min(attempt, 30)));
}

function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d{1,9}$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function int(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || !/^\s*\d{1,12}\s*$/.test(value)) return undefined;
  return Number(value);
}

function parseRateLimit(h: Headers): RateLimit {
  const fields = new Map<string, string>();
  for (const part of (h.get("ratelimit") ?? "").split(";")) {
    const [k, v] = part.split("=");
    if (k && v !== undefined) fields.set(k.trim(), v.trim());
  }
  const retryAfter = parseRetryAfter(h.get("retry-after"));
  return {
    limit: int(h.get("x-ratelimit-limit")),
    remaining: int(h.get("x-ratelimit-remaining")) ?? int(fields.get("r")),
    resetSeconds: int(h.get("x-ratelimit-reset")) ?? int(fields.get("t")),
    retryAfterSeconds: retryAfter === undefined ? undefined : retryAfter / 1000,
    policy: h.get("ratelimit-policy") ?? undefined,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readBounded(res: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const declared = Number(res.headers.get("content-length") ?? NaN);
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
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return { text: "", truncated: true };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder().decode(buf), truncated: false };
}

const PROBLEM_STRINGS = ["type", "title", "code", "detail", "param", "request_id"] as const;

function asProblem(text: string, type: string): Problem | undefined {
  if (!type.includes("json")) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const p = body as Record<string, unknown>;
  if (PROBLEM_STRINGS.some((k) => p[k] !== undefined && typeof p[k] !== "string")) return undefined;
  if (p.status !== undefined && typeof p.status !== "number") return undefined;
  return p.code || p.title ? (p as unknown as Problem) : undefined;
}

function decode<T>(call: Call, url: string, text: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AveeValidationError(`${call.operation}: response from ${url} is not JSON`);
  }
  try {
    call.check(value);
  } catch (err) {
    if (!(err instanceof Mismatch)) throw err;
    throw new AveeValidationError(`${call.operation}: response from ${url} does not match the contract: ${err.where("response")} ${err.message}`);
  }
  return value as T;
}

interface Reply {
  status: number;
  headers: Headers;
  text: string;
}

export class HttpTransport {
  readonly config: HttpConfig;
  last: ResponseInfo | undefined;

  constructor(config: HttpConfig) {
    this.config = config;
  }

  url(call: Call): string {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const qs = new URLSearchParams(call.query as [string, string][]).toString();
    return `${base}${call.path}${qs ? `?${qs}` : ""}`;
  }

  async send<T>(call: Call, signal?: AbortSignal): Promise<T> {
    const url = this.url(call);
    const body = call.body === undefined ? undefined : JSON.stringify(call.body);
    let signature: string | undefined;
    for (let attempt = 0; ; ) {
      let reply: Reply;
      try {
        reply = await this.attempt(call, url, body, signature, signal);
      } catch (err) {
        const delay = this.retryDelay(call, err, attempt, signature !== undefined);
        if (delay === undefined || signal?.aborted) throw err;
        await sleep(delay, signal);
        if (signal?.aborted) throw signal.reason;
        attempt++;
        continue;
      }
      if (reply.status >= 200 && reply.status < 300) return decode<T>(call, url, reply.text);
      if (reply.status === 402 && this.config.payer && signature === undefined) {
        const raw = decodeRequired(reply.headers.get("payment-required"), reply.text);
        if (!raw) throw new AveePaymentError("the 402 challenge is unreadable", call.operation);
        signature = await signPayment(this.config.payer, call.operation, call.method, url, raw);
        continue;
      }
      const err = this.apiError(call, url, reply, signature !== undefined);
      const delay = this.retryDelay(call, err, attempt, signature !== undefined);
      if (delay === undefined) throw err;
      await sleep(delay, signal);
      if (signal?.aborted) throw signal.reason;
      attempt++;
    }
  }

  private apiError(call: Call, url: string, reply: Reply, paid: boolean): AveeApiError {
    const raw = reply.status === 402 ? decodeRequired(reply.headers.get("payment-required"), reply.text) : undefined;
    return new AveeApiError({
      status: reply.status,
      operation: call.operation,
      method: call.method,
      url,
      body: reply.text.slice(0, 64 * 1024),
      headers: reply.headers,
      problem: asProblem(reply.text, reply.headers.get("content-type") ?? ""),
      rateLimit: parseRateLimit(reply.headers),
      retryAfterMs: parseRetryAfter(reply.headers.get("retry-after")),
      paymentRequired: raw as never,
      payment: parseReceipt(reply.headers),
      paid,
    });
  }

  private retryDelay(call: Call, err: unknown, attempt: number, paid: boolean): number | undefined {
    if (paid || call.method !== "GET" || attempt >= this.config.maxRetries) return undefined;
    const backoff = fullJitter(attempt, RETRY_BASE_MS, this.config.maxRetryDelayMs);
    if (err instanceof AveeApiError) {
      if (!err.retryable) return undefined;
      let wait = err.retryAfterMs;
      if (wait === undefined && err.status === 429 && err.rateLimit.remaining === 0 && err.rateLimit.resetSeconds !== undefined) {
        wait = err.rateLimit.resetSeconds * 1000;
      }
      if (wait === undefined || wait === 0) return backoff;
      return wait <= this.config.maxRetryDelayMs ? wait : undefined;
    }
    if (err instanceof AveeTimeoutError || err instanceof AveeConnectionError) return backoff;
    return undefined;
  }

  private async attempt(call: Call, url: string, body: string | undefined, signature: string | undefined, signal: AbortSignal | undefined): Promise<Reply> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const headers: Record<string, string> = { ...this.config.headers, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.config.apiKey) headers["x-api-key"] = this.config.apiKey;
    if (this.config.payer) headers["accept-payment"] = "x402";
    if (signature !== undefined) headers["payment-signature"] = signature;
    try {
      const res = await this.config.fetch(url, { method: call.method, headers, body: body ?? null, redirect: "manual", signal: controller.signal });
      const { text, truncated } = await readBounded(res, this.config.maxResponseBytes);
      this.last = {
        operation: call.operation,
        status: res.status,
        requestId: res.headers.get("x-request-id") ?? undefined,
        rateLimit: parseRateLimit(res.headers),
        payment: parseReceipt(res.headers),
      };
      if (truncated) throw new AveeValidationError(`${call.operation}: response from ${url} exceeds ${this.config.maxResponseBytes} bytes`);
      return { status: res.status, headers: res.headers, text };
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      if (timedOut) throw new AveeTimeoutError(`${call.method} ${url} timed out after ${this.config.timeoutMs} ms`);
      if (err instanceof AveeError) throw err;
      throw new AveeConnectionError(`${call.method} ${url} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
