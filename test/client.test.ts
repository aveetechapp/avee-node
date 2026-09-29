import { afterEach, describe, expect, it } from "vitest";
import { AveeApiError, AveeClient, AveeConnectionError, AveeTimeoutError, AveeValidationError, DEFAULT_BASE_URL, paginate } from "../src/index.js";
import { activeTimers, type Fake, fake, json, pair, problem, valid } from "./fake.js";

const servers: Fake[] = [];
async function serve(handler: Parameters<typeof fake>[0]): Promise<Fake> {
  const s = await fake(handler);
  servers.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("validation", () => {
  it("refuses bad input before any request", async () => {
    const s = await serve((_r, res) => json(res, 200, {}));
    const c = new AveeClient({ baseUrl: s.baseUrl });
    const bad: Array<() => Promise<unknown>> = [
      () => c.pair("", "0xabc"),
      () => c.pair("base", ".."),
      () => c.pair(-1, "0xabc"),
      () => c.pairs({ limit: 101 }),
      () => c.pairs({ limit: 1.5 }),
      () => c.pairs({ chains: Array.from({ length: 33 }, () => "base") }),
      () => c.pairs({ chains: ["a,b"] }),
      () => c.search({ q: "" }),
      () => c.tokenByID("nope"),
      () => c.pairBatch({ items: [] }),
      () => c.pairBatch({ items: Array.from({ length: 51 }, () => ({ chain: "base", address: "0xa" })) }),
      () => c.tokenBatch({ items: Array.from({ length: 201 }, () => ({ chain: "base", address: "0xa" })) }),
      () => c.wallets({ chain: "base", min_win_rate: 1.5 }),
      () => c.pairs({ min_liquidity_usd: Number.NaN }),
    ];
    for (const run of bad) await expect(run()).rejects.toBeInstanceOf(AveeValidationError);
    expect(s.requests).toHaveLength(0);
  });

  it("accepts numeric chain ids and escapes path parameters", async () => {
    const s = await serve((_r, res) => json(res, 200, valid("WalletProfile")));
    await new AveeClient({ baseUrl: s.baseUrl }).walletProfile(950000, "EQ/A B?");
    expect(s.requests[0]!.url.pathname).toBe("/api/v1/chains/950000/wallets/EQ%2FA%20B%3F");
  });

  it("checks its options", () => {
    expect(() => new AveeClient({ baseUrl: "ftp://x" })).toThrow(AveeValidationError);
    expect(() => new AveeClient({ baseUrl: "https://x/?a=1" })).toThrow(AveeValidationError);
    expect(() => new AveeClient({ apiKey: "a\nb" })).toThrow(AveeValidationError);
    expect(() => new AveeClient({ timeoutMs: -1 })).toThrow(AveeValidationError);
    expect(DEFAULT_BASE_URL).toMatch(/^https:\/\/.+\/api\/v1$/);
  });
});

describe("pagination", () => {
  it("walks every page lazily and forwards the filters", async () => {
    const s = await serve((r, res) => {
      const cursor = r.url.searchParams.get("cursor");
      if (!cursor) return json(res, 200, { items: [pair("a1"), pair("a2")], next_cursor: "p2" });
      if (cursor === "p2") return json(res, 200, { items: [pair("a3")], next_cursor: "p3" });
      return json(res, 200, { items: [pair("a4")] });
    });
    const c = new AveeClient({ baseUrl: s.baseUrl });
    const got: string[] = [];
    for await (const p of c.iterPairs({ chains: ["base"], limit: 2 })) got.push(p.pair_address);
    expect(got).toEqual(["a1", "a2", "a3", "a4"]);
    expect(s.requests).toHaveLength(3);
    expect(s.requests[1]!.url.search).toContain("cursor=p2");
    expect(s.requests[1]!.url.searchParams.get("chains")).toBe("base");

    for await (const _ of c.iterPairs()) break;
    expect(s.requests).toHaveLength(4);

    const limited: string[] = [];
    for await (const p of c.iterPairs({}, { maxPages: 2 })) limited.push(p.pair_address);
    expect(limited).toEqual(["a1", "a2", "a3"]);
  });

  it("stops on a repeated cursor", async () => {
    const s = await serve((_r, res) => json(res, 200, { items: [pair("a")], next_cursor: "same" }));
    const seen: unknown[] = [];
    await expect(async () => {
      for await (const p of new AveeClient({ baseUrl: s.baseUrl }).iterTrending()) seen.push(p);
    }).rejects.toBeInstanceOf(AveeValidationError);
    expect(seen).toHaveLength(2);
  });

  it("is exported for custom page walks", async () => {
    const pages = [{ items: [1, 2], next_cursor: "b" }, { items: [3] }];
    const out: number[] = [];
    for await (const n of paginate(async (c) => pages[c ? 1 : 0]!, undefined, undefined)) out.push(n);
    expect(out).toEqual([1, 2, 3]);
  });
});

describe("errors and retries", () => {
  it("turns problem+json into AveeApiError and does not retry a 404", async () => {
    const s = await serve((_r, res) => {
      res.writeHead(404, { "content-type": "application/problem+json" });
      res.end(
        JSON.stringify({ type: "t", title: "chain not found", status: 404, code: "chain_not_found", detail: "no chain nope", param: "chain", request_id: "r-9" }),
      );
    });
    const err = await new AveeClient({ baseUrl: s.baseUrl }).pair("nope", "0xabc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AveeApiError);
    const e = err as AveeApiError;
    expect([e.status, e.code, e.detail, e.param, e.requestId, e.retryable]).toEqual([404, "chain_not_found", "no chain nope", "chain", "r-9", false]);
    expect(s.requests).toHaveLength(1);
  });

  it("retries GETs on 429 and 5xx, honouring Retry-After", async () => {
    const s = await serve((_r, res, n) => {
      if (n === 1) return problem(res, 429, "rate_limited", "slow down", { "retry-after": "1" });
      if (n === 2) return problem(res, 503, "upstream_unavailable", "later");
      json(res, 200, { status: "ok" });
    });
    const started = Date.now();
    await expect(new AveeClient({ baseUrl: s.baseUrl }).status()).resolves.toEqual({ status: "ok" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(s.requests).toHaveLength(3);
  });

  it("never retries a POST", async () => {
    const s = await serve((_r, res) => problem(res, 503, "upstream_unavailable", "later"));
    await expect(new AveeClient({ baseUrl: s.baseUrl }).pairBatch({ items: [{ chain: "base", address: "0xa" }] })).rejects.toBeInstanceOf(AveeApiError);
    expect(s.requests).toHaveLength(1);
  });

  it("returns a Retry-After beyond the cap instead of waiting", async () => {
    const s = await serve((_r, res) => problem(res, 429, "rate_limited", "later", { "retry-after": "120" }));
    const err = (await new AveeClient({ baseUrl: s.baseUrl, maxRetryDelayMs: 1000 }).chains().catch((e: unknown) => e)) as AveeApiError;
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(120_000);
    expect(s.requests).toHaveLength(1);
  });

  it("times out, retries, then reports", async () => {
    const s = await serve(() => undefined);
    const timers = activeTimers();
    await expect(new AveeClient({ baseUrl: s.baseUrl, timeoutMs: 50, maxRetries: 1, maxRetryDelayMs: 10 }).status()).rejects.toBeInstanceOf(AveeTimeoutError);
    expect(s.requests).toHaveLength(2);
    expect(activeTimers()).toBeLessThanOrEqual(timers);
  });

  it("reports connection failures", async () => {
    await expect(new AveeClient({ baseUrl: "http://127.0.0.1:1/api/v1", maxRetries: 0 }).status()).rejects.toBeInstanceOf(AveeConnectionError);
  });

  it("honours an abort signal", async () => {
    const s = await serve(() => undefined);
    const ctl = new AbortController();
    const p = new AveeClient({ baseUrl: s.baseUrl }).status({ signal: ctl.signal });
    setTimeout(() => ctl.abort(new Error("stop")), 20);
    await expect(p).rejects.toThrow("stop");
  });

  it("refuses an oversized response", async () => {
    const s = await serve((_r, res) => json(res, 200, { status: "x".repeat(4096) }));
    await expect(new AveeClient({ baseUrl: s.baseUrl, maxResponseBytes: 1024 }).status()).rejects.toBeInstanceOf(AveeValidationError);
  });
});

describe("rate limits and keys", () => {
  it("exposes the headers of the last response and sends the key", async () => {
    const s = await serve((_r, res) =>
      json(res, 200, { status: "ok" }, {
        "ratelimit-policy": '"plan";q=5;w=1;burst=20',
        ratelimit: '"plan";r=19;t=1',
        "x-ratelimit-limit": "5",
        "x-request-id": "abc",
      }),
    );
    const c = new AveeClient({ baseUrl: s.baseUrl, apiKey: "k1" });
    await c.status();
    expect(c.lastResponse).toMatchObject({ operation: "status", status: 200, requestId: "abc", rateLimit: { limit: 5, remaining: 19, resetSeconds: 1 } });
    expect(c.lastResponse?.rateLimit.policy).toContain("q=5");
    expect(s.requests[0]!.headers["x-api-key"]).toBe("k1");
  });
});
