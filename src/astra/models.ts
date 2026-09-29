import { AstraValidationError } from "./errors.js";
import { type FeedId, normalizeFeedId } from "./ids.js";
import { MAX_EXPO, MIN_EXPO, Price } from "./price.js";

export type Channel = "real_time" | "fixed_rate@200ms" | "fixed_rate@1000ms";

export type FeedStatus = "trading" | "degraded" | "market_closed" | "reference" | "no_data" | (string & {});

export type Resolution = "1" | "5" | "15" | "60" | "240" | "1D" | "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | (string & {});

export interface UpdateMetadata {
  receiveTime: number;
  prevPublishTime: number;
}

export interface PriceUpdate {
  id: FeedId;
  price: Price;
  emaPrice: Price;
  metadata?: UpdateMetadata;
}

export interface FeedMetadata {
  id: FeedId;
  astraId: FeedId;
  symbol: string;
  assetType: string;
  displaySymbol: string;
  quoteCurrency: string;
  description: string;
  minChannel: string;
  base?: string;
  schedule?: string;
  marketOpen: boolean;
  attributes: Readonly<Record<string, string>>;
}

export interface LiveValue {
  status: FeedStatus;
  price?: Price;
  expo: number;
  publishTime: number;
  timestampMs: number;
  servedPublishTime: number;
  sources: number;
}

export interface Feed {
  id: FeedId;
  pythId?: FeedId;
  symbol: string;
  category: string;
  attributes: Readonly<Record<string, string>>;
  live: LiveValue;
}

export interface FeedIdEntry {
  symbol: string;
  assetType: string;
  category: string;
  astraId: FeedId;
  pythId?: FeedId;
}

export interface FeedIdMap {
  items: FeedIdEntry[];
  missing?: FeedId[];
}

export interface FeedHealth {
  id: FeedId;
  symbol: string;
  status: FeedStatus;
  ageSeconds: number;
  publishTime: number;
  servedPublishTime: number;
  sources: number;
  stale: boolean;
}

export interface StatusReport {
  ready: boolean;
  feeds: FeedHealth[];
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

type Obj = Record<string, unknown>;

const MAX_UNIX_SECONDS = 1e11;
const MAX_UNIX_MS = 1e14;
const MAX_COUNT = 1_000_000;
const SIGNED_INT = /^-?\d{1,80}$/;
const UNSIGNED_INT = /^\d{1,80}$/;

function invalid(path: string, what: string): AstraValidationError {
  return new AstraValidationError(`malformed Astra response at ${path}: ${what}`);
}

function object(v: unknown, path: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw invalid(path, "expected an object");
  return v as Obj;
}

function array(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw invalid(path, "expected an array");
  return v;
}

function string(o: Obj, key: string, path: string): string {
  const v = o[key];
  if (typeof v !== "string") throw invalid(`${path}.${key}`, "expected a string");
  return v;
}

function optionalString(o: Obj, key: string, path: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw invalid(`${path}.${key}`, "expected a string");
  return v;
}

function integer(o: Obj, key: string, path: string, min: number, max: number): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    throw invalid(`${path}.${key}`, `expected an integer in [${min}, ${max}]`);
  }
  return v;
}

function finite(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw invalid(path, "expected a finite number");
  return v;
}

function boolean(o: Obj, key: string, path: string): boolean {
  const v = o[key];
  if (typeof v !== "boolean") throw invalid(`${path}.${key}`, "expected a boolean");
  return v;
}

function feedId(o: Obj, key: string, path: string): FeedId {
  const v = string(o, key, path);
  try {
    return normalizeFeedId(v);
  } catch {
    throw invalid(`${path}.${key}`, "expected a 32-byte hex feed id");
  }
}

function optionalFeedId(o: Obj, key: string, path: string): FeedId | undefined {
  return o[key] === undefined || o[key] === null ? undefined : feedId(o, key, path);
}

function mantissa(o: Obj, key: string, path: string, pattern: RegExp): string {
  const v = string(o, key, path);
  if (!pattern.test(v)) throw invalid(`${path}.${key}`, "expected an integer string");
  return v;
}

function stringRecord(v: unknown, path: string): Record<string, string> {
  const o = object(v, path);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(o)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

export function decodePrice(v: unknown, path: string): Price {
  const o = object(v, path);
  return new Price(
    mantissa(o, "price", path, SIGNED_INT),
    mantissa(o, "conf", path, UNSIGNED_INT),
    integer(o, "expo", path, MIN_EXPO, MAX_EXPO),
    integer(o, "publish_time", path, 0, MAX_UNIX_SECONDS),
  );
}

function update(o: Obj, path: string, metadata: UpdateMetadata | undefined): PriceUpdate {
  const out: PriceUpdate = {
    id: feedId(o, "id", path),
    price: decodePrice(o.price, `${path}.price`),
    emaPrice: decodePrice(o.ema_price, `${path}.ema_price`),
  };
  if (metadata) out.metadata = metadata;
  return out;
}

function metadata(v: unknown, path: string, receiveKey: string): UpdateMetadata | undefined {
  if (v === undefined || v === null) return undefined;
  const o = object(v, path);
  if (o[receiveKey] === undefined || o.prev_publish_time === undefined) return undefined;
  return {
    receiveTime: integer(o, receiveKey, path, 0, MAX_UNIX_SECONDS),
    prevPublishTime: integer(o, "prev_publish_time", path, 0, MAX_UNIX_SECONDS),
  };
}

export function decodeParsedUpdate(v: unknown, path: string): PriceUpdate {
  const o = object(v, path);
  return update(o, path, metadata(o.metadata, `${path}.metadata`, "proof_available_time"));
}

export function decodeStreamedPriceFeed(v: unknown, path: string): PriceUpdate {
  const o = object(v, path);
  return update(o, path, metadata(o.metadata, `${path}.metadata`, "price_service_receive_time"));
}

export function decodeUpdateEnvelope(v: unknown, path: string): PriceUpdate[] {
  const o = object(v, path);
  if (o.parsed === undefined || o.parsed === null) return [];
  return array(o.parsed, `${path}.parsed`).map((p, i) => decodeParsedUpdate(p, `${path}.parsed[${i}]`));
}

export function decodeFeedMetadata(v: unknown, path: string): FeedMetadata {
  const o = object(v, path);
  const ap = `${path}.attributes`;
  const a = object(o.attributes, ap);
  const hours = object(o.market_hours, `${path}.market_hours`);
  const out: FeedMetadata = {
    id: feedId(o, "id", path),
    astraId: feedId(a, "astra_id", ap),
    symbol: string(a, "symbol", ap),
    assetType: string(a, "asset_type", ap),
    displaySymbol: string(a, "display_symbol", ap),
    quoteCurrency: string(a, "quote_currency", ap),
    description: string(a, "description", ap),
    minChannel: string(a, "min_channel", ap),
    marketOpen: boolean(hours, "is_open", `${path}.market_hours`),
    attributes: stringRecord(a, ap),
  };
  const base = optionalString(a, "base", ap);
  if (base !== undefined) out.base = base;
  const schedule = optionalString(a, "schedule", ap);
  if (schedule !== undefined) out.schedule = schedule;
  return out;
}

function liveValue(v: unknown, path: string): LiveValue {
  const o = object(v, path);
  const expo = integer(o, "expo", path, MIN_EXPO, MAX_EXPO);
  const publishTime = integer(o, "publish_time", path, 0, MAX_UNIX_SECONDS);
  const out: LiveValue = {
    status: string(o, "status", path),
    expo,
    publishTime,
    timestampMs: integer(o, "timestamp_ms", path, 0, MAX_UNIX_MS),
    servedPublishTime: integer(o, "served_publish_time", path, 0, MAX_UNIX_SECONDS),
    sources: integer(o, "sources", path, 0, MAX_COUNT),
  };
  if (o.price !== undefined && o.price !== null) {
    out.price = new Price(mantissa(o, "price", path, SIGNED_INT), mantissa(o, "conf", path, UNSIGNED_INT), expo, publishTime);
  }
  return out;
}

export function decodeFeed(v: unknown, path: string): Feed {
  const o = object(v, path);
  const out: Feed = {
    id: feedId(o, "id", path),
    symbol: string(o, "symbol", path),
    category: string(o, "category", path),
    attributes: o.attributes === undefined || o.attributes === null ? {} : stringRecord(o.attributes, `${path}.attributes`),
    live: liveValue(o.live, `${path}.live`),
  };
  const pythId = optionalFeedId(o, "pyth_id", path);
  if (pythId !== undefined) out.pythId = pythId;
  return out;
}

export function decodeFeedIdEntry(v: unknown, path: string): FeedIdEntry {
  const o = object(v, path);
  const out: FeedIdEntry = {
    symbol: string(o, "symbol", path),
    assetType: string(o, "asset_type", path),
    category: string(o, "category", path),
    astraId: feedId(o, "astra_id", path),
  };
  const pythId = optionalFeedId(o, "pyth_id", path);
  if (pythId !== undefined) out.pythId = pythId;
  return out;
}

export function decodeFeedIdMap(v: unknown, path: string): FeedIdMap {
  const o = object(v, path);
  const out: FeedIdMap = { items: decodeList(o.items, `${path}.items`, decodeFeedIdEntry) };
  if (o.missing !== undefined && o.missing !== null) {
    out.missing = array(o.missing, `${path}.missing`).map((m, i) => {
      const mp = `${path}.missing[${i}]`;
      if (typeof m !== "string") throw invalid(mp, "expected a string");
      try {
        return normalizeFeedId(m);
      } catch {
        throw invalid(mp, "expected a 32-byte hex feed id");
      }
    });
  }
  return out;
}

export function decodeStatusReport(v: unknown, path: string): StatusReport {
  const o = object(v, path);
  const feeds = array(o.feeds, `${path}.feeds`).map((f, i): FeedHealth => {
    const fp = `${path}.feeds[${i}]`;
    const fo = object(f, fp);
    const age = finite(fo.age_seconds, `${fp}.age_seconds`);
    return {
      id: feedId(fo, "id", fp),
      symbol: string(fo, "symbol", fp),
      status: string(fo, "status", fp),
      ageSeconds: age,
      publishTime: integer(fo, "publish_time", fp, 0, MAX_UNIX_SECONDS),
      servedPublishTime: integer(fo, "served_publish_time", fp, 0, MAX_UNIX_SECONDS),
      sources: integer(fo, "sources", fp, 0, MAX_COUNT),
      stale: boolean(fo, "stale", fp),
    };
  });
  return { ready: boolean(o, "ready", path), feeds };
}

export function decodeCandles(v: unknown, path: string): Candle[] {
  const o = object(v, path);
  const status = string(o, "s", path);
  if (status === "no_data") return [];
  if (status !== "ok") throw invalid(`${path}.s`, `unexpected status ${JSON.stringify(status).slice(0, 40)}`);
  const t = array(o.t, `${path}.t`);
  const cols = (["o", "h", "l", "c"] as const).map((k) => array(o[k], `${path}.${k}`));
  if (cols.some((c) => c.length !== t.length)) throw invalid(path, "bar arrays differ in length");
  const [open, high, low, close] = cols as [unknown[], unknown[], unknown[], unknown[]];
  return t.map((time, i) => {
    const tt = finite(time, `${path}.t[${i}]`);
    if (!Number.isSafeInteger(tt) || tt < 0 || tt > MAX_UNIX_SECONDS) throw invalid(`${path}.t[${i}]`, "expected unix seconds");
    return {
      time: tt,
      open: finite(open[i], `${path}.o[${i}]`),
      high: finite(high[i], `${path}.h[${i}]`),
      low: finite(low[i], `${path}.l[${i}]`),
      close: finite(close[i], `${path}.c[${i}]`),
    };
  });
}

export function decodeList<T>(v: unknown, path: string, item: (x: unknown, p: string) => T): T[] {
  return array(v, path).map((x, i) => item(x, `${path}[${i}]`));
}
