# avee DEX data API client for TypeScript

```ts
import { AveeClient } from "@avee/sdk";
const page = await new AveeClient().pairs({ chains: ["base"], sort: "liquidity", limit: 10 });
console.log(page.items[0]?.pair_address);
```

Typed access to every operation of the avee client API (`/api/v1`): pairs, tokens, trades, candles,
wallets, leaderboards, farms, perps and oracle prices across every chain avee indexes. No key is
needed. Zero runtime dependencies: it uses the global `fetch` of Node ≥ 20 and of browsers; ESM and
CJS builds are shipped.

```sh
npm install @avee/sdk
```

The default host is the preview host `https://api.preview.avee.tech/api/v1` (`DEFAULT_BASE_URL`, equal to
`PREVIEW_BASE_URL`); pass `baseUrl` to use another.

## Options

| Option | Default | |
|---|---|---|
| `baseUrl` | `DEFAULT_BASE_URL` | a path prefix works |
| `apiKey` | none | sent as `X-API-Key`; only raises the limits |
| `timeoutMs` | 30000 | per attempt |
| `maxRetries` | 2 | GETs only |
| `maxRetryDelayMs` | 30000 | a longer `Retry-After` is returned as the error |
| `maxResponseBytes` | 16 MiB | a larger body is refused |
| `headers`, `fetch` | | extra headers; your own `fetch` |
| `payer` | none | opts into x402, see below |

Every method takes `{ signal }` as its last argument.

## Operations

Parameters and fields keep the API's wire names (`chains`, `min_liquidity_usd`, `pair_address`). A
chain is a slug (`"base"`) or a numeric id (`8453`). Input is checked against the specification's
bounds before anything is sent (`AveeValidationError`); a batch takes up to the `maxItems` of its
request schema (pairs 50, tokens and wallet labels 200).

Every value set in the specification is a union type and an object of constants with the same name:
`sort: SortBy.Volume`, `timeframe: TimeFrame.H24`, `pair.status === PairStatus.Scam`. A value that
starts with a digit leads with its unit (`"24h"` is `TimeFrame.H24`, `"30d"` is `WalletWindow.D30`).
The sets are open: an unknown value from the server decodes as it is. An omitted parameter takes the
server's default, shown on hover as `@default`.

<!-- operations:start -->
| Method | Route | What it answers |
|---|---|---|
| **meta** | | |
| `x402Discovery()` | `GET /.well-known/x402` | Operations payable with x402 and their prices |
| `status()` | `GET /status` | Liveness and upstream health |
| `key()` | `GET /key` | Plan and limits of the calling key |
| `config()` | `GET /config` | Enumerations and defaults |
| `chains()` | `GET /chains` | Chains served right now |
| **dex** | | |
| `search(params)` | `GET /search` | Typeahead across tokens and pairs |
| `pairs(params), iterPairs` | `GET /pairs` | Liquidity pair screener |
| `pair(chain, address)` | `GET /chains/{chain}/pairs/{address}` | One liquidity pair |
| `pairTrades(chain, address, params), iterPairTrades` | `GET /chains/{chain}/pairs/{address}/trades` | Trade tape of a pair |
| `pairCandles(chain, address, params)` | `GET /chains/{chain}/pairs/{address}/candles` | OHLCV candles |
| `trending(params), iterTrending` | `GET /trending` | Trending pairs right now |
| `pairsNew(params), iterPairsNew` | `GET /pairs/new` | Newest pairs on one chain |
| `launchpadTokens(params), iterLaunchpadTokens` | `GET /launchpads/tokens` | Launchpad launches by stage (new, bonding or graduated) |
| `pairBatch(body)` | `POST /pairs/batch` | Many pairs in one call |
| `perps(params), iterPerps` | `GET /perps` | Perpetual markets |
| `perpHistory(market, params)` | `GET /perps/{market}/history` | Open interest, funding and mark history of a perpetual |
| `perpLiquidations(params)` | `GET /perps/liquidations` | Daily liquidations of a perpetual or a whole venue |
| `deployerTokens(address, params), iterDeployerTokens` | `GET /deployers/{address}/tokens` | Launches of one deployer, with its reputation card |
| **token** | | |
| `tokenByAddress(chain, address, params)` | `GET /chains/{chain}/tokens/{address}` | Canonical token by chain and address |
| `tokenPairs(chain, address, params)` | `GET /chains/{chain}/tokens/{address}/pairs` | Top pairs of a token by 24h volume |
| `tokenVerdict(chain, address)` | `GET /chains/{chain}/tokens/{address}/verdict` | Signed token verdict, submittable to the trust oracle |
| `tokenVerdictProof(chain, address)` | `GET /chains/{chain}/tokens/{address}/proof` | Merkle proof of a verdict at the last published epoch |
| `tokenBrief(chain, address)` | `GET /chains/{chain}/tokens/{address}/brief` | Everything needed to decide about a token, in one call |
| `tokenByID(id, params)` | `GET /tokens/{id}` | Canonical token by id |
| `tokenBySlug(slug, params)` | `GET /tokens/by-slug/{slug}` | Canonical token by slug |
| `tokens(params), iterTokens` | `GET /tokens` | Token market list, ranked by market cap |
| `tokenBatch(body)` | `POST /tokens/batch` | Resolve many tokens at once |
| `tokenHolders(chain, address, params), iterTokenHolders` | `GET /chains/{chain}/tokens/{address}/holders` | Top holders of a token |
| `tokenTraders(chain, address, params), iterTokenTraders` | `GET /chains/{chain}/tokens/{address}/traders` | Wallets that traded a token, with their PNL on it |
| **farm** | | |
| `farms(params), iterFarms` | `GET /farms` | Yield farm screener |
| `farm(chain, address)` | `GET /chains/{chain}/farms/{address}` | One yield farm |
| **wallet** | | |
| `wallets(params), iterWallets` | `GET /wallets` | Rank traders on one chain |
| `walletStats(params)` | `GET /wallets/stats` | Trader population per chain |
| `walletLabelsBatch(body)` | `POST /wallets/labels/batch` | Behaviour labels for many wallets |
| `walletOverview(address, params)` | `GET /wallets/{address}/overview` | One wallet across every chain it traded |
| `leaderboard(params)` | `GET /leaderboard` | Chain and DEX protocol boards |
| `walletProfile(chain, address)` | `GET /chains/{chain}/wallets/{address}` | Trader profile with metrics for every window |
| `walletPositions(chain, address, params), iterWalletPositions` | `GET /chains/{chain}/wallets/{address}/positions` | Open and closed positions of a wallet |
| `walletTrades(chain, address, params), iterWalletTrades` | `GET /chains/{chain}/wallets/{address}/trades` | Raw trade history of a wallet |
| `walletChart(chain, address, params)` | `GET /chains/{chain}/wallets/{address}/chart` | Wallet performance series — PNL and ROI |
| `walletBestTrades(chain, address, params)` | `GET /chains/{chain}/wallets/{address}/best-trades` | Best and worst closed trades of a wallet |
| `walletRounds(chain, address, params), iterWalletRounds` | `GET /chains/{chain}/wallets/{address}/rounds` | Position rounds — one entry and exit cycle per row |
| `walletFunding(chain, address)` | `GET /chains/{chain}/wallets/{address}/funding` | Who funded a wallet |
| **oracle** | | |
| `oraclePrices(params)` | `GET /prices` | Latest oracle prices by feed id |
| `oraclePricesAt(params)` | `GET /prices/at` | Oracle prices at a past moment |
<!-- operations:end -->

## Pagination

Lists answer `{ items, next_cursor }`. Each paged operation has an `iter…` twin that yields items and
fetches the next page only when the previous one is used up; `break` stops it, `{ maxPages }` caps it.

```ts
for await (const trade of client.iterPairTrades("base", pair, { tx_type: ["buy"] }, { maxPages: 5 })) { … }
```

A repeated cursor ends the walk with an `AveeValidationError` rather than looping. `paginate()` is
exported for your own page walks. Prefer the batch operations (`pairBatch`, `tokenBatch`,
`walletLabelsBatch`) to one call per address.

## Errors

| Class | When |
|---|---|
| `AveeApiError` | non-2xx: `status`, `code` (branch on it), `detail`, `param`, `requestId`, `rateLimit`, `retryAfterMs`, `retryable`, `paid` |
| `AveeTimeoutError` | an attempt exceeded `timeoutMs` |
| `AveeConnectionError` | network failure |
| `AveeValidationError` | bad input, or a response that breaks the contract (not JSON, a missing or mistyped field) or is too large |
| `AveePaymentError` | the x402 flow stopped before paying: an unreadable challenge or offer, no network in common, the payer declined |

GETs are retried on 408, 429, 5xx, timeouts and network errors with full-jitter backoff; a
`Retry-After` (or, on a 429 without one, the `RateLimit` reset) is waited out when it fits
`maxRetryDelayMs`. POSTs are never retried. Redirects are not followed: a 3xx is an `AveeApiError`, so
the key and a payment signature never leave the host.

## Rate limits

Without a key one budget per client address is shared by every operation and weighted by its cost.
`client.lastResponse` holds the latest `status`, `requestId`, `rateLimit` (`limit`, `remaining`,
`resetSeconds`, `retryAfterSeconds`, `policy`) and the x402 `payment` receipt. Under concurrency it is
the last response to arrive; errors carry their own `rateLimit`.

## Paying past the keyless limit (x402)

Off by default: without a payer the client never pays and a spent budget is an ordinary 429. With a
payer it sends `Accept-Payment: x402`; a spent budget then answers 402, the client picks the first
`exact` offer on a network the payer lists, asks the payer to sign it, and repeats the request once
with `PAYMENT-SIGNATURE`. A paid request is never retried; the settlement receipt is
`lastResponse.payment`. The payer sees the amount (atomic units), asset, network and `payTo` in
`context.requirement` and approves by signing or declines by returning `null`. An offer whose amount
is not a positive integer (or exceeds `maxAmountRequired`), or that lacks an asset or `payTo`, is
refused before the payer is asked.

The SDK holds no key and depends on no wallet library. An EIP-3009 signer with viem:

```ts
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const account = privateKeyToAccount(process.env.PAYER_KEY as `0x${string}`);
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http() });

const client = new AveeClient({
  payer: {
    networks: ["eip155:84532"],
    async sign({ requirement: r }) {
      if (BigInt(r.amount) > 10_000n) return null;
      const now = Math.floor(Date.now() / 1000);
      const authorization = {
        from: account.address, to: r.payTo, value: r.amount,
        validAfter: String(now - 5), validBefore: String(now + r.maxTimeoutSeconds),
        nonce: `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`,
      };
      const signature = await wallet.signTypedData({
        domain: { name: String(r.extra?.name), version: String(r.extra?.version), chainId: 84532, verifyingContract: r.asset as `0x${string}` },
        types: { TransferWithAuthorization: [
          { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" } ] },
        primaryType: "TransferWithAuthorization",
        message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
      });
      return { payload: { signature, authorization } };
    },
  },
});
```

`sign` may instead return `{ header }`, a finished `PAYMENT-SIGNATURE` from any x402 client library.

## Astra price oracle

The package also carries the client for Astra, avee's Hermes-compatible price oracle, at the
`@avee/sdk/astra` entry point. Importing `@avee/sdk` alone never loads it.

```ts
import { AstraClient } from "@avee/sdk/astra";
const [btc] = await new AstraClient().latestPrices(["0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"]);
```

REST, SSE and WebSocket, exact prices, reconnecting streams: [ASTRA.md](ASTRA.md). The WebSocket
transport uses the global `WebSocket` of Node ≥ 22; pass one in the options on Node 20.

## Compatibility

Models are generated from the OpenAPI document; unknown fields and new enum values pass through
untouched (enum types are open unions), so a newer server never breaks this package. Every response
is checked against its model before it is returned: a missing required field or a field of the wrong
type is an `AveeValidationError` naming the field, and `null` in an optional field reads as absent.
Inside a major version the package is additive only.

## Moving from the avee-agents `@avee/sdk` 0.1

That package covered five calls; this one covers every operation, named by its `operationId`.

| Before | Now |
|---|---|
| `brief(chain, address)` | `tokenBrief(chain, address)` |
| `verdict(chain, address)` | `tokenVerdict(chain, address)` |
| `pairs(query)`, `farms(query)` | `pairs(params)`, `farms(params)` with wire-named parameters, plus `iterPairs`, `iterFarms` |
| `briefConditional` (`If-None-Match`) | not yet: a plain `tokenBrief` |
| `payment: { pay(challenge) }` returning headers or a payload | `payer: { networks, sign(context) }` returning `{ payload }` or `{ header }` |

## Development

`npm test` runs against a local fake server; `npm run test:live` checks the preview host.
`npm run spec:check` fails when `spec/openapi.yml` or the generated code drifts from the API.
