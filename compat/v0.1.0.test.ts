import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AveeApiError,
  AveeClient,
  type AveeClientOptions,
  AveeConnectionError,
  AveeError,
  AveePaymentError,
  AveeTimeoutError,
  AveeValidationError,
  DEFAULT_BASE_URL,
  OPERATIONS,
  type PairInfo,
  type Payer,
  type PaymentContext,
  type PaymentSignature,
  PREVIEW_BASE_URL,
  paginate,
  type RateLimit,
  type RequestOptions,
  type ResponseInfo,
} from "@avee_tech/sdk";
import { afterAll, beforeAll, expect, it } from "vitest";

const counts = { buys: 1, sells: 1, buy_volume: 1.5, sell_volume: 1.5, buyers: 1, sellers: 1 };
const windows = { m5: 1.5, h1: 1.5, h6: 1.5, h24: 1.5 };

function pair(address: string): PairInfo {
  return {
    network: { slug: "base", chain_id: 8453 },
    dex: { name: "uniswap", factory: "0xf", chain_id: 8453, lp_token_symbol: "UNI-V2" },
    pair_address: address,
    ticker: "WETH/USDC",
    pair_fee: 0.3,
    tokens: [],
    txn: { m5: counts, h1: counts, h6: counts, h24: counts },
    volume: windows,
    price_change: windows,
    liquidity_usd: 1000,
    last_updated_at: "2026-09-28T00:00:00Z",
    created_at: "2026-09-28T00:00:00Z",
  } as PairInfo;
}

const challenge = {
  x402Version: 2,
  accepts: [{ scheme: "exact", network: "eip155:84532", amount: "2000", maxAmountRequired: "2000", asset: "0xasset", payTo: "0xpayee", maxTimeoutSeconds: 60 }],
};
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", "x-request-id": "req-1", ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/v1/chains") return send(200, { items: [{ slug: "base", chain_id: 8453, latest_block: 1, block_lag_seconds: 0, protocols: [] }] });
    if (url.pathname === "/api/v1/pairs") {
      if (!url.searchParams.get("cursor")) return send(200, { items: [pair("a1"), pair("a2")], next_cursor: "p2" });
      return send(200, { items: [pair("a3")] });
    }
    if (url.pathname === "/api/v1/status") {
      if (!req.headers["payment-signature"]) return send(402, challenge, { "payment-required": b64(challenge) });
      return send(200, { status: "ok" }, { "payment-response": b64({ success: true, transaction: "0xtx", network: "eip155:84532" }) });
    }
    res.writeHead(404, { "content-type": "application/problem+json" });
    res.end(JSON.stringify({ type: "t", title: "chain not found", status: 404, code: "chain_not_found", detail: "no chain nope", param: "chain", request_id: "req-1" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it("v0.1.0: client, operations, iterators, errors and the payer keep working", async () => {
  expect(DEFAULT_BASE_URL).toMatch(/^https:/);
  expect(PREVIEW_BASE_URL).toMatch(/^https:/);
  expect(OPERATIONS.some((o) => o.id === "pairs" && o.method === "GET" && o.path === "/pairs")).toBe(true);

  const payer: Payer = {
    networks: ["eip155:84532"],
    sign: async (ctx: PaymentContext): Promise<PaymentSignature | null> => {
      if (ctx.requirement.network !== "eip155:84532" || !ctx.paymentId || ctx.operation !== "status") return null;
      return { payload: { signature: "0xsig" } };
    },
  };
  const options: AveeClientOptions = { baseUrl, apiKey: "k1", timeoutMs: 5000, maxRetries: 1, maxRetryDelayMs: 1000, maxResponseBytes: 1 << 20, headers: { "x-trace": "compat" }, payer };
  const client = new AveeClient(options);

  const chains = await client.chains();
  expect(chains.items[0]?.slug).toBe("base");
  const info: ResponseInfo | undefined = client.lastResponse;
  const rate: RateLimit | undefined = info?.rateLimit;
  expect([info?.operation, info?.status, info?.requestId, typeof rate]).toEqual(["chains", 200, "req-1", "object"]);

  const page = await client.pairs({ chains: ["base"], limit: 2, min_liquidity_usd: 1000 });
  expect([page.items.length, page.next_cursor]).toEqual([2, "p2"]);

  const all: string[] = [];
  const opts: RequestOptions = { maxPages: 5 };
  for await (const p of client.iterPairs({}, opts)) all.push(p.pair_address);
  expect(all).toEqual(["a1", "a2", "a3"]);

  const custom: number[] = [];
  for await (const n of paginate(async (c) => (c ? { items: [3] } : { items: [1, 2], next_cursor: "b" }), undefined, undefined)) custom.push(n);
  expect(custom).toEqual([1, 2, 3]);

  const notFound = (await client.pair("nope", "0xabc").catch((e: unknown) => e)) as AveeApiError;
  expect(notFound).toBeInstanceOf(AveeApiError);
  expect(notFound).toBeInstanceOf(AveeError);
  expect([notFound.status, notFound.code, notFound.detail, notFound.param, notFound.requestId, notFound.retryable, notFound.paid]).toEqual([
    404,
    "chain_not_found",
    "no chain nope",
    "chain",
    "req-1",
    false,
    false,
  ]);

  await expect(client.pairs({ limit: 1000 })).rejects.toBeInstanceOf(AveeValidationError);

  await expect(client.status()).resolves.toEqual({ status: "ok" });
  expect(client.lastResponse?.payment).toMatchObject({ success: true, transaction: "0xtx" });

  const declined = await new AveeClient({ baseUrl, payer: { sign: () => null } }).status().catch((e: unknown) => e);
  expect(declined).toBeInstanceOf(AveePaymentError);
  expect((declined as AveePaymentError).operation).toBe("status");

  await expect(new AveeClient({ baseUrl: "http://127.0.0.1:1/api/v1", maxRetries: 0 }).chains()).rejects.toBeInstanceOf(AveeConnectionError);
  expect(new AveeTimeoutError("t")).toBeInstanceOf(AveeError);
});
