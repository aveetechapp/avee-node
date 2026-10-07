import { AstraConnectionError, AstraError, AstraSubscriptionError, AstraTimeoutError, AstraValidationError, clip } from "../errors.js";
import type { FeedId } from "../ids.js";
import { decodeStreamedPriceFeed } from "../models.js";
import type { StreamSink, StreamTransport } from "./transport.js";

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface WsConfig {
  url: string;
  ids: readonly FeedId[];
  ignoreInvalid: boolean;
  idleTimeoutMs: number;
  maxMessageBytes: number;
  WebSocket: WebSocketConstructor;
}

const OPEN = 1;
const HEARTBEAT = JSON.stringify({ type: "unsubscribe", ids: [] });

export class WsTransport implements StreamTransport {
  private readonly config: WsConfig;
  private readonly subscribe: string;

  constructor(config: WsConfig) {
    this.config = config;
    this.subscribe = JSON.stringify({
      type: "subscribe",
      ids: config.ids,
      verbose: true,
      binary: false,
      ignore_invalid_price_ids: config.ignoreInvalid,
    });
  }

  run(signal: AbortSignal, sink: StreamSink): Promise<void> {
    const { idleTimeoutMs, maxMessageBytes } = this.config;
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return resolve();
      let settled = false;
      let awaitingAck = true;
      let heartbeatSent = false;
      let lastMessage = Date.now();
      let ws: WebSocketLike;
      try {
        ws = new this.config.WebSocket(this.config.url);
      } catch (err) {
        reject(new AstraConnectionError(`WebSocket to ${this.config.url} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
        return;
      }

      const finish = (err?: AstraError) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        signal.removeEventListener("abort", onAbort);
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          ws.close(1000);
        } catch {}
        if (err) reject(err);
        else resolve();
      };
      const onAbort = () => finish();
      signal.addEventListener("abort", onAbort, { once: true });

      const watchdog = setInterval(() => {
        const silent = Date.now() - lastMessage;
        if (silent >= idleTimeoutMs) {
          finish(new AstraTimeoutError(`WebSocket idle for ${silent} ms`));
        } else if (silent >= idleTimeoutMs / 2 && !heartbeatSent && !awaitingAck && ws.readyState === OPEN) {
          heartbeatSent = true;
          send(HEARTBEAT);
        }
      }, Math.max(10, Math.floor(idleTimeoutMs / 4)));

      const send = (data: string) => {
        try {
          ws.send(data);
        } catch (err) {
          finish(new AstraConnectionError(`WebSocket send failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
        }
      };
      ws.onopen = () => {
        lastMessage = Date.now();
        send(this.subscribe);
      };
      ws.onerror = () => undefined;
      ws.onclose = (ev) => {
        finish(ev.code === 1000 ? undefined : new AstraConnectionError(`WebSocket closed with code ${ev.code}${ev.reason ? `: ${clip(ev.reason)}` : ""}`));
      };
      ws.onmessage = (ev) => {
        lastMessage = Date.now();
        heartbeatSent = false;
        if (typeof ev.data !== "string") return;
        if (ev.data.length > maxMessageBytes) {
          sink.warn(new AstraValidationError(`WebSocket message exceeds ${maxMessageBytes} bytes`));
          return;
        }
        let msg: unknown;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          sink.warn(new AstraValidationError("WebSocket message is not JSON"));
          return;
        }
        if (typeof msg !== "object" || msg === null) return;
        const m = msg as Record<string, unknown>;
        if (m.type === "response") {
          const failed = m.status === "error";
          const text = typeof m.error === "string" ? clip(m.error) : "unknown error";
          if (awaitingAck) {
            awaitingAck = false;
            if (failed) finish(new AstraSubscriptionError(`Astra refused the subscription: ${text}`));
            else sink.opened();
          } else if (failed) {
            sink.report(new AstraError(`Astra: ${text}`));
          }
        } else if (m.type === "price_update") {
          try {
            sink.update(decodeStreamedPriceFeed(m.price_feed, "price_feed"));
          } catch (err) {
            sink.warn(err instanceof AstraError ? err : new AstraValidationError(String(err)));
          }
        }
      };
    });
  }
}
