import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AveeApiError, AveeClient, AveePaymentError, AveeTimeoutError, AveeValidationError, paginate, type Payer } from "../src/index.js";
import { CursorLoop } from "../src/request.js";
import { offerProblem } from "../src/x402.js";
import { activeTimers, type Fake, fake, json, pair, valid } from "./fake.js";

const servers: Fake[] = [];
async function serve(handler: Parameters<typeof fake>[0]): Promise<Fake> {
  const s = await fake(handler);
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64");

function offer(network: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: "exact",
    network,
    amount: "2000",
    maxAmountRequired: "2000",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payTo: "0x00000000000000000000000000000000000000b2",
    maxTimeoutSeconds: 60,
    ...overrides,
  };
}

function challenge(...accepts: unknown[]) {
  return { x402Version: 2, resource: { url: "https://api.preview.avee.tech/api/v1/chains" }, accepts };
}

function send402(res: ServerResponse, doc: unknown): void {
  res.writeHead(402, { "content-type": "application/json", "payment-required": b64(doc) });
  res.end(JSON.stringify(doc));
}

function refusingPayer(): Payer & { asked: number } {
  const payer = {
    asked: 0,
    sign: () => {
      payer.asked++;
      return null;
    },
  };
  return payer;
}

describe("redirects", () => {
  it("are never followed, so the key and a signature stay on the host", async () => {
    const other = await serve((_r, res) => json(res, 200, valid("StatusResponse")));
    const s = await serve((r, res) => {
      if (r.url.pathname === "/api/v1/chains" && !r.headers["payment-signature"]) return send402(res, challenge(offer("eip155:84532")));
      res.writeHead(307, { location: `${other.baseUrl}/steal` });
      res.end();
    });
    const c = new AveeClient({ baseUrl: s.baseUrl, apiKey: "k1", payer: { sign: () => ({ payload: { signature: "0x" } }) } });
    const plain = (await c.status().catch((e: unknown) => e)) as AveeApiError;
    expect(plain).toBeInstanceOf(AveeApiError);
    expect([plain.status, plain.retryable]).toEqual([307, false]);
    const paid = (await c.chains().catch((e: unknown) => e)) as AveeApiError;
    expect([paid.status, paid.paid]).toEqual([307, true]);
    expect(other.requests).toHaveLength(0);
    expect(s.requests).toHaveLength(3);
  });
});

describe("x402 boundary", () => {
  const unreadable: Array<[string, (res: ServerResponse) => void]> = [
    ["header not base64", (res) => res.writeHead(402, { "payment-required": "%%%" }).end(JSON.stringify(challenge(offer("eip155:84532"))))],
    ["header not JSON", (res) => res.writeHead(402, { "payment-required": b64("{not json") }).end()],
    ["header not UTF-8", (res) => res.writeHead(402, { "payment-required": Buffer.from([0xff, 0xfe, 0x7b]).toString("base64") }).end()],
    ["no accepts", (res) => send402(res, challenge())],
    ["accepts of the wrong type", (res) => send402(res, { x402Version: 2, accepts: ["exact"] })],
    ["body not JSON", (res) => res.writeHead(402).end("pay up")],
  ];
  it.each(unreadable)("refuses a challenge whose %s before the payer", async (_, write) => {
    const s = await serve((_r, res) => write(res));
    const payer = refusingPayer();
    const err = await new AveeClient({ baseUrl: s.baseUrl, payer }).chains().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AveePaymentError);
    expect(String(err)).toContain("unreadable");
    expect([payer.asked, s.requests.length]).toEqual([0, 1]);
  });

  const malformed: Array<[string, Record<string, unknown>]> = [
    ["zero amount", { amount: "0" }],
    ["negative amount", { amount: "-5" }],
    ["fractional amount", { amount: "1.5" }],
    ["empty amount", { amount: "" }],
    ["amount beyond uint256", { amount: "9".repeat(79) }],
    ["amount above the max", { amount: "2001", maxAmountRequired: "2000" }],
    ["numeric amount", { amount: 2000 }],
    ["no payee", { payTo: "" }],
    ["no asset", { asset: undefined }],
    ["network not a string", { network: 8453 }],
  ];
  it.each(malformed)("refuses an offer with %s before the payer", async (_, overrides) => {
    const s = await serve((_r, res) => send402(res, challenge(offer("eip155:84532", overrides))));
    const payer = refusingPayer();
    const err = await new AveeClient({ baseUrl: s.baseUrl, payer }).chains().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AveePaymentError);
    expect([payer.asked, s.requests.length]).toEqual([0, 1]);
  });

  it.each([
    ["2000", "2000", true],
    ["1", undefined, true],
    ["0002000", "2000", true],
    ["9".repeat(78), "9".repeat(78), true],
    ["2001", "2000", false],
    ["10000", "9999", false],
    ["000", undefined, false],
    ["+1", undefined, false],
    [" 1", undefined, false],
    ["1", "0", false],
  ] as const)("amount %s against max %s is valid: %s", (amount, max, ok) => {
    expect(offerProblem(offer("eip155:1", { amount, maxAmountRequired: max })) === undefined).toBe(ok);
  });

  it("never retries a paid request that timed out", async () => {
    const s = await serve((r, res) => {
      if (!r.headers["payment-signature"]) send402(res, challenge(offer("eip155:84532")));
    });
    let signs = 0;
    const c = new AveeClient({
      baseUrl: s.baseUrl,
      timeoutMs: 100,
      maxRetryDelayMs: 1,
      payer: {
        sign: () => {
          signs++;
          return { payload: { signature: "0x" } };
        },
      },
    });
    await expect(c.chains()).rejects.toBeInstanceOf(AveeTimeoutError);
    expect([signs, s.requests.length]).toEqual([1, 2]);
  });

  it("refuses a signature of the wrong shape", async () => {
    const s = await serve((_r, res) => send402(res, challenge(offer("eip155:84532"))));
    for (const sign of [() => "0xsig", () => ({ header: "a\r\nb" }), () => ({ payload: "0x" }), () => ({ payload: { v: 1n } })]) {
      const err = await new AveeClient({ baseUrl: s.baseUrl, payer: { sign: sign as never } }).chains().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AveePaymentError);
    }
    expect(s.requests).toHaveLength(4);
  });
});

describe("the response boundary", () => {
  it.each([
    ["a missing required field", { chains: [] }, "response.resolutions is missing"],
    ["a string where a number belongs", { ...valid("Config"), min_liquidity_usd: "7" }, "response.min_liquidity_usd must be a number, got string"],
    ["a non-object", [1, 2], "response must be an object, got array"],
  ])("refuses %s", async (_, body, message) => {
    const s = await serve((_r, res) => json(res, 200, body));
    const err = await new AveeClient({ baseUrl: s.baseUrl }).config().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AveeValidationError);
    expect(String(err)).toContain(message);
  });

  it("points at the broken item of a list", async () => {
    const s = await serve((_r, res) => json(res, 200, { items: [pair("a"), { ...pair("b"), pair_address: 5 }] }));
    const err = await new AveeClient({ baseUrl: s.baseUrl }).pairs().catch((e: unknown) => e);
    expect(String(err)).toContain("response.items[1].pair_address must be a string, got number");
  });

  it("keeps unknown fields, enum values and union branches, and treats null as absent", async () => {
    const body = { items: [{ ...pair("a"), x_future: { deep: [1] }, score: null }], next_cursor: null };
    const s = await serve((_r, res) => json(res, 200, body));
    const page = await new AveeClient({ baseUrl: s.baseUrl }).pairs();
    expect(page.items[0]).toMatchObject({ pair_address: "a", x_future: { deep: [1] } });
    expect(page.next_cursor).toBeUndefined();
  });

  it("refuses malformed problem details and keeps the body instead", async () => {
    for (const body of ['{"code":5,"title":["x"]}', '{"code":', "[]", "null", "é".repeat(300)]) {
      const s = await serve((_r, res) => {
        res.writeHead(404, { "content-type": "application/problem+json" }).end(body);
      });
      const err = (await new AveeClient({ baseUrl: s.baseUrl }).chains().catch((e: unknown) => e)) as AveeApiError;
      expect(err).toBeInstanceOf(AveeApiError);
      expect([err.status, err.code, err.problem]).toEqual([404, undefined, undefined]);
      expect((err.detail ?? "").length).toBeLessThanOrEqual(201);
    }
  });

  it("clips a long problem detail", async () => {
    const s = await serve((_r, res) => {
      res.writeHead(500, { "content-type": "application/problem+json" }).end(JSON.stringify({ code: "internal", title: "t", detail: "x".repeat(5000) }));
    });
    const err = (await new AveeClient({ baseUrl: s.baseUrl, maxRetries: 0 }).chains().catch((e: unknown) => e)) as AveeApiError;
    expect(err.code).toBe("internal");
    expect(err.detail!.length).toBeLessThanOrEqual(201);
    expect(err.message.length).toBeLessThan(400);
  });
});

describe("options", () => {
  it("refuse reserved and multi-line headers and a malformed payer", () => {
    expect(() => new AveeClient({ headers: { "Payment-Signature": "x" } })).toThrow(AveeValidationError);
    expect(() => new AveeClient({ headers: { "x-trace": "a\r\nx-injected: 1" } })).toThrow(AveeValidationError);
    expect(() => new AveeClient({ payer: { networks: "eip155:1" as never, sign: () => null } })).toThrow(AveeValidationError);
    expect(() => new AveeClient({ headers: { "x-trace": "abc" } })).not.toThrow();
  });
});

describe("pagination", () => {
  it("stops on a longer cursor cycle within a bounded number of pages", async () => {
    const cycle = ["c1", "c2", "c3", "c4", "c5"];
    const s = await serve((r, res) => {
      const cur = r.url.searchParams.get("cursor") ?? "";
      json(res, 200, { items: [pair(cur)], next_cursor: cycle[(cycle.indexOf(cur) + 1) % cycle.length] });
    });
    let n = 0;
    await expect(async () => {
      for await (const _ of new AveeClient({ baseUrl: s.baseUrl }).iterTrending()) n++;
    }).rejects.toBeInstanceOf(AveeValidationError);
    expect(n).toBeLessThanOrEqual(3 * cycle.length + 2);
  });

  it("never flags distinct cursors and holds no history", () => {
    const loops = new CursorLoop();
    let prev: string | undefined;
    for (let i = 0; i < 100_000; i++) {
      const next = `c${i}`;
      expect(loops.repeats(prev, next)).toBe(false);
      prev = next;
    }
    expect(loops.repeats(prev, prev!)).toBe(true);
  });

  it("fetches nothing more once the consumer stops", async () => {
    let fetched = 0;
    for await (const _ of paginate(
      async (c) => {
        fetched++;
        return { items: [1, 2], next_cursor: `${c ?? ""}x` };
      },
      undefined,
      undefined,
    )) {
      break;
    }
    expect(fetched).toBe(1);
  });

  it("stops at an abort between pages and leaves no timer behind", async () => {
    let n = 0;
    const s = await serve((_r, res) => json(res, 200, { items: [pair("a")], next_cursor: `c${++n}` }));
    const timers = activeTimers();
    const ctl = new AbortController();
    const walk = async () => {
      for await (const _ of new AveeClient({ baseUrl: s.baseUrl }).iterTrending({}, { signal: ctl.signal })) ctl.abort(new Error("stop"));
    };
    await expect(walk()).rejects.toThrow("stop");
    expect(s.requests).toHaveLength(1);
    expect(activeTimers()).toBeLessThanOrEqual(timers);
  });
});
