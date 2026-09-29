import { AveeValidationError } from "./errors.js";
import { Operations } from "./generated/operations.js";
import { HttpTransport, type ResponseInfo } from "./http.js";
import type { Call, RequestOptions } from "./request.js";
import type { Payer } from "./x402.js";

export const DEFAULT_BASE_URL = "https://api.preview.avee.tech/api/v1";
export const PREVIEW_BASE_URL = "https://api.preview.avee.tech/api/v1";

export interface AveeClientOptions {
  baseUrl?: string | undefined;
  /** Optional: raises the limits. Keyless calls work. */
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  maxRetryDelayMs?: number | undefined;
  maxResponseBytes?: number | undefined;
  headers?: Record<string, string> | undefined;
  fetch?: typeof fetch | undefined;
  /** Opts into x402: past the keyless limit, calls are paid through this signer. */
  payer?: Payer | undefined;
}

function positive(name: string, value: number | undefined, fallback: number, allowZero = false): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) throw new AveeValidationError(`${name} must be a positive number`);
  return value;
}

/** Client for the avee DEX data API. Every operation of /api/v1 is a method. */
export class AveeClient extends Operations {
  private readonly transport: HttpTransport;

  constructor(options: AveeClientOptions = {}) {
    super();
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new AveeValidationError(`baseUrl must be an absolute http(s) URL, got ${baseUrl}`);
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.search) {
      throw new AveeValidationError(`baseUrl must be an absolute http(s) URL without a query, got ${baseUrl}`);
    }
    if (options.apiKey !== undefined && (typeof options.apiKey !== "string" || options.apiKey === "" || /[\r\n\0]/.test(options.apiKey))) {
      throw new AveeValidationError("apiKey must be a single non-empty line");
    }
    if (options.payer !== undefined && typeof options.payer.sign !== "function") {
      throw new AveeValidationError("payer must have a sign(context) method");
    }
    const networks = options.payer?.networks;
    if (networks !== undefined && (!Array.isArray(networks) || !networks.every((n) => typeof n === "string"))) {
      throw new AveeValidationError("payer.networks must be an array of strings");
    }
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (name.toLowerCase() === "payment-signature") throw new AveeValidationError("the payment-signature header is sent only by the payer");
      if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw new AveeValidationError(`header ${name} must be a single-line string`);
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new AveeValidationError("no fetch available; pass options.fetch");
    this.transport = new HttpTransport({
      baseUrl,
      apiKey: options.apiKey,
      timeoutMs: positive("timeoutMs", options.timeoutMs, 30_000),
      maxRetries: Math.floor(positive("maxRetries", options.maxRetries, 2, true)),
      maxRetryDelayMs: positive("maxRetryDelayMs", options.maxRetryDelayMs, 30_000, true),
      maxResponseBytes: positive("maxResponseBytes", options.maxResponseBytes, 16 * 1024 * 1024),
      headers: { ...options.headers },
      fetch: fetchImpl.bind(globalThis),
      payer: options.payer,
    });
  }

  /** Status, request id, rate-limit headers and x402 receipt of the most recent response. */
  get lastResponse(): ResponseInfo | undefined {
    return this.transport.last;
  }

  protected call<T>(call: Call, options?: RequestOptions): Promise<T> {
    return this.transport.send<T>(call, options?.signal);
  }
}
