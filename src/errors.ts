import type { PaymentRequired, Problem } from "./generated/models.js";
import type { PaymentReceipt } from "./x402.js";

export interface RateLimit {
  limit?: number | undefined;
  remaining?: number | undefined;
  resetSeconds?: number | undefined;
  retryAfterSeconds?: number | undefined;
  policy?: string | undefined;
}

export class AveeError extends Error {
  override name = "AveeError";
}

export interface ApiErrorInit {
  status: number;
  operation: string;
  method: string;
  url: string;
  body: string;
  headers: Headers;
  problem?: Problem | undefined;
  rateLimit: RateLimit;
  retryAfterMs?: number | undefined;
  paymentRequired?: PaymentRequired | undefined;
  payment?: PaymentReceipt | undefined;
  paid: boolean;
}

/** A non-2xx answer; `code`, `detail`, `param` and `requestId` come from the problem+json body. */
export class AveeApiError extends AveeError {
  override name = "AveeApiError";
  readonly status: number;
  readonly code: string | undefined;
  readonly detail: string | undefined;
  readonly param: string | undefined;
  readonly requestId: string | undefined;
  readonly operation: string;
  readonly method: string;
  readonly url: string;
  readonly body: string;
  readonly headers: Headers;
  readonly problem: Problem | undefined;
  readonly rateLimit: RateLimit;
  readonly retryAfterMs: number | undefined;
  readonly paymentRequired: PaymentRequired | undefined;
  readonly payment: PaymentReceipt | undefined;
  readonly paid: boolean;

  constructor(init: ApiErrorInit) {
    const p = init.problem;
    const detail = clip(p ? p.detail || p.title || "" : init.body.trim());
    const requestId = p?.request_id || init.headers.get("x-request-id") || undefined;
    super(
      `${init.method} ${init.url} answered ${init.status}${p?.code ? ` ${p.code}` : ""}${detail ? `: ${detail}` : ""}${requestId ? ` (request ${requestId})` : ""}`,
    );
    this.status = init.status;
    this.code = p?.code;
    this.detail = detail || undefined;
    this.param = p?.param;
    this.requestId = requestId;
    this.operation = init.operation;
    this.method = init.method;
    this.url = init.url;
    this.body = init.body;
    this.headers = init.headers;
    this.problem = p;
    this.rateLimit = init.rateLimit;
    this.retryAfterMs = init.retryAfterMs;
    this.paymentRequired = init.paymentRequired;
    this.payment = init.payment;
    this.paid = init.paid;
  }

  get retryable(): boolean {
    return isRetryableStatus(this.status);
  }
}

export class AveeTimeoutError extends AveeError {
  override name = "AveeTimeoutError";
}

export class AveeConnectionError extends AveeError {
  override name = "AveeConnectionError";
}

/** Bad input, caught before any request, or a response that breaks the contract. */
export class AveeValidationError extends AveeError {
  override name = "AveeValidationError";
}

/** The x402 flow stopped before a paid request was sent: the challenge or its offer was unreadable, no network in common, or the payer declined. */
export class AveePaymentError extends AveeError {
  override name = "AveePaymentError";
  readonly operation: string;
  readonly paymentRequired: PaymentRequired | undefined;

  constructor(message: string, operation: string, paymentRequired?: PaymentRequired, options?: { cause?: unknown }) {
    super(`payment for ${operation}: ${message}`, options);
    this.operation = operation;
    this.paymentRequired = paymentRequired;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function clip(s: string, max = 200): string {
  if (s.length <= max) return s;
  const code = s.charCodeAt(max - 1);
  return `${s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)}…`;
}
