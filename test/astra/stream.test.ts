import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  AstraClient,
  AstraHttpError,
  AstraSubscriptionError,
  AstraValidationError,
  type AstraError,
  MAX_IDS_PER_URL,
  type ConnectionState,
  type PriceUpdate,
  type Subscription,
  type WebSocketConstructor,
} from "../../src/astra/index.js";
import { SseParser } from "../../src/astra/stream/sse.js";
import { BTC, ETH, envelope, type FakeAstra, parsed, startFake, text, waitFor, wsUpdate } from "./fake-astra.js";

let fake: FakeAstra | undefined;
const subs: Subscription[] = [];

afterEach(async () => {
  for (const s of subs.splice(0)) {
    s.close();
    await s.done;
  }
  await fake?.close();
  fake = undefined;
});

const fast = { reconnectBaseDelayMs: 20, reconnectMaxDelayMs: 50 };

function sse(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.flushHeaders();
}

function event(res: ServerResponse, body: unknown): void {
  res.write(`data: ${JSON.stringify(body)}\n\n`);
}

async function take(sub: Subscription, n: number): Promise<PriceUpdate[]> {
  const out: PriceUpdate[] = [];
  const it = sub[Symbol.asyncIterator]();
  while (out.length < n) {
    const r = await it.next();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

function track(sub: Subscription): Subscription {
  subs.push(sub);
  return sub;
}

function timers(): number {
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
}

describe("SSE parser", () => {
  it("handles split chunks, CRLF, comments and multi-line data", () => {
    const got: string[] = [];
    const p = new SseParser(1024, (d) => got.push(d));
    p.push(": keepalive\r\n\r\nda");
    p.push("ta: {\"a\":1}\r");
    p.push("\n\ndata: x\ndata:y\nevent: e\nid: 1\n\n");
    expect(got).toEqual(['{"a":1}', "x\ny"]);
  });

  it("bounds a line and an event", () => {
    expect(() => new SseParser(8, () => undefined).push("data: 123456789")).toThrow(/line exceeds/);
    const p = new SseParser(8, () => undefined);
    expect(() => p.push("data: 12345\ndata: 12345\n")).toThrow(/event exceeds/);
  });
});

describe("SSE subscription", () => {
  it("streams updates, reconnects after the server ends the stream and drops the replayed value", async () => {
    let connects = 0;
    let release = () => undefined as void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    fake = await startFake((_req, res) => {
      connects++;
      sse(res);
      if (connects === 1) {
        event(res, envelope(parsed(BTC, "1", 10)));
        setTimeout(() => res.end(), 20);
        return;
      }
      void gate.then(() => {
        event(res, envelope(parsed(BTC, "1", 10)));
        event(res, envelope(parsed(BTC, "2", 11)));
      });
    });
    const states: ConnectionState[] = [];
    const sub = track(
      new AstraClient({ baseUrl: fake.url }).subscribe([BTC], { transport: "sse", channel: "real_time", ...fast, onStateChange: (s) => states.push(s) }),
    );
    expect((await take(sub, 1)).map((u) => u.price.price)).toEqual(["1"]);
    release();
    expect((await take(sub, 1)).map((u) => u.price.price)).toEqual(["2"]);
    expect(sub.stats.duplicates).toBe(1);
    expect(sub.stats.reconnects).toBe(1);
    expect(states).toEqual(["open", "reconnecting", "open"]);
    const q = fake.requests[0]!.searchParams;
    expect(q.getAll("ids[]")).toEqual([BTC]);
    expect(q.get("channel")).toBe("real_time");
  });

  it("stops on a 404 and throws from the iterator", async () => {
    fake = await startFake((_req, res) => text(res, 404, `Price ids not found: ${BTC}`));
    const errors: AstraError[] = [];
    const sub = track(new AstraClient({ baseUrl: fake.url }).subscribe([BTC], { transport: "sse", ...fast, onError: (e) => errors.push(e) }));
    await expect(take(sub, 1)).rejects.toThrow(AstraHttpError);
    expect(sub.error).toBeInstanceOf(AstraHttpError);
    expect(errors).toHaveLength(1);
    expect(fake.requests).toHaveLength(1);
  });

  it("waits Retry-After on 429 before reconnecting", async () => {
    let calls = 0;
    fake = await startFake((_req, res) => {
      calls++;
      if (calls === 1) return text(res, 429, "too many streams", { "retry-after": "1" });
      sse(res);
      event(res, envelope(parsed(BTC, "1", 1)));
    });
    const started = Date.now();
    const sub = track(new AstraClient({ baseUrl: fake.url }).subscribe([BTC], { transport: "sse", ...fast }));
    await take(sub, 1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });

  it("reconnects a silent stream after the idle timeout", async () => {
    let calls = 0;
    fake = await startFake((_req, res) => {
      calls++;
      sse(res);
      if (calls > 1) event(res, envelope(parsed(BTC, "1", 1)));
    });
    const errors: AstraError[] = [];
    const sub = track(
      new AstraClient({ baseUrl: fake.url }).subscribe([BTC], { transport: "sse", idleTimeoutMs: 150, ...fast, onError: (e) => errors.push(e) }),
    );
    await take(sub, 1);
    expect(errors[0]?.name).toBe("AstraTimeoutError");
  });

  it("drops a malformed event and keeps streaming", async () => {
    fake = await startFake((_req, res) => {
      sse(res);
      res.write("data: {not json\n\n");
      event(res, envelope({ ...parsed(BTC, "1", 1), price: { price: "1.5", conf: "0", expo: -8, publish_time: 1 } }));
      event(res, envelope(parsed(BTC, "2", 2)));
    });
    const errors: AstraError[] = [];
    const sub = track(new AstraClient({ baseUrl: fake.url }).subscribe([BTC], { transport: "sse", onError: (e) => errors.push(e) }));
    expect((await take(sub, 1))[0]?.price.price).toBe("2");
    expect(errors).toHaveLength(2);
    expect(sub.stats.invalid).toBe(2);
  });

  it("refuses benchmarksOnly over WebSocket and sends it over SSE", async () => {
    fake = await startFake((_req, res) => {
      sse(res);
      event(res, envelope(parsed(BTC, "1", 1)));
    });
    const c = new AstraClient({ baseUrl: fake.url });
    expect(() => c.subscribe([BTC], { benchmarksOnly: true })).toThrow(/SSE/);
    await take(track(c.subscribe([BTC], { transport: "sse", benchmarksOnly: true })), 1);
    expect(fake.requests[0]!.searchParams.get("benchmarks_only")).toBe("true");
  });

  it("refuses more ids than fit a URL and points to WebSocket", async () => {
    fake = await startFake((_req, res) => sse(res));
    const c = new AstraClient({ baseUrl: fake.url });
    const ids = Array.from({ length: MAX_IDS_PER_URL + 1 }, (_, i) => i.toString(16).padStart(64, "0"));
    expect(() => c.subscribe(ids, { transport: "sse" })).toThrow(AstraValidationError);
    expect(() => c.subscribe(ids, { transport: "sse" })).toThrow(/at most 200, got 201; use transport "ws"/);
    expect(fake.requests).toHaveLength(0);
  });
});

const wsImpl = WebSocket as unknown as WebSocketConstructor;

describe("WebSocket subscription", () => {
  it("subscribes to more ids than fit a URL", async () => {
    const received: Array<{ ids: string[] }> = [];
    const ids = Array.from({ length: MAX_IDS_PER_URL + 1 }, (_, i) => i.toString(16).padStart(64, "0"));
    fake = await startFake(
      () => undefined,
      (ws) => {
        ws.on("message", (raw) => {
          received.push(JSON.parse(String(raw)) as { ids: string[] });
          ws.send(JSON.stringify({ type: "response", status: "success" }));
          ws.send(wsUpdate(ids[0]!, "1", 1));
        });
      },
    );
    const sub = track(new AstraClient({ baseUrl: fake.url, WebSocket: wsImpl }).subscribe(ids));
    expect((await take(sub, 1))[0]?.id).toBe(ids[0]);
    expect(received[0]!.ids).toEqual(ids);
  });

  it("subscribes, acks, streams and closes cleanly without leaking timers", async () => {
    const received: unknown[] = [];
    fake = await startFake(
      () => undefined,
      (ws) => {
        ws.on("message", (raw) => {
          received.push(JSON.parse(String(raw)));
          ws.send(JSON.stringify({ type: "response", status: "success" }));
          ws.send(wsUpdate(BTC, "1", 1));
          ws.send(wsUpdate(ETH, "2", 1));
        });
      },
    );
    const before = timers();
    const sub = new AstraClient({ baseUrl: fake.url, WebSocket: wsImpl }).subscribe([`0x${BTC}`, ETH], { channel: "fixed_rate@200ms" });
    const got = await take(sub, 2);
    expect(got.map((u) => u.id)).toEqual([BTC, ETH]);
    expect(got[0]?.metadata).toEqual({ receiveTime: 1, prevPublishTime: 0 });
    expect(received[0]).toEqual({ type: "subscribe", ids: [BTC, ETH], verbose: true, binary: false, ignore_invalid_price_ids: false });
    expect(fake.requests[0]!.searchParams.get("channel")).toBe("fixed_rate@200ms");
    sub.close();
    await sub.done;
    expect(sub.connectionState).toBe("closed");
    await waitFor(() => fake!.sockets.size === 0);
    expect(timers()).toBeLessThanOrEqual(before);
  });

  it("ends the iterator when the loop breaks", async () => {
    fake = await startFake(
      () => undefined,
      (ws) => ws.on("message", () => {
        ws.send(JSON.stringify({ type: "response", status: "success" }));
        ws.send(wsUpdate(BTC, "1", 1));
      }),
    );
    const sub = new AstraClient({ baseUrl: fake.url, WebSocket: wsImpl }).subscribe([BTC]);
    for await (const u of sub) {
      expect(u.id).toBe(BTC);
      break;
    }
    await sub.done;
    expect(sub.connectionState).toBe("closed");
  });

  it("treats a refused subscription as fatal", async () => {
    fake = await startFake(
      () => undefined,
      (ws) => ws.on("message", () => ws.send(JSON.stringify({ type: "response", status: "error", error: `Price feed(s) with id(s) ${BTC} not found` }))),
    );
    const sub = track(new AstraClient({ baseUrl: fake.url, WebSocket: wsImpl }).subscribe([BTC], fast));
    await expect(take(sub, 1)).rejects.toThrow(AstraSubscriptionError);
    expect(fake.wsConnections).toBe(1);
  });

  it("resubscribes after the server closes, and keeps later error responses non-fatal", async () => {
    let connects = 0;
    fake = await startFake(
      () => undefined,
      (ws) => {
        connects++;
        const n = connects;
        ws.on("message", () => {
          ws.send(JSON.stringify({ type: "response", status: "success" }));
          if (n === 1) {
            ws.send(wsUpdate(BTC, "1", 1));
            ws.send(JSON.stringify({ type: "response", status: "error", error: "Connection timeout reached, reconnect" }));
            ws.close(1000);
          } else {
            ws.send(wsUpdate(BTC, "1", 1));
            ws.send(wsUpdate(BTC, "2", 2));
          }
        });
      },
    );
    const errors: AstraError[] = [];
    const sub = track(new AstraClient({ baseUrl: fake.url, WebSocket: wsImpl }).subscribe([BTC], { ...fast, onError: (e) => errors.push(e) }));
    const got = await take(sub, 2);
    expect(got.map((u) => u.price.price)).toEqual(["1", "2"]);
    expect(connects).toBe(2);
    expect(sub.stats.duplicates).toBe(1);
    expect(errors.map((e) => e.message)).toContain("Astra: Connection timeout reached, reconnect");
  });

  it("reconnects after an abnormal close", async () => {
    let connects = 0;
    fake = await startFake(
      () => undefined,
      (ws) => {
        connects++;
        const n = connects;
        ws.on("message", () => {
          ws.send(JSON.stringify({ type: "response", status: "success" }));
          if (n === 1) ws.close(1008, "slow consumer");
          else ws.send(wsUpdate(BTC, "1", 1));
        });
      },
    );
    const errors: AstraError[] = [];
    const sub = track(new AstraClient({ baseUrl: fake.url, WebSocket: wsImpl }).subscribe([BTC], { ...fast, onError: (e) => errors.push(e) }));
    await take(sub, 1);
    expect(errors[0]?.message).toContain("1008: slow consumer");
  });

  it("sends a heartbeat when idle and reconnects a half-open socket", async () => {
    const messages: string[] = [];
    let connects = 0;
    fake = await startFake(
      () => undefined,
      (ws) => {
        connects++;
        const n = connects;
        ws.on("message", (raw) => {
          messages.push(String(raw));
          if (messages.length === 1 || n > 1) ws.send(JSON.stringify({ type: "response", status: "success" }));
          if (n > 1) ws.send(wsUpdate(BTC, "1", 1));
        });
      },
    );
    const errors: AstraError[] = [];
    const sub = track(
      new AstraClient({ baseUrl: fake.url, WebSocket: wsImpl }).subscribe([BTC], { idleTimeoutMs: 200, ...fast, onError: (e) => errors.push(e) }),
    );
    await take(sub, 1);
    expect(messages[1]).toBe(JSON.stringify({ type: "unsubscribe", ids: [] }));
    expect(errors[0]?.name).toBe("AstraTimeoutError");
    expect(connects).toBe(2);
  });

  it("drops oversized, malformed and unrequested messages", async () => {
    fake = await startFake(
      () => undefined,
      (ws) => ws.on("message", () => {
        ws.send(JSON.stringify({ type: "response", status: "success" }));
        ws.send("x".repeat(2048));
        ws.send("{broken");
        ws.send(JSON.stringify({ type: "price_update", price_feed: { id: BTC, price: { price: "abc" } } }));
        ws.send(JSON.stringify({ type: "future_event", payload: 1 }));
        ws.send(wsUpdate(ETH, "9", 1));
        ws.send(wsUpdate(BTC, "1", 1));
      }),
    );
    const errors: AstraError[] = [];
    const sub = track(
      new AstraClient({ baseUrl: fake.url, WebSocket: wsImpl }).subscribe([BTC], { maxMessageBytes: 1024, onError: (e) => errors.push(e) }),
    );
    const got = await take(sub, 1);
    expect(got[0]?.id).toBe(BTC);
    expect(errors.map((e) => e.name)).toEqual(["AstraValidationError", "AstraValidationError", "AstraValidationError"]);
  });

  it("coalesces a slow consumer's backlog to the latest price per feed", async () => {
    fake = await startFake(
      () => undefined,
      (ws) => ws.on("message", () => {
        ws.send(JSON.stringify({ type: "response", status: "success" }));
        for (let i = 1; i <= 50; i++) ws.send(wsUpdate(BTC, String(i), i));
        ws.send(wsUpdate(ETH, "7", 1));
      }),
    );
    const sub = track(new AstraClient({ baseUrl: fake.url, WebSocket: wsImpl }).subscribe([BTC, ETH]));
    await waitFor(() => sub.stats.coalesced === 49);
    await new Promise((r) => setTimeout(r, 50));
    const got = await take(sub, 2);
    expect(got.map((u) => [u.id, u.price.price])).toEqual([
      [BTC, "50"],
      [ETH, "7"],
    ]);
  });

  it("closes when the caller's signal aborts", async () => {
    fake = await startFake(
      () => undefined,
      (ws) => ws.on("message", () => ws.send(JSON.stringify({ type: "response", status: "success" }))),
    );
    const ctrl = new AbortController();
    const sub = new AstraClient({ baseUrl: fake.url, WebSocket: wsImpl }).subscribe([BTC], { signal: ctrl.signal });
    await waitFor(() => sub.connectionState === "open");
    ctrl.abort();
    await sub.done;
    expect(await take(sub, 1)).toEqual([]);
  });

  it("uses the global WebSocket by default", async () => {
    fake = await startFake(
      () => undefined,
      (ws) => ws.on("message", () => {
        ws.send(JSON.stringify({ type: "response", status: "success" }));
        ws.send(wsUpdate(BTC, "1", 1));
      }),
    );
    const sub = track(new AstraClient({ baseUrl: fake.url }).subscribe([BTC]));
    expect((await take(sub, 1))[0]?.id).toBe(BTC);
  });

  it("wakes every concurrent consumer when the subscription closes", async () => {
    fake = await startFake(
      () => undefined,
      (ws) => ws.on("message", () => ws.send(JSON.stringify({ type: "response", status: "success" }))),
    );
    const sub = new AstraClient({ baseUrl: fake.url, WebSocket: wsImpl }).subscribe([BTC]);
    await waitFor(() => sub.connectionState === "open");
    const a = take(sub, 1);
    const b = take(sub, 1);
    await new Promise((r) => setTimeout(r, 20));
    sub.close();
    expect(await Promise.all([a, b])).toEqual([[], []]);
    await sub.done;
  });

  it("turns a throwing send into a reconnect instead of an uncaught exception", async () => {
    let instances = 0;
    class ThrowingSocket {
      readyState = 0;
      onopen: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      onclose: ((ev: { code: number; reason: string }) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      constructor(_url: string) {
        instances++;
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.({});
        }, 1);
      }
      send(_data: string): void {
        throw new Error("socket is closing");
      }
      close(): void {
        this.readyState = 3;
      }
    }
    const errors: AstraError[] = [];
    const sub = track(
      new AstraClient({ WebSocket: ThrowingSocket as unknown as WebSocketConstructor }).subscribe([BTC], {
        ...fast,
        onError: (e) => errors.push(e),
      }),
    );
    await waitFor(() => instances >= 2);
    expect(errors[0]?.message).toMatch(/send failed: socket is closing/);
    expect(sub.error).toBeUndefined();
  });
});
