import { describe, expect, it } from "vitest";
import { AveeClient, PREVIEW_BASE_URL } from "../src/index.js";

const live = process.env.AVEE_LIVE === "1";

describe.skipIf(!live)("live API", () => {
  const client = new AveeClient({ baseUrl: process.env.AVEE_BASE_URL ?? PREVIEW_BASE_URL });

  it("answers a few cheap reads", async () => {
    expect((await client.status()).status).toBeTruthy();
    const chains = await client.chains();
    expect(chains.items.length).toBeGreaterThan(0);
    const page = await client.pairs({ chains: [chains.items[0]!.slug], limit: 5 });
    const first = page.items[0];
    if (first) expect((await client.pair(first.network.slug, first.pair_address)).pair_address).toBe(first.pair_address);
    expect(client.lastResponse?.requestId).toBeTruthy();
    expect(client.lastResponse?.rateLimit.remaining).toBeTypeOf("number");
  });
});
