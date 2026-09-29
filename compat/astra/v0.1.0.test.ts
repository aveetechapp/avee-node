import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  AstraClient,
  AstraConnectionError,
  AstraError,
  AstraHttpError,
  AstraSubscriptionError,
  AstraTimeoutError,
  AstraValidationError,
  DEFAULT_BASE_URL,
  FEED_IDS_PER_REQUEST,
  MAX_EXPO,
  MAX_HISTORICAL_FEEDS,
  MAX_IDS_PER_REQUEST,
  MAX_IDS_PER_URL,
  MAX_INTERVAL_SECONDS,
  MAX_SCALE_DECIMALS,
  MIN_EXPO,
  Price,
  Subscription,
  normalizeFeedId,
  type AstraClientOptions,
  type Candle,
  type ConnectionState,
  type Feed,
  type FeedIdMap,
  type FeedMetadata,
  type FeedStatus,
  type PriceUpdate,
  type StatusReport,
  type SubscribeOptions,
  type SubscriptionStats,
} from "@avee/sdk/astra";
import { BTC, BTC_ASTRA, ETH, UNKNOWN, startAstra } from "./fake.ts";

const constants: number[] = [FEED_IDS_PER_REQUEST, MAX_EXPO, MAX_HISTORICAL_FEEDS, MAX_IDS_PER_REQUEST, MAX_IDS_PER_URL, MAX_INTERVAL_SECONDS, MAX_SCALE_DECIMALS, MIN_EXPO];
const errorClasses = [AstraConnectionError, AstraHttpError, AstraSubscriptionError, AstraTimeoutError, AstraValidationError];

let fake: Awaited<ReturnType<typeof startAstra>>;
let client: AstraClient;

before(async () => {
  fake = await startAstra();
  const options: AstraClientOptions = { baseUrl: fake.url, timeoutMs: 5000, maxRetries: 1, maxRetryDelayMs: 50, maxResponseBytes: 1 << 20, headers: { "x-consumer": "compat-v0.1.0" } };
  client = new AstraClient(options);
});

after(() => fake.close());

describe("v0.1.0 consumer", () => {
  it("keeps the exported constants and error hierarchy", () => {
    assert.equal(typeof DEFAULT_BASE_URL, "string");
    assert.ok(constants.every((n) => Number.isFinite(n)));
    for (const E of errorClasses) assert.ok(E.prototype instanceof AstraError);
  });

  it("reads the Hermes REST routes", async () => {
    const metas: FeedMetadata[] = await client.priceFeeds({ query: "btc", assetType: "crypto" });
    assert.equal(metas[0]?.symbol, "Crypto.BTC/USD");
    assert.equal(metas[0]?.astraId, BTC_ASTRA);
    const meta = await client.priceFeed(`0x${BTC}`);
    assert.equal(meta.displaySymbol, "BTC/USD");
    assert.equal(meta.marketOpen, true);

    const latest: PriceUpdate[] = await client.latestPrices([`0x${BTC}`, ETH], { ignoreInvalid: true });
    assert.deepEqual(latest.map((u) => u.id), [BTC, ETH]);
    assert.equal(latest[0]?.price.toDecimalString(), "65000");
    assert.equal(latest[0]?.emaPrice.publishTime, 1700000000);
    assert.equal(latest[0]?.metadata?.prevPublishTime, 1699999999);

    assert.equal((await client.pricesAt(1700000000, [BTC])).length, 1);
    assert.equal((await client.pricesInInterval(1700000000, MAX_INTERVAL_SECONDS, [BTC], { unique: false })).length, 1);
  });

  it("reads the native routes", async () => {
    const feeds: Feed[] = await client.feeds({ category: "crypto" });
    const status: FeedStatus = feeds[0]!.live.status;
    assert.equal(status, "trading");
    assert.equal(feeds[0]?.live.price?.toNumber(), 65000);
    const candles: Candle[] = await client.candles({ feed: "Crypto.BTC/USD", resolution: "60", from: 0, to: 60 });
    assert.equal(candles[0]?.high, 2);
  });

  it("maps feed ids and reads status of one feed on a 503", async () => {
    const map: FeedIdMap = await client.feedIds({ pythIds: [BTC, UNKNOWN] });
    assert.equal(map.items[0]?.astraId, BTC_ASTRA);
    assert.deepEqual(map.missing, [UNKNOWN]);
    const all: StatusReport = await client.status();
    assert.equal(all.ready, true);
    const one = await client.status({ feed: BTC_ASTRA });
    assert.equal(one.feeds[0]?.stale, true);
  });

  it("raises typed errors", async () => {
    await assert.rejects(client.priceFeed(UNKNOWN), (e: unknown) => e instanceof AstraHttpError && e.status === 404 && !e.retryable);
    await assert.rejects(client.latestPrices(["not-a-feed-id"]), AstraValidationError);
    assert.equal(normalizeFeedId(`0x${BTC.toUpperCase()}`), BTC);
    assert.throws(() => normalizeFeedId("nope"), AstraValidationError);
  });

  it("keeps the Price helpers", () => {
    const p = new Price("6500012345678", "1000", -8, 1);
    assert.equal(p.toDecimalString(), "65000.12345678");
    assert.equal(p.toNumber(), 65000.12345678);
    assert.equal(p.confToNumber(), 0.00001);
    assert.equal(p.scaled(2), 6500012n);
    assert.equal(p.confScaled(18), 10000000000000n);
  });

  for (const transport of ["ws", "sse"] as const) {
    it(`subscribes over ${transport} and closes`, async () => {
      const states: ConnectionState[] = [];
      const options: SubscribeOptions = {
        transport,
        channel: "real_time",
        reconnectBaseDelayMs: 10,
        reconnectMaxDelayMs: 50,
        onError: () => {},
        onStateChange: (s) => states.push(s),
      };
      const sub: Subscription = client.subscribe([`0x${BTC}`, ETH], options);
      const seen = new Map<string, PriceUpdate>();
      for await (const update of sub) {
        seen.set(update.id, update);
        if (seen.size === 2) break;
      }
      assert.equal(seen.get(BTC)?.price.toDecimalString(), "65000");
      sub.close();
      await sub.done;
      const stats: Readonly<SubscriptionStats> = sub.stats;
      assert.ok(stats.connects >= 1);
      assert.deepEqual(sub.ids, [BTC, ETH]);
      assert.equal(sub.connectionState, "closed");
      assert.equal(sub.error, undefined);
      assert.ok(states.includes("open"));
    });
  }
});
