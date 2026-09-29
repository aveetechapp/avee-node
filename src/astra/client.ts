import { AstraError, AstraValidationError } from "./errors.js";
import { HttpTransport, joinUrl, type Query } from "./http.js";
import { type FeedId, MAX_HISTORICAL_FEEDS, MAX_IDS_PER_REQUEST, MAX_IDS_PER_URL, normalizeFeedId, normalizeFeedIds, uniqueFeedIds } from "./ids.js";
import {
  type Candle,
  type Channel,
  decodeCandles,
  decodeFeed,
  decodeFeedIdMap,
  decodeFeedMetadata,
  decodeList,
  decodeStatusReport,
  decodeUpdateEnvelope,
  type Feed,
  type FeedIdEntry,
  type FeedIdMap,
  type FeedMetadata,
  type PriceUpdate,
  type Resolution,
  type StatusReport,
} from "./models.js";
import { SseTransport } from "./stream/sse.js";
import { type ConnectionState, Subscription } from "./stream/subscription.js";
import type { StreamTransport } from "./stream/transport.js";
import { type WebSocketConstructor, WsTransport } from "./stream/ws.js";

export const DEFAULT_BASE_URL = "https://astra.preview.avee.tech";
export const MAX_INTERVAL_SECONDS = 60;
export const FEED_IDS_PER_REQUEST = MAX_IDS_PER_URL;

export interface AstraClientOptions {
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  maxRetryDelayMs?: number | undefined;
  maxResponseBytes?: number | undefined;
  headers?: Record<string, string> | undefined;
  fetch?: typeof fetch | undefined;
  WebSocket?: WebSocketConstructor | undefined;
}

export interface RequestOptions {
  signal?: AbortSignal | undefined;
}

export interface PriceRequestOptions extends RequestOptions {
  ignoreInvalid?: boolean | undefined;
}

export interface IntervalRequestOptions extends PriceRequestOptions {
  unique?: boolean | undefined;
}

export interface PriceFeedsQuery extends RequestOptions {
  query?: string | undefined;
  assetType?: string | undefined;
}

export interface StatusOptions extends RequestOptions {
  feed?: string | undefined;
}

export interface FeedsQuery extends RequestOptions {
  category?: string | undefined;
}

export interface FeedIdsQuery extends RequestOptions {
  pythIds?: Iterable<string> | undefined;
  astraIds?: Iterable<string> | undefined;
  category?: string | undefined;
}

export interface CandlesQuery extends RequestOptions {
  feed: string;
  resolution: Resolution;
  from: number;
  to: number;
}

export interface SubscribeOptions {
  transport?: "ws" | "sse" | undefined;
  channel?: Channel | undefined;
  ignoreInvalid?: boolean | undefined;
  benchmarksOnly?: boolean | undefined;
  idleTimeoutMs?: number | undefined;
  maxMessageBytes?: number | undefined;
  reconnectBaseDelayMs?: number | undefined;
  reconnectMaxDelayMs?: number | undefined;
  stableAfterMs?: number | undefined;
  signal?: AbortSignal | undefined;
  onError?: ((err: AstraError) => void) | undefined;
  onStateChange?: ((state: ConnectionState) => void) | undefined;
}

function positive(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new AstraValidationError(`${name} must be a positive number`);
  return value;
}

function nonNegative(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new AstraValidationError(`${name} must be a non-negative number`);
  return Math.floor(value);
}

function unixSeconds(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new AstraValidationError(`${name} must be a non-negative integer of Unix seconds`);
  return value;
}

function idQuery(ids: readonly FeedId[]): Array<[string, string]> {
  return ids.map((id) => ["ids[]", id]);
}

function joined(name: string, ids: readonly FeedId[]): Query {
  return ids.length > 0 ? [[name, ids.join(",")]] : [];
}

function flag(name: string, value: boolean | undefined): Array<[string, string]> {
  return value === undefined ? [] : [[name, String(value)]];
}

export class AstraClient {
  readonly baseUrl: string;
  private readonly http: HttpTransport;
  private readonly webSocket: WebSocketConstructor | undefined;

  constructor(options: AstraClientOptions = {}) {
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new AstraValidationError(`baseUrl is not a URL: ${baseUrl}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new AstraValidationError("baseUrl must be http(s)");
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new AstraError("no fetch implementation: use Node 22+ or pass options.fetch");
    this.baseUrl = baseUrl;
    this.webSocket = options.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketConstructor | undefined);
    this.http = new HttpTransport({
      baseUrl,
      timeoutMs: positive("timeoutMs", options.timeoutMs, 10_000),
      maxRetries: nonNegative("maxRetries", options.maxRetries, 2),
      maxRetryDelayMs: positive("maxRetryDelayMs", options.maxRetryDelayMs, 30_000),
      maxResponseBytes: positive("maxResponseBytes", options.maxResponseBytes, 8 * 1024 * 1024),
      headers: { ...options.headers },
      fetch: fetchImpl,
    });
  }

  async priceFeeds(q: PriceFeedsQuery = {}): Promise<FeedMetadata[]> {
    const query: Query = [
      ...(q.query ? [["query", q.query] as const] : []),
      ...(q.assetType ? [["asset_type", q.assetType] as const] : []),
    ];
    const body = await this.http.getJson("v2/price_feeds", query, q.signal);
    return decodeList(body, "price_feeds", decodeFeedMetadata);
  }

  async priceFeed(id: string, options: RequestOptions = {}): Promise<FeedMetadata> {
    const body = await this.http.getJson(`v2/price_feeds/${normalizeFeedId(id)}`, [], options.signal);
    return decodeFeedMetadata(body, "price_feed");
  }

  async latestPrices(ids: Iterable<string>, options: PriceRequestOptions = {}): Promise<PriceUpdate[]> {
    const feedIds = normalizeFeedIds(ids, MAX_IDS_PER_REQUEST);
    const out: PriceUpdate[] = [];
    for (let i = 0; i < feedIds.length; i += MAX_IDS_PER_URL) {
      const query = [...idQuery(feedIds.slice(i, i + MAX_IDS_PER_URL)), ...flag("ignore_invalid_price_ids", options.ignoreInvalid)];
      out.push(...decodeUpdateEnvelope(await this.http.getJson("v2/updates/price/latest", query, options.signal), "update"));
    }
    return out;
  }

  async pricesAt(publishTime: number, ids: Iterable<string>, options: PriceRequestOptions = {}): Promise<PriceUpdate[]> {
    const t = unixSeconds("publishTime", publishTime);
    const query = [...idQuery(normalizeFeedIds(ids, MAX_HISTORICAL_FEEDS)), ...flag("ignore_invalid_price_ids", options.ignoreInvalid)];
    return decodeUpdateEnvelope(await this.http.getJson(`v2/updates/price/${t}`, query, options.signal), "update");
  }

  async pricesInInterval(publishTime: number, intervalSeconds: number, ids: Iterable<string>, options: IntervalRequestOptions = {}): Promise<PriceUpdate[]> {
    const t = unixSeconds("publishTime", publishTime);
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 0 || intervalSeconds > MAX_INTERVAL_SECONDS) {
      throw new AstraValidationError(`intervalSeconds must be an integer in [0, ${MAX_INTERVAL_SECONDS}]`);
    }
    const query = [
      ...idQuery(normalizeFeedIds(ids, MAX_HISTORICAL_FEEDS)),
      ...flag("ignore_invalid_price_ids", options.ignoreInvalid),
      ...flag("unique", options.unique),
    ];
    const body = await this.http.getJson(`v2/updates/price/${t}/${intervalSeconds}`, query, options.signal);
    return decodeList(body, "updates", decodeUpdateEnvelope).flat();
  }

  async feeds(q: FeedsQuery = {}): Promise<Feed[]> {
    const body = await this.http.getJson("v1/feeds", q.category ? [["category", q.category]] : [], q.signal);
    return decodeList(body, "feeds", decodeFeed);
  }

  async feedIds(q: FeedIdsQuery = {}): Promise<FeedIdMap> {
    const category: Query = q.category ? [["category", q.category]] : [];
    if (q.pythIds === undefined && q.astraIds === undefined) {
      return decodeFeedIdMap(await this.http.getJson("v1/feed-ids", category, q.signal), "feed_ids");
    }
    let pyth = q.pythIds === undefined ? [] : uniqueFeedIds(q.pythIds);
    let astra = q.astraIds === undefined ? [] : uniqueFeedIds(q.astraIds);
    const items = new Map<FeedId, FeedIdEntry>();
    const missing = new Set<FeedId>();
    while (pyth.length + astra.length > 0) {
      const np = Math.min(pyth.length, MAX_IDS_PER_URL);
      const na = Math.min(astra.length, MAX_IDS_PER_URL - np);
      const query: Query = [...joined("pyth_ids", pyth.slice(0, np)), ...joined("astra_ids", astra.slice(0, na)), ...category];
      pyth = pyth.slice(np);
      astra = astra.slice(na);
      const page = decodeFeedIdMap(await this.http.getJson("v1/feed-ids", query, q.signal), "feed_ids");
      for (const item of page.items) if (!items.has(item.astraId)) items.set(item.astraId, item);
      for (const id of page.missing ?? []) missing.add(id);
    }
    const sorted = [...items.values()].sort((x, y) => (x.symbol < y.symbol ? -1 : x.symbol > y.symbol ? 1 : 0));
    return { items: sorted, missing: [...missing] };
  }

  async status(options: StatusOptions = {}): Promise<StatusReport> {
    if (!options.feed) return decodeStatusReport(await this.http.getJson("v1/status", [], options.signal), "status");
    const query: Query = [["feed", normalizeFeedId(options.feed)]];
    return decodeStatusReport(await this.http.getJson("v1/status", query, options.signal, [503]), "status");
  }

  async candles(q: CandlesQuery): Promise<Candle[]> {
    if (typeof q.feed !== "string" || q.feed.length === 0 || q.feed.length > 200) throw new AstraValidationError("feed must be a feed id or symbol");
    if (typeof q.resolution !== "string" || !/^[0-9A-Za-z]{1,8}$/.test(q.resolution)) throw new AstraValidationError("invalid resolution");
    const from = unixSeconds("from", q.from);
    const to = unixSeconds("to", q.to);
    if (to < from) throw new AstraValidationError("to must not be before from");
    const query: Query = [
      ["feed", q.feed],
      ["resolution", q.resolution],
      ["from", String(from)],
      ["to", String(to)],
    ];
    return decodeCandles(await this.http.getJson("v1/candles", query, q.signal), "candles");
  }

  subscribe(ids: Iterable<string>, options: SubscribeOptions = {}): Subscription {
    const feedIds = normalizeFeedIds(ids, MAX_IDS_PER_REQUEST);
    const idleTimeoutMs = positive("idleTimeoutMs", options.idleTimeoutMs, 45_000);
    const maxMessageBytes = positive("maxMessageBytes", options.maxMessageBytes, 1024 * 1024);
    const policy = {
      baseDelayMs: positive("reconnectBaseDelayMs", options.reconnectBaseDelayMs, 500),
      maxDelayMs: positive("reconnectMaxDelayMs", options.reconnectMaxDelayMs, 30_000),
      stableAfterMs: positive("stableAfterMs", options.stableAfterMs, 60_000),
    };
    let transport: StreamTransport;
    if ((options.transport ?? "ws") === "ws") {
      if (options.benchmarksOnly) throw new AstraValidationError("benchmarksOnly is supported on the SSE transport only");
      if (!this.webSocket) throw new AstraError("no WebSocket implementation: use Node 22+, a browser, or pass options.WebSocket");
      const url = joinUrl(this.baseUrl, "ws", options.channel ? [["channel", options.channel]] : []);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      transport = new WsTransport({
        url: url.toString(),
        ids: feedIds,
        ignoreInvalid: options.ignoreInvalid ?? false,
        idleTimeoutMs,
        maxMessageBytes,
        WebSocket: this.webSocket,
      });
    } else {
      if (feedIds.length > MAX_IDS_PER_URL) {
        throw new AstraValidationError(
          `SSE carries feed ids in the URL: at most ${MAX_IDS_PER_URL}, got ${feedIds.length}; use transport "ws" for more`,
        );
      }
      const query = [
        ...idQuery(feedIds),
        ...(options.channel ? [["channel", options.channel] as [string, string]] : []),
        ...flag("ignore_invalid_price_ids", options.ignoreInvalid),
        ...flag("benchmarks_only", options.benchmarksOnly),
      ];
      transport = new SseTransport({
        url: joinUrl(this.baseUrl, "v2/updates/price/stream", query).toString(),
        fetch: this.http.config.fetch,
        headers: this.http.config.headers,
        idleTimeoutMs,
        maxMessageBytes,
      });
    }
    return new Subscription(feedIds, transport, policy, { onError: options.onError, onStateChange: options.onStateChange }, options.signal);
  }
}
