import { describe, expect, it } from "vitest";
import { AstraClient } from "../../src/astra/index.js";

const live = process.env.ASTRA_LIVE === "1";
const baseUrl = process.env.ASTRA_BASE_URL ?? "https://astra.preview.avee.tech";
const BTC = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

describe.skipIf(!live)("live Astra", () => {
  const client = new AstraClient({ baseUrl });

  it("serves feeds, prices, status and candles", async () => {
    const feeds = await client.priceFeeds({ query: "btc", assetType: "crypto" });
    expect(feeds.some((f) => f.id === BTC)).toBe(true);
    const [btc] = await client.latestPrices([BTC]);
    expect(btc!.price.toNumber()).toBeGreaterThan(0);
    expect((await client.status()).feeds.length).toBeGreaterThan(0);
    const now = Math.floor(Date.now() / 1000);
    expect((await client.candles({ feed: "Crypto.BTC/USD", resolution: "60", from: now - 6 * 3600, to: now })).length).toBeGreaterThan(0);
    expect((await client.pricesAt(now - 600, [BTC]))[0]?.id).toBe(BTC);
  });

  it.each(["ws", "sse"] as const)("streams over %s", async (transport) => {
    const sub = client.subscribe([BTC], { transport, channel: "fixed_rate@1000ms" });
    for await (const u of sub) {
      expect(u.id).toBe(BTC);
      break;
    }
    await sub.done;
  });
});
