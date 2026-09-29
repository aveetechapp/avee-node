import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AveeApiError, AveeClient, AveePaymentError, type PaymentContext } from "../src/index.js";
import { type Fake, fake, json, problem, valid } from "./fake.js";

const servers: Fake[] = [];
async function serve(handler: Parameters<typeof fake>[0]): Promise<Fake> {
  const s = await fake(handler);
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

function offer(network: string) {
  return {
    scheme: "exact",
    network,
    amount: "2000",
    maxAmountRequired: "2000",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payTo: "0x00000000000000000000000000000000000000b2",
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2", x_future: 1 },
  };
}

function challenge(...accepts: unknown[]) {
  return {
    x402Version: 2,
    error: "keyless budget spent",
    resource: { url: "https://api.preview.avee.tech/api/v1/chains", mimeType: "application/json" },
    accepts,
  };
}

function send402(res: ServerResponse, doc: unknown, header = true): void {
  res.writeHead(402, { "content-type": "application/json", "retry-after": "30", ...(header ? { "payment-required": b64(doc) } : {}) });
  res.end(JSON.stringify(doc));
}

describe("x402", () => {
  it("pays once on the preferred network and exposes the receipt", async () => {
    const s = await serve((r, res) => {
      if (!r.headers["payment-signature"]) return send402(res, challenge(offer("eip155:8453"), offer("eip155:84532")));
      json(res, 200, { items: [] }, { "payment-response": b64({ success: true, transaction: "0xtx", network: "eip155:84532", payer: "0xp" }) });
    });
    const seen: PaymentContext[] = [];
    const c = new AveeClient({
      baseUrl: s.baseUrl,
      payer: {
        networks: ["eip155:84532", "eip155:8453"],
        sign: async (ctx) => {
          seen.push(ctx);
          return { payload: { signature: "0xsig", authorization: { from: "0xp" } } };
        },
      },
    });
    await c.chains();
    expect(s.requests).toHaveLength(2);
    expect(seen).toHaveLength(1);
    expect(s.requests[0]!.headers["accept-payment"]).toBe("x402");
    expect(seen[0]!.requirement).toMatchObject({ network: "eip155:84532", amount: "2000" });
    expect(seen[0]!.operation).toBe("chains");
    const sent = JSON.parse(Buffer.from(String(s.requests[1]!.headers["payment-signature"]), "base64").toString());
    expect(sent.x402Version).toBe(2);
    expect(sent.accepted).toEqual(offer("eip155:84532"));
    expect(sent.payload).toEqual({ signature: "0xsig", authorization: { from: "0xp" } });
    expect(sent.extensions["payment-identifier"].info.id).toBe(seen[0]!.paymentId);
    expect(sent.resource.url).toContain("/chains");
    expect(c.lastResponse?.payment).toMatchObject({ success: true, transaction: "0xtx" });
  });

  it("reads a challenge from the body and accepts a finished header", async () => {
    const s = await serve((r, res) => {
      if (r.headers["payment-signature"] !== "ready-made") return send402(res, challenge(offer("solana:mainnet")), false);
      json(res, 200, valid("Config"));
    });
    const c = new AveeClient({ baseUrl: s.baseUrl, payer: { sign: (ctx) => (ctx.requirement.network === "solana:mainnet" ? { header: "ready-made" } : null) } });
    await expect(c.config()).resolves.toEqual(valid("Config"));
  });

  it.each([402, 503])("never pays twice nor retries a paid request answered %i", async (status) => {
    const s = await serve((r, res) => {
      if (!r.headers["payment-signature"] || status === 402) return send402(res, challenge(offer("eip155:84532")));
      problem(res, status, "upstream_unavailable", "later");
    });
    const c = new AveeClient({ baseUrl: s.baseUrl, payer: { networks: ["eip155:84532"], sign: () => ({ payload: { signature: "0x" } }) } });
    const err = (await c.chains().catch((e: unknown) => e)) as AveeApiError;
    expect(err).toBeInstanceOf(AveeApiError);
    expect(err.paid).toBe(true);
    expect(err.status).toBe(status);
    expect(s.requests).toHaveLength(2);
    if (status === 402) expect(err.paymentRequired?.accepts).toHaveLength(1);
  });

  it("stops without sending anything when the payer declines or cannot pay there", async () => {
    const s = await serve((_r, res) => send402(res, challenge(offer("eip155:8453"))));
    const declined = await new AveeClient({ baseUrl: s.baseUrl, payer: { sign: () => null } }).chains().catch((e: unknown) => e);
    expect(declined).toBeInstanceOf(AveePaymentError);
    expect((declined as AveePaymentError).paymentRequired?.accepts).toHaveLength(1);
    const elsewhere = await new AveeClient({
      baseUrl: s.baseUrl,
      payer: {
        networks: ["eip155:1"],
        sign: () => {
          throw new Error("must not be asked");
        },
      },
    })
      .chains()
      .catch((e: unknown) => e);
    expect(elsewhere).toBeInstanceOf(AveePaymentError);
    expect(String(elsewhere)).toContain("no accepted network");
    expect(s.requests).toHaveLength(2);
  });

  it("treats a 429 as a 429 without a payer", async () => {
    const s = await serve((_r, res) => problem(res, 429, "rate_limited", "spent", { "payment-required": b64(challenge(offer("eip155:84532"))) }));
    const err = (await new AveeClient({ baseUrl: s.baseUrl, maxRetries: 0 }).chains().catch((e: unknown) => e)) as AveeApiError;
    expect(err.status).toBe(429);
    expect(err.paid).toBe(false);
    expect(err.paymentRequired).toBeUndefined();
    expect(s.requests[0]!.headers["accept-payment"]).toBeUndefined();
  });
});
