import { fullJitter, sleep } from "../backoff.js";
import { AstraConnectionError, AstraError, AstraHttpError, AstraSubscriptionError, isRetryableStatus } from "../errors.js";
import type { FeedId } from "../ids.js";
import type { PriceUpdate } from "../models.js";
import type { StreamTransport } from "./transport.js";

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface ReconnectPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  stableAfterMs: number;
}

export interface SubscriptionStats {
  connects: number;
  reconnects: number;
  coalesced: number;
  duplicates: number;
  invalid: number;
}

export interface SubscriptionHooks {
  onError?: ((err: AstraError) => void) | undefined;
  onStateChange?: ((state: ConnectionState) => void) | undefined;
}

function isFatal(err: AstraError): boolean {
  if (err instanceof AstraSubscriptionError) return true;
  return err instanceof AstraHttpError && !isRetryableStatus(err.status);
}

function sameUpdate(a: PriceUpdate, b: PriceUpdate): boolean {
  return (
    a.price.publishTime === b.price.publishTime &&
    a.price.price === b.price.price &&
    a.price.conf === b.price.conf &&
    a.emaPrice.price === b.emaPrice.price
  );
}

export class Subscription implements AsyncIterable<PriceUpdate> {
  readonly ids: readonly FeedId[];
  readonly done: Promise<void>;
  private readonly wanted: ReadonlySet<FeedId>;
  private readonly transport: StreamTransport;
  private readonly policy: ReconnectPolicy;
  private readonly hooks: SubscriptionHooks;
  private readonly controller = new AbortController();
  private readonly pending = new Map<FeedId, PriceUpdate>();
  private readonly last = new Map<FeedId, PriceUpdate>();
  private readonly counters: SubscriptionStats = { connects: 0, reconnects: 0, coalesced: 0, duplicates: 0, invalid: 0 };
  private waiters: Array<() => void> = [];
  private failure: AstraError | undefined;
  private finished = false;
  private state: ConnectionState = "connecting";

  constructor(ids: readonly FeedId[], transport: StreamTransport, policy: ReconnectPolicy, hooks: SubscriptionHooks, signal?: AbortSignal) {
    this.ids = ids;
    this.wanted = new Set(ids);
    this.transport = transport;
    this.policy = policy;
    this.hooks = hooks;
    const onAbort = () => this.close();
    if (signal?.aborted) this.controller.abort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    this.done = this.run().finally(() => signal?.removeEventListener("abort", onAbort));
  }

  get stats(): Readonly<SubscriptionStats> {
    return { ...this.counters };
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get error(): AstraError | undefined {
    return this.failure;
  }

  close(): void {
    this.controller.abort();
    this.wake();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<PriceUpdate, void, undefined> {
    try {
      for (;;) {
        const next = this.take();
        if (next) {
          yield next;
          continue;
        }
        if (this.finished) {
          if (this.failure) throw this.failure;
          return;
        }
        await new Promise<void>((resolve) => {
          this.waiters.push(resolve);
        });
      }
    } finally {
      this.close();
    }
  }

  private take(): PriceUpdate | undefined {
    const first = this.pending.entries().next();
    if (first.done) return undefined;
    this.pending.delete(first.value[0]);
    return first.value[1];
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    try {
      this.hooks.onStateChange?.(state);
    } catch {}
  }

  private report(err: AstraError): void {
    try {
      this.hooks.onError?.(err);
    } catch {}
  }

  private accept(update: PriceUpdate): void {
    if (!this.wanted.has(update.id)) return;
    const prev = this.last.get(update.id);
    if (prev && (update.price.publishTime < prev.price.publishTime || sameUpdate(prev, update))) {
      this.counters.duplicates++;
      return;
    }
    this.last.set(update.id, update);
    if (this.pending.has(update.id)) this.counters.coalesced++;
    this.pending.set(update.id, update);
    this.wake();
  }

  private async run(): Promise<void> {
    const signal = this.controller.signal;
    let openedAt = 0;
    let attempt = 0;
    const sink = {
      opened: () => {
        openedAt = Date.now();
        this.counters.connects++;
        this.setState("open");
      },
      update: (u: PriceUpdate) => this.accept(u),
      warn: (err: AstraError) => {
        this.counters.invalid++;
        this.report(err);
      },
      report: (err: AstraError) => this.report(err),
    };
    try {
      while (!signal.aborted) {
        openedAt = 0;
        let retryAfterMs = 0;
        try {
          await this.transport.run(signal, sink);
        } catch (err) {
          if (signal.aborted) break;
          const e = err instanceof AstraError ? err : new AstraConnectionError(String(err), { cause: err });
          if (isFatal(e)) {
            this.failure = e;
            this.report(e);
            break;
          }
          this.report(e);
          if (e instanceof AstraHttpError && e.retryAfterMs !== undefined) retryAfterMs = e.retryAfterMs;
        }
        if (signal.aborted) break;
        if (openedAt > 0 && Date.now() - openedAt >= this.policy.stableAfterMs) attempt = 0;
        const delay = Math.max(retryAfterMs, fullJitter(attempt, this.policy.baseDelayMs, this.policy.maxDelayMs));
        attempt++;
        this.counters.reconnects++;
        this.setState("reconnecting");
        await sleep(delay, signal);
      }
    } finally {
      this.finished = true;
      this.setState("closed");
      this.wake();
    }
  }
}
