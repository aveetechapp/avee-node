export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
}

export class AstraError extends Error {
  override name = "AstraError";
}

export class AstraHttpError extends AstraError {
  override name = "AstraHttpError";
  readonly status: number;
  readonly url: string;
  readonly body: string;
  readonly problem: Problem | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(init: { status: number; url: string; body: string; problem?: Problem | undefined; retryAfterMs?: number | undefined; detail?: string | undefined }) {
    super(`Astra answered ${init.status} for ${init.url}${init.detail ? `: ${init.detail}` : ""}`);
    this.status = init.status;
    this.url = init.url;
    this.body = init.body;
    this.problem = init.problem;
    this.retryAfterMs = init.retryAfterMs;
  }

  get retryable(): boolean {
    return isRetryableStatus(this.status);
  }
}

export class AstraTimeoutError extends AstraError {
  override name = "AstraTimeoutError";
}

export class AstraConnectionError extends AstraError {
  override name = "AstraConnectionError";
}

export class AstraValidationError extends AstraError {
  override name = "AstraValidationError";
}

export class AstraSubscriptionError extends AstraError {
  override name = "AstraSubscriptionError";
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

export function clip(s: string, max = 200): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
