import { AveeApiError, AveeClient, PREVIEW_BASE_URL } from "@avee_tech/sdk";

const client = new AveeClient({ baseUrl: process.env.AVEE_BASE_URL ?? PREVIEW_BASE_URL });

try {
  const { items: chains } = await client.chains();
  let n = 0;
  for await (const pair of client.iterPairs({ chains: [chains[0]!.slug], sort: "liquidity", limit: 20 }, { maxPages: 2 })) {
    console.log(pair.network.slug, pair.pair_address, pair.liquidity_usd);
    n++;
  }
  console.log(`${n} pairs; budget left: ${client.lastResponse?.rateLimit.remaining}`);
} catch (err) {
  if (err instanceof AveeApiError) console.error(err.status, err.code, err.requestId);
  throw err;
}
