# Changelog

## 0.1.1 — 2026-10-07

- New `perpStats` (`GET /perps/{market}/stats`): position flow by side over 5m, 1h, 6h and 24h,
  liquidations, open interest a day ago, and a flag when the fills feed is behind.
- Wallets carry `human_score` (`value`, `status`); `wallets` takes `sort=human_score` and
  `min_human_score`.
- `PerpMarket` gains hourly funding and borrow per side and open interest per side; `Transaction`
  gains `perp_action`; `ChainInfo` gains `perp_volume_24h` and `perp_txns_24h`; `FarmInfo` gains
  `apr_diagnostic`.
- `FarmInfo` gains `family`, `farm_key`, `venue`, `verified`, `apr_max` and `reward_streams`
  (`FarmRewardStream`: token, symbol, decimals, its APR share, price, end time, status). `pid` is
  deprecated in favour of `farm_key`.
- Astra: REST calls and the SSE stream work in browsers. The client called the default `fetch` as a
  method of its own config object, which browsers reject with `Illegal invocation`; it is now bound
  to the global object, as the `/api/v1` client already was.

## 0.1.0 — 2026-09-29

- First release: every operation of `/api/v1` as a typed method, models generated from the OpenAPI
  document, tolerant of unknown fields and enum values.
- Lazy cursor iterators for every paged operation.
- Typed problem+json errors, GET retries honouring `Retry-After`, rate-limit info of the last response,
  input validated against the specification's bounds, bounded response size.
- Opt-in x402: with a payer, a spent keyless budget is paid for once and the receipt exposed.
- Redirects are not followed; an unreadable x402 challenge or a malformed offer (amount not a positive
  integer or above `maxAmountRequired`, no asset or payee) is refused before the payer is asked; a
  repeated cursor is detected in constant memory; public-API compatibility gates (`COMPATIBILITY.md`).
- Every response is checked against its model before it is returned.
- An object of constants beside every value-set type (`SortBy.Volume`, `TimeFrame.H24`), and `@default` on every parameter the server defaults.

### Astra price oracle (`@avee_tech/sdk/astra`)

- `MAX_IDS_PER_URL` (200): the ids that fit one URL before the edge rejects the request line.
  `latestPrices` splits a longer list into sequential requests of 200 and merges them in request
  order; one failed request fails the call. `subscribe` over SSE refuses more than 200 ids and points
  to `"ws"`, which takes up to 500. `FEED_IDS_PER_REQUEST` stays, equal to `MAX_IDS_PER_URL`.
- `feedIds` for `/v1/feed-ids`: which Pyth ids Astra serves and their Astra ids, with the ones it
  does not serve in `missing`.
- `status({ feed })`: one feed's health; the server's `503` for a feed that is not `trading`, or is
  `stale`, is a normal answer here and comes back as the report. Only an `application/json` body counts: a proxy page or a problem on `503` stays an error and is retried. An empty feed reads the whole report.
- First release: Hermes v2 REST (`price_feeds`, latest, at a time, over an interval), Astra's native
  `/v1/feeds`, `/v1/status` and `/v1/candles`.
- Streaming over WebSocket (Hermes protocol) and SSE with reconnect, resubscribe, keepalive, per-feed
  de-duplication and a bounded, coalescing buffer.
- Exact prices (integer string + `expo`) with decimal, float and fixed-point helpers.
- Typed errors, retries for GETs honouring `Retry-After`, and validation of every response.
