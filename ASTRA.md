# Astra oracle client for TypeScript

```ts
import { AstraClient } from "@avee_tech/sdk/astra";
const [btc] = await new AstraClient().latestPrices(["0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"]);
console.log(btc.price.toDecimalString()); // "83095.4425"
```

Astra is avee's composite exchange index served over the routes and JSON shapes of Pyth's Hermes. No
key is needed. `@avee_tech/sdk/astra` wraps its REST, SSE and WebSocket surfaces with typed models, retries and
reconnects. Zero runtime dependencies: it uses the global `fetch` and `WebSocket` of Node ≥ 22 and of
browsers.

```sh
npm install @avee_tech/sdk
```

The default host is the preview host `https://astra.preview.avee.tech`; pass a base URL to use another
(`new AstraClient({ baseUrl })`). A base URL with a path prefix works.

## REST

| Method | Route |
|---|---|
| `priceFeeds({ query?, assetType? })` | `GET /v2/price_feeds` |
| `priceFeed(id)` | `GET /v2/price_feeds/{id}` |
| `latestPrices(ids, { ignoreInvalid? })` | `GET /v2/updates/price/latest`, 200 ids per request, merged in request order |
| `pricesAt(publishTime, ids)` | `GET /v2/updates/price/{publish_time}` |
| `pricesInInterval(publishTime, seconds, ids, { unique? })` | `GET /v2/updates/price/{publish_time}/{interval}`, flattened oldest first |
| `feeds({ category? })` | `GET /v1/feeds`: both ids, category, live value and status |
| `feedIds({ pythIds?, astraIds?, category? })` | `GET /v1/feed-ids`: which Pyth ids Astra serves, and their Astra ids |
| `status({ feed? })` | `GET /v1/status`; with `feed`, that feed's entry alone, and a `503` (not `trading`, or `stale`) is returned as the report, not thrown |
| `candles({ feed, resolution, from, to })` | `GET /v1/candles`, as `{ time, open, high, low, close }[]` |

Every method takes an `AbortSignal` as `signal`. Ids are accepted with or without `0x`, in any case,
are de-duplicated, and come back lower-case without `0x` (`normalizeFeedId`).

**Prices are exact.** `Price` keeps `price` and `conf` as integer strings with `expo`, as sent:

```ts
p.toDecimalString(); // "83095.4425", exact
p.toNumber();        // 83095.4425, correctly rounded float
p.scaled(18);        // 83095442500000000000000n, BigInt, truncated toward zero
p.confToNumber(); p.confScaled(8);
```

## Streaming

```ts
const sub = astra.subscribe(ids, { transport: "ws", channel: "fixed_rate@1000ms", onError, onStateChange });
for await (const update of sub) { … }   // break or sub.close() ends it
```

- `transport`: `"ws"` (default, the Hermes WebSocket protocol) or `"sse"`
  (`/v2/updates/price/stream`, which also takes `benchmarksOnly`). SSE carries the ids in the URL,
  so it takes at most `MAX_IDS_PER_URL` (200) and throws `AstraValidationError` above that; the
  WebSocket sends them in a message and takes up to 500.
- **Reconnect** on any drop, 429 or 5xx: full-jitter backoff from 500 ms, capped at 30 s, reset after
  a connection has been up for 60 s; `Retry-After` is a floor. The same ids are resubscribed.
- **Keepalive**: SSE is reconnected after `idleTimeoutMs` (45 s) without a byte; over WebSocket a
  silent socket gets a no-op message at half that time and is reconnected at the full time.
- **Exactly the new values**: an update older than the last one delivered for its feed, or an exact
  repeat of it (the replay sent on reconnect), is dropped.
- **Bounded memory**: a consumer that falls behind gets the newest update per feed, never a queue;
  `sub.stats.coalesced` counts what it skipped.
- **Fatal** (the iterator throws, no retry): 400, 404, 422, and a WebSocket subscription the server
  refused. Everything else goes to `onError` and is retried.

## Errors

All errors extend `AstraError`:

| Class | When |
|---|---|
| `AstraHttpError` | non-2xx: `status`, `body`, `problem` (`application/problem+json`), `retryAfterMs`, `retryable` |
| `AstraTimeoutError` | a request exceeded `timeoutMs` (10 s), or a stream went idle |
| `AstraConnectionError` | network failure, abnormal WebSocket close |
| `AstraValidationError` | bad input, or a response that breaks the contract |
| `AstraSubscriptionError` | the WebSocket subscribe was refused |

REST calls are GETs and are retried `maxRetries` times (2) on 408, 429, 502, 503, 504, timeouts and
network errors. `Retry-After` is honoured up to `maxRetryDelayMs` (30 s); a longer one is returned as
the error instead of waited out.

## Find your feeds

Paste the Pyth ids your code already uses and see which ones Astra serves:

```ts
const { items, missing } = await astra.feedIds({ pythIds: ["0xe62df6c8…", "0xff61491a…"] });
// items:   [{ symbol: "Crypto.BTC/USD", pythId: "e62d…", astraId: "1de7…", … }]
// missing: Pyth ids Astra does not serve
```

Every id in `items` works as it is on the Hermes routes: nothing in your code changes for those
feeds. `feedIds()` without a filter lists every feed Astra serves. Up to 200 ids go in one request;
a longer list is split, so the URL fits the request line a proxy accepts, and merged, sorted by
symbol.

## Moving from Pyth Hermes

`@pythnetwork/hermes-client` works against Astra unchanged; only the URL moves (checked with 2.1.0 on
REST and SSE):

```ts
const hermes = new HermesClient("https://astra.preview.avee.tech");
```

| `@pythnetwork/hermes-client` | this package |
|---|---|
| `new HermesClient(url, { accessToken })` | `new AstraClient({ baseUrl })`, no key |
| `getPriceFeeds({ query, assetType })` | `priceFeeds({ query, assetType })` |
| `getLatestPriceUpdates(ids).parsed` | `latestPrices(ids)` |
| `getPriceUpdatesAtTimestamp(t, ids)` | `pricesAt(t, ids)` |
| `getPriceUpdatesStream(ids)` (EventSource, no reconnect) | `subscribe(ids, { transport: "sse" })`, or `"ws"` |
| `Number(price) * 10 ** expo` | `price.toNumber()`, `toDecimalString()`, `scaled(n)` |
| `binary.data` for `updatePriceFeeds` | always empty: Astra is unsigned and cannot be verified on-chain |

A reference-status feed is served over Hermes like a trading one; read `status()` or `feeds()` before
liquidating on it.

## Limits

| Limit | Value |
|---|---|
| Ids per call / WebSocket subscription | 500 (historical routes: 100 feeds) |
| Ids per URL | `MAX_IDS_PER_URL`, 200: a longer request line is rejected before it reaches Astra. `latestPrices` and `feedIds` split longer lists into sequential requests and fail as a whole if one fails; SSE refuses more, use `"ws"` |
| Interval window | 60 s |
| Candles per request | 5000 |
| Response body | `maxResponseBytes`, 8 MiB |
| Stream message | `maxMessageBytes`, 1 MiB |
| Stream lifetime | 24 h on the server; the client reconnects |

Browsers: the same code runs; `fetch` and `WebSocket` are the page's. Older Node: pass
`fetch` and `WebSocket` (for example from `ws`) in the options.

## Development

`npm test` runs against a local fake Astra; `npm run test:live` checks the preview host. The contract
test reads `spec/astra/astra.yml`, the synced copy of the Astra OpenAPI file, and fails when a route or field
this package reads changes type or disappears.
