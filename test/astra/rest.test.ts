import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  AstraClient,
  AstraConnectionError,
  AstraHttpError,
  AstraTimeoutError,
  AstraValidationError,
  FEED_IDS_PER_REQUEST,
  MAX_IDS_PER_REQUEST,
  MAX_IDS_PER_URL,
} from "../../src/astra/index.js";
import { BTC, BTC_ASTRA, ETH, envelope, type FakeAstra, type Handler, json, parsed, startFake, text } from "./fake-astra.js";

let fake: FakeAstra | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function client(handler: Handler, options: ConstructorParameters<typeof AstraClient>[0] = {}) {
  fake = await startFake(handler);
  return new AstraClient({ baseUrl: fake.url, maxRetryDelayMs: 2000, ...options });
}

const feedMeta = {
  id: BTC,
  attributes: {
    asset_type: "Crypto",
    description: "d",
    display_symbol: "BTC/USD",
    quote_currency: "USD",
    symbol: "Crypto.BTC/USD",
    min_channel: "real_time",
    astra_id: BTC_ASTRA,
  },
  market_hours: { is_open: true, next_open: null, next_close: null },
};

describe("REST", () => {
  it("lists feeds with the filters as query parameters", async () => {
    const c = await client((_req, res) => json(res, 200, [feedMeta]));
    const feeds = await c.priceFeeds({ query: "btc", assetType: "crypto" });
    expect(feeds.map((f) => f.symbol)).toEqual(["Crypto.BTC/USD"]);
    const url = fake!.requests[0]!;
    expect(url.pathname).toBe("/v2/price_feeds");
    expect(url.searchParams.get("query")).toBe("btc");
    expect(url.searchParams.get("asset_type")).toBe("crypto");
  });

  it("keeps a base path prefix", async () => {
    fake = await startFake((_req, res) => json(res, 200, feedMeta));
    const c = new AstraClient({ baseUrl: `${fake.url}/hermes` });
    await c.priceFeed(`0x${BTC.toUpperCase()}`);
    expect(fake.requests[0]!.pathname).toBe(`/hermes/v2/price_feeds/${BTC}`);
  });

  it("fetches many latest prices in one request", async () => {
    const c = await client((_req, res) => json(res, 200, envelope(parsed(BTC, "1", 5), parsed(ETH, "2", 5))));
    const prices = await c.latestPrices([BTC, `0x${ETH}`, BTC], { ignoreInvalid: true });
    expect(prices.map((p) => p.id)).toEqual([BTC, ETH]);
    expect(fake!.requests).toHaveLength(1);
    const url = fake!.requests[0]!;
    expect(url.searchParams.getAll("ids[]")).toEqual([BTC, ETH]);
    expect(url.searchParams.get("ignore_invalid_price_ids")).toBe("true");
  });

  it("validates ids before any request", async () => {
    const c = await client((_req, res) => json(res, 200, envelope()));
    await expect(c.latestPrices(["nope"])).rejects.toThrow(AstraValidationError);
    const many = Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(64, "0"));
    await expect(c.pricesAt(1, many)).rejects.toThrow(/at most 100/);
    await expect(c.pricesInInterval(1, 61, [BTC])).rejects.toThrow(/intervalSeconds/);
    await expect(c.pricesAt(-1, [BTC])).rejects.toThrow(/publishTime/);
    expect(fake!.requests).toHaveLength(0);
  });

  it("reads prices at a time and over an interval", async () => {
    const c = await client((_req, res, url) => {
      if (url.pathname === "/v2/updates/price/100") return json(res, 200, envelope(parsed(BTC, "1", 100)));
      json(res, 200, [envelope(parsed(BTC, "1", 100)), envelope(parsed(BTC, "2", 101))]);
    });
    expect((await c.pricesAt(100, [BTC]))[0]?.price.publishTime).toBe(100);
    const series = await c.pricesInInterval(100, 1, [BTC], { unique: false });
    expect(series.map((u) => u.price.price)).toEqual(["1", "2"]);
    expect(fake!.requests[1]!.pathname).toBe("/v2/updates/price/100/1");
    expect(fake!.requests[1]!.searchParams.get("unique")).toBe("false");
  });

  it("reads native feeds, status and candles", async () => {
    const live = { status: "trading", price: "1", conf: "0", expo: -2, publish_time: 1, timestamp_ms: 1000, served_publish_time: 1, sources: 3 };
    const c = await client((_req, res, url) => {
      if (url.pathname === "/v1/feeds") return json(res, 200, [{ id: BTC_ASTRA, pyth_id: BTC, symbol: "Crypto.BTC/USD", category: "crypto", attributes: {}, live }]);
      if (url.pathname === "/v1/status") return json(res, 200, { ready: true, feeds: [] });
      json(res, 200, { s: "ok", t: [0], o: [1], h: [2], l: [0.5], c: [1.5], v: [0] });
    });
    expect((await c.feeds({ category: "crypto" }))[0]?.live.price?.toNumber()).toBe(0.01);
    expect(fake!.requests[0]!.searchParams.get("category")).toBe("crypto");
    expect(await c.status()).toEqual({ ready: true, feeds: [] });
    expect(await c.candles({ feed: "Crypto.BTC/USD", resolution: "60", from: 0, to: 60 })).toHaveLength(1);
    const q = fake!.requests[2]!.searchParams;
    expect([q.get("feed"), q.get("resolution"), q.get("from"), q.get("to")]).toEqual(["Crypto.BTC/USD", "60", "0", "60"]);
    await expect(c.candles({ feed: "x", resolution: "60", from: 10, to: 5 })).rejects.toThrow(/before/);
  });

  it("surfaces a Hermes text error without retrying", async () => {
    const c = await client((_req, res) => text(res, 404, `Price ids not found: ${BTC}`));
    const err = await c.latestPrices([BTC]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AstraHttpError);
    expect((err as AstraHttpError).status).toBe(404);
    expect((err as AstraHttpError).body).toContain("Price ids not found");
    expect((err as AstraHttpError).retryable).toBe(false);
    expect(fake!.requests).toHaveLength(1);
  });

  it("surfaces a UDF error message", async () => {
    const c = await client((_req, res) => json(res, 404, { s: "error", errmsg: "unknown feed" }));
    await expect(c.candles({ feed: "nope", resolution: "60", from: 0, to: 1 })).rejects.toThrow(/unknown feed/);
  });

  it("retries a 503 problem and returns the problem when retries run out", async () => {
    const problem = { type: "about:blank", title: "History unavailable", status: 503, detail: "charts database down" };
    const c = await client((_req, res) => json(res, 503, problem, { "content-type": "application/problem+json" }), { maxRetries: 2 });
    const err = (await c.pricesAt(1, [BTC]).catch((e: unknown) => e)) as AstraHttpError;
    expect(err).toBeInstanceOf(AstraHttpError);
    expect(err.problem).toEqual(problem);
    expect(err.message).toContain("charts database down");
    expect(fake!.requests).toHaveLength(3);
  });

  it("honours Retry-After on 429", async () => {
    let calls = 0;
    const c = await client((_req, res) => {
      calls++;
      if (calls === 1) return text(res, 429, "slow down", { "retry-after": "1" });
      json(res, 200, envelope(parsed(BTC, "1", 1)));
    });
    const started = Date.now();
    await c.latestPrices([BTC]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(calls).toBe(2);
  });

  it("does not wait for a Retry-After beyond the cap", async () => {
    const c = await client((_req, res) => text(res, 429, "later", { "retry-after": "120" }));
    const err = (await c.latestPrices([BTC]).catch((e: unknown) => e)) as AstraHttpError;
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(120_000);
    expect(fake!.requests).toHaveLength(1);
  });

  it("times out a slow request and retries it", async () => {
    let calls = 0;
    const c = await client(
      (_req, res) => {
        calls++;
        setTimeout(() => json(res, 200, envelope()), 500);
      },
      { timeoutMs: 100, maxRetries: 1 },
    );
    await expect(c.latestPrices([BTC])).rejects.toThrow(AstraTimeoutError);
    expect(calls).toBe(2);
  });

  it("passes a caller abort through without retrying", async () => {
    const c = await client((_req, res) => setTimeout(() => json(res, 200, envelope()), 500));
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error("stop")), 50);
    await expect(c.latestPrices([BTC], { signal: ctrl.signal })).rejects.toThrow("stop");
    expect(fake!.requests).toHaveLength(1);
  });

  it("wraps a refused connection", async () => {
    const c = new AstraClient({ baseUrl: "http://127.0.0.1:1", maxRetries: 0 });
    await expect(c.status()).rejects.toThrow(AstraConnectionError);
  });

  it("bounds the response size", async () => {
    const c = await client((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([feedMeta, feedMeta, feedMeta]));
    }, { maxResponseBytes: 256 });
    await expect(c.priceFeeds()).rejects.toThrow(/exceeds 256 bytes/);
  });

  it("rejects a body that is not JSON or not the expected shape", async () => {
    const c = await client((_req, res, url) => {
      if (url.pathname === "/v1/status") return text(res, 200, "<html>");
      json(res, 200, { binary: {}, parsed: [{ id: BTC, price: { price: "1.5", conf: "0", expo: -8, publish_time: 1 } }] });
    });
    await expect(c.status()).rejects.toThrow(/not JSON/);
    await expect(c.latestPrices([BTC])).rejects.toThrow(AstraValidationError);
  });

  it("validates its options", () => {
    expect(() => new AstraClient({ baseUrl: "ftp://x" })).toThrow(AstraValidationError);
    expect(() => new AstraClient({ baseUrl: "not a url" })).toThrow(AstraValidationError);
    expect(() => new AstraClient({ timeoutMs: 0 })).toThrow(AstraValidationError);
    for (const maxRetries of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => new AstraClient({ maxRetries })).toThrow(AstraValidationError);
    }
    expect(() => new AstraClient({ maxRetries: 1.7 })).not.toThrow();
  });

  it("leaves no listener on a reused signal and no pending timer after the calls", async () => {
    const c = await client((_req, res) => json(res, 200, envelope(parsed(BTC, "1", 1))));
    const ctrl = new AbortController();
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    for (let i = 0; i < 30; i++) await c.latestPrices([BTC], { signal: ctrl.signal });
    expect(getEventListeners(ctrl.signal, "abort")).toHaveLength(0);
    expect(process.getActiveResourcesInfo().filter((r) => r === "Timeout").length).toBeLessThanOrEqual(before);
  });

  it("rejects at once with the reason of an already aborted signal", async () => {
    const c = await client((_req, res) => json(res, 200, envelope()));
    const ctrl = new AbortController();
    ctrl.abort(new Error("gone"));
    await expect(c.latestPrices([BTC], { signal: ctrl.signal })).rejects.toThrow("gone");
    expect(fake!.requests).toHaveLength(0);
  });
});

describe("feedIds", () => {
  const btcEntry = { symbol: "Crypto.BTC/USD", asset_type: "Crypto", category: "crypto", astra_id: BTC_ASTRA, pyth_id: BTC };
  const rhEntry = { symbol: "Equity.RH.TSLA/USD", asset_type: "Equity", category: "equity", astra_id: ETH };

  it("reads the whole map without a filter", async () => {
    const c = await client((_req, res) => json(res, 200, { items: [btcEntry, rhEntry] }));
    const map = await c.feedIds();
    expect(map.items).toEqual([
      { symbol: "Crypto.BTC/USD", assetType: "Crypto", category: "crypto", astraId: BTC_ASTRA, pythId: BTC },
      { symbol: "Equity.RH.TSLA/USD", assetType: "Equity", category: "equity", astraId: ETH },
    ]);
    expect(map.missing).toBeUndefined();
    const url = fake!.requests[0]!;
    expect(url.pathname).toBe("/v1/feed-ids");
    expect([...url.searchParams.keys()]).toEqual([]);
  });

  it("sends normalised, de-duplicated ids in one request and returns missing", async () => {
    const unknown = "11".repeat(32);
    const c = await client((_req, res) => json(res, 200, { items: [btcEntry], missing: [unknown] }));
    const map = await c.feedIds({ pythIds: [`0x${BTC.toUpperCase()}`, BTC, unknown], astraIds: [ETH], category: "crypto" });
    expect(map.items.map((i) => i.pythId)).toEqual([BTC]);
    expect(map.missing).toEqual([unknown]);
    expect(fake!.requests).toHaveLength(1);
    const url = fake!.requests[0]!;
    expect(url.searchParams.get("pyth_ids")).toBe(`${BTC},${unknown}`);
    expect(url.searchParams.get("astra_ids")).toBe(ETH);
    expect(url.searchParams.get("category")).toBe("crypto");
  });

  it("splits a long list into chunks that fit a proxy's request line and merges them sorted", async () => {
    const ids = Array.from({ length: FEED_IDS_PER_REQUEST + 1 }, (_, i) => i.toString(16).padStart(64, "0"));
    const c = await client((_req, res, url) => {
      const asked = (url.searchParams.get("pyth_ids") ?? "").split(",").filter(Boolean);
      if (asked.length > 1) return json(res, 200, { items: [rhEntry, btcEntry], missing: asked.slice(1) });
      json(res, 200, { items: [btcEntry], missing: asked });
    });
    const map = await c.feedIds({ pythIds: ids });
    expect(fake!.requests).toHaveLength(2);
    expect(fake!.requests[0]!.searchParams.get("pyth_ids")!.split(",")).toHaveLength(FEED_IDS_PER_REQUEST);
    expect(map.items.map((i) => i.symbol)).toEqual(["Crypto.BTC/USD", "Equity.RH.TSLA/USD"]);
    expect(map.missing).toEqual(ids.slice(1));
  });

  it("answers an empty filter without a request and rejects a malformed id before any", async () => {
    const c = await client((_req, res) => json(res, 200, { items: [] }));
    await expect(c.feedIds({ pythIds: [] })).resolves.toEqual({ items: [], missing: [] });
    await expect(c.feedIds({ astraIds: ["nope"] })).rejects.toThrow(AstraValidationError);
    expect(fake!.requests).toHaveLength(0);
  });

  it("surfaces the server's 400 problem without retrying", async () => {
    const c = await client((_req, res) => {
      res.writeHead(400, { "content-type": "application/problem+json" });
      res.end(JSON.stringify({ type: "about:blank", title: "Bad Request", status: 400, detail: "Too many feed ids, the limit is 500" }));
    });
    await expect(c.feedIds({ pythIds: [BTC] })).rejects.toThrow(AstraHttpError);
    expect(fake!.requests).toHaveLength(1);
  });

  it("rejects a malformed map", async () => {
    const c = await client((_req, res) => json(res, 200, { items: [{ symbol: "x" }] }));
    await expect(c.feedIds()).rejects.toThrow(AstraValidationError);
  });

  it("packs both lists into one URL budget and merges items and missing once", async () => {
    const gone = "33".repeat(32);
    const pyth = Array.from({ length: 150 }, (_, i) => (i + 1000).toString(16).padStart(64, "0"));
    const astra = Array.from({ length: 100 }, (_, i) => (i + 2000).toString(16).padStart(64, "0"));
    const c = await client((_req, res, url) => {
      if (url.searchParams.has("pyth_ids")) return json(res, 200, { items: [rhEntry, btcEntry], missing: [gone] });
      json(res, 200, { items: [btcEntry], missing: [gone] });
    });
    const map = await c.feedIds({ pythIds: pyth, astraIds: astra });
    expect(fake!.requests).toHaveLength(2);
    const [first, second] = fake!.requests.map((u) => u.searchParams);
    expect(first!.get("pyth_ids")!.split(",")).toHaveLength(150);
    expect(first!.get("astra_ids")!.split(",")).toHaveLength(50);
    expect(second!.has("pyth_ids")).toBe(false);
    expect(second!.get("astra_ids")).toBe(astra.slice(50).join(","));
    expect(map.items.map((i) => i.symbol)).toEqual(["Crypto.BTC/USD", "Equity.RH.TSLA/USD"]);
    expect(map.missing).toEqual([gone]);
  });

  it("answers a filtered map without missing with an empty missing list", async () => {
    const c = await client((_req, res) => json(res, 200, { items: [btcEntry] }));
    await expect(c.feedIds({ pythIds: [BTC] })).resolves.toMatchObject({ missing: [] });
  });

  it("rejects the whole call when a later chunk fails", async () => {
    const ids = Array.from({ length: MAX_IDS_PER_URL + 1 }, (_, i) => i.toString(16).padStart(64, "0"));
    const c = await client((_req, res) => {
      if (fake!.requests.length > 1) return text(res, 404, "gone");
      json(res, 200, { items: [btcEntry], missing: [] });
    });
    await expect(c.feedIds({ pythIds: ids })).rejects.toThrow(AstraHttpError);
    expect(fake!.requests).toHaveLength(2);
  });

  it("rejects a single string instead of a list", async () => {
    const c = await client((_req, res) => json(res, 200, { items: [] }));
    await expect(c.feedIds({ pythIds: BTC })).rejects.toThrow(/list/);
    expect(fake!.requests).toHaveLength(0);
  });
});

describe("status of one feed", () => {
  const entry = (stale: boolean) => ({ id: BTC_ASTRA, symbol: "Crypto.BTC/USD", status: "trading", age_seconds: stale ? 60 : 1, publish_time: 1, served_publish_time: 1, sources: 3, stale });

  it("sends the normalised id and returns a healthy report", async () => {
    const c = await client((_req, res) => json(res, 200, { ready: true, feeds: [entry(false)] }));
    const report = await c.status({ feed: `0x${BTC.toUpperCase()}` });
    expect(report.feeds[0]!.stale).toBe(false);
    expect(fake!.requests[0]!.searchParams.get("feed")).toBe(BTC);
  });

  it("returns the report on 503 instead of throwing or retrying", async () => {
    const c = await client((_req, res) => json(res, 503, { ready: true, feeds: [entry(true)] }));
    const report = await c.status({ feed: BTC });
    expect(report.feeds[0]!.stale).toBe(true);
    expect(fake!.requests).toHaveLength(1);
  });

  it("still retries a 503 that is not a report, and throws a 404", async () => {
    const c = await client((_req, res, url) => {
      if (url.searchParams.get("feed") === BTC) return text(res, 503, "upstream down");
      res.writeHead(404, { "content-type": "application/problem+json" });
      res.end(JSON.stringify({ type: "about:blank", title: "Not Found", status: 404, detail: "unknown feed" }));
    }, { maxRetries: 1, maxRetryDelayMs: 20 });
    await expect(c.status({ feed: BTC })).rejects.toThrow(AstraHttpError);
    expect(fake!.requests).toHaveLength(2);
    await expect(c.status({ feed: ETH })).rejects.toThrow(/unknown feed/);
    await expect(c.status({ feed: "nope" })).rejects.toThrow(AstraValidationError);
  });

  it("treats a 503 problem as an error, not a report", async () => {
    const c = await client((_req, res) => {
      res.writeHead(503, { "content-type": "application/problem+json" });
      res.end(JSON.stringify({ type: "about:blank", title: "Service Unavailable", status: 503, detail: "draining" }));
    }, { maxRetries: 1, maxRetryDelayMs: 20 });
    await expect(c.status({ feed: BTC })).rejects.toThrow(AstraHttpError);
    expect(fake!.requests).toHaveLength(2);
  });

  it("surfaces the server's 400 without retrying", async () => {
    const c = await client((_req, res) => {
      res.writeHead(400, { "content-type": "application/problem+json" });
      res.end(JSON.stringify({ type: "about:blank", title: "Bad Request", status: 400, detail: "malformed feed" }));
    });
    await expect(c.status({ feed: BTC })).rejects.toThrow(/malformed feed/);
    expect(fake!.requests).toHaveLength(1);
  });

  it("reads the whole report for an empty feed", async () => {
    const c = await client((_req, res) => json(res, 200, { ready: true, feeds: [] }));
    await c.status({ feed: "" });
    expect([...fake!.requests[0]!.searchParams.keys()]).toEqual([]);
  });

  it("keeps a plain 503 on the whole report an error", async () => {
    const c = await client((_req, res) => json(res, 503, { ready: true, feeds: [] }), { maxRetries: 0 });
    await expect(c.status()).rejects.toThrow(AstraHttpError);
  });
});

describe("latestPrices over the URL limit", () => {
  const idsOf = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => (i + offset).toString(16).padStart(64, "0"));
  const echo: Handler = (_req, res, url) => {
    const asked = url.searchParams.getAll("ids[]");
    json(res, 200, envelope(...asked.map((id) => parsed(id, "1", 5))));
  };

  it.each([
    [199, [199]],
    [200, [200]],
    [201, [200, 1]],
    [450, [200, 200, 50]],
  ])("splits %i ids into requests of %j", async (n, sizes) => {
    const c = await client(echo);
    const ids = idsOf(n);
    const prices = await c.latestPrices(ids);
    expect(fake!.requests.map((u) => u.searchParams.getAll("ids[]").length)).toEqual(sizes);
    expect(prices.map((p) => p.id)).toEqual(ids);
  });

  it("keeps the request order across chunks and repeats the flags on every chunk", async () => {
    const c = await client(echo);
    const ids = idsOf(300).reverse();
    const prices = await c.latestPrices(ids, { ignoreInvalid: true });
    expect(prices.map((p) => p.id)).toEqual(ids);
    expect(fake!.requests[0]!.searchParams.getAll("ids[]")).toEqual(ids.slice(0, MAX_IDS_PER_URL));
    expect(fake!.requests[1]!.searchParams.getAll("ids[]")).toEqual(ids.slice(MAX_IDS_PER_URL));
    expect(fake!.requests.map((u) => u.searchParams.get("ignore_invalid_price_ids"))).toEqual(["true", "true"]);
  });

  it("collapses duplicates that straddle a chunk boundary", async () => {
    const c = await client(echo);
    const ids = idsOf(MAX_IDS_PER_URL);
    const prices = await c.latestPrices([...ids, `0x${ids[0]!.toUpperCase()}`, ids[MAX_IDS_PER_URL - 1]!]);
    expect(fake!.requests).toHaveLength(1);
    expect(prices.map((p) => p.id)).toEqual(ids);
  });

  it("rejects the whole call when a later chunk fails", async () => {
    const c = await client((req, res, url) => {
      if (fake!.requests.length > 1) return text(res, 404, "Price ids not found: x");
      echo(req, res, url);
    });
    await expect(c.latestPrices(idsOf(201))).rejects.toThrow(AstraHttpError);
    expect(fake!.requests).toHaveLength(2);
  });

  it("still caps a call at the server's limit", async () => {
    const c = await client(echo);
    await expect(c.latestPrices(idsOf(MAX_IDS_PER_REQUEST + 1))).rejects.toThrow(/at most 500/);
    expect(fake!.requests).toHaveLength(0);
  });

  it("keeps FEED_IDS_PER_REQUEST as the same limit", () => {
    expect(FEED_IDS_PER_REQUEST).toBe(MAX_IDS_PER_URL);
  });
});
