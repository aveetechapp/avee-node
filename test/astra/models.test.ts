import { describe, expect, it } from "vitest";
import { AstraValidationError } from "../../src/astra/index.js";
import {
  decodeCandles,
  decodeFeed,
  decodeFeedMetadata,
  decodeStatusReport,
  decodeStreamedPriceFeed,
  decodeUpdateEnvelope,
} from "../../src/astra/models.js";
import { BTC, BTC_ASTRA, envelope, parsed, price } from "./fake-astra.js";

const metadataBody = () => ({
  id: BTC,
  attributes: {
    asset_type: "Crypto",
    base: "BTC",
    description: "BTC priced in USD",
    display_symbol: "BTC/USD",
    quote_currency: "USD",
    symbol: "Crypto.BTC/USD",
    min_channel: "real_time",
    astra_id: BTC_ASTRA,
    schedule: "America/New_York;O,O,O,O,O,O,O;",
  },
  market_hours: { is_open: true, next_open: null, next_close: null },
});

describe("decoders", () => {
  it("decodes a price update envelope", () => {
    const [u] = decodeUpdateEnvelope(envelope(parsed(BTC, "6512345000000", 1790540000)), "u");
    expect(u?.id).toBe(BTC);
    expect(u?.price.toDecimalString()).toBe("65123.45");
    expect(u?.metadata).toEqual({ receiveTime: 1790540000, prevPublishTime: 1790539999 });
  });

  it("treats a missing parsed array as no updates", () => {
    expect(decodeUpdateEnvelope({ binary: { encoding: "hex", data: [] } }, "u")).toEqual([]);
  });

  it("normalizes echoed ids", () => {
    const [u] = decodeUpdateEnvelope(envelope(parsed(`0x${BTC.toUpperCase()}`, "1", 1)), "u");
    expect(u?.id).toBe(BTC);
  });

  it.each([
    ["a non-integer price", { price: "12.5" }],
    ["a numeric price", { price: 125 }],
    ["an empty price", { price: "" }],
    ["a negative conf", { conf: "-1" }],
    ["an absurd expo", { expo: -400 }],
    ["a fractional expo", { expo: -8.5 }],
    ["a publish time in milliseconds", { publish_time: 1790540000000 }],
    ["a negative publish time", { publish_time: -1 }],
    ["a missing publish time", { publish_time: undefined }],
  ])("rejects %s", (_, patch) => {
    const item = parsed(BTC, "1", 1);
    item.price = { ...price("1", 1), ...patch } as ReturnType<typeof price>;
    expect(() => decodeUpdateEnvelope(envelope(item), "u")).toThrow(AstraValidationError);
  });

  it("rejects a malformed id and a missing ema price", () => {
    expect(() => decodeUpdateEnvelope(envelope({ ...parsed(BTC, "1", 1), id: "xyz" }), "u")).toThrow(/id/);
    expect(() => decodeUpdateEnvelope(envelope({ ...parsed(BTC, "1", 1), ema_price: undefined }), "u")).toThrow(/ema_price/);
    expect(() => decodeUpdateEnvelope({ parsed: {} }, "u")).toThrow(/array/);
    expect(() => decodeUpdateEnvelope(null, "u")).toThrow(/object/);
  });

  it("ignores unknown fields everywhere", () => {
    const item = { ...parsed(BTC, "1", 1), future: { nested: [1, 2] }, price: { ...price("1", 1), extra: true } };
    expect(decodeUpdateEnvelope({ ...envelope(item), version: 2 }, "u")).toHaveLength(1);
  });

  it("drops incomplete metadata instead of failing", () => {
    const [u] = decodeUpdateEnvelope(envelope({ ...parsed(BTC, "1", 1), metadata: { slot: 0 } }), "u");
    expect(u?.metadata).toBeUndefined();
  });

  it("decodes a streamed price feed", () => {
    const u = decodeStreamedPriceFeed(
      { id: BTC, price: price("5", 10), ema_price: price("6", 10), metadata: { price_service_receive_time: 11, prev_publish_time: 9 } },
      "f",
    );
    expect(u.metadata).toEqual({ receiveTime: 11, prevPublishTime: 9 });
    expect(decodeStreamedPriceFeed({ id: BTC, price: price("5", 10), ema_price: price("6", 10) }, "f").metadata).toBeUndefined();
  });

  it("decodes feed metadata and keeps only string attributes", () => {
    const body = metadataBody();
    const m = decodeFeedMetadata({ ...body, attributes: { ...body.attributes, weight: 3, future: "x" } }, "m");
    expect(m).toMatchObject({ id: BTC, astraId: BTC_ASTRA, symbol: "Crypto.BTC/USD", base: "BTC", marketOpen: true });
    expect(m.attributes.future).toBe("x");
    expect("weight" in m.attributes).toBe(false);
  });

  it("omits optional attributes and rejects missing required ones", () => {
    const body = metadataBody();
    const { base: _b, schedule: _s, ...rest } = body.attributes;
    const m = decodeFeedMetadata({ ...body, attributes: rest }, "m");
    expect("base" in m).toBe(false);
    expect("schedule" in m).toBe(false);
    const { symbol: _y, ...noSymbol } = body.attributes;
    expect(() => decodeFeedMetadata({ ...body, attributes: noSymbol }, "m")).toThrow(/symbol/);
  });

  it("decodes a native feed, with and without a live price", () => {
    const live = { status: "trading", price: "149606601500", conf: "28398500", expo: -9, publish_time: 10, timestamp_ms: 10_500, served_publish_time: 10, sources: 6 };
    const f = decodeFeed({ id: BTC_ASTRA, pyth_id: BTC, symbol: "Crypto.BTC/USD", category: "crypto", attributes: {}, live }, "f");
    expect(f.live.price?.toDecimalString()).toBe("149.6066015");
    expect(f.pythId).toBe(BTC);
    const { price: _p, conf: _c, ...noData } = live;
    const empty = decodeFeed({ id: BTC_ASTRA, symbol: "X", category: "crypto", attributes: {}, live: { ...noData, status: "no_data" } }, "f");
    expect(empty.live.price).toBeUndefined();
    expect("pythId" in empty).toBe(false);
  });

  it("keeps an unknown status instead of failing", () => {
    const live = { status: "halted_by_regulator", expo: -9, publish_time: 1, timestamp_ms: 1, served_publish_time: 1, sources: 0 };
    expect(decodeFeed({ id: BTC_ASTRA, symbol: "X", category: "new_class", attributes: {}, live }, "f").live.status).toBe("halted_by_regulator");
  });

  it("rejects a live price without conf", () => {
    const live = { status: "trading", price: "1", expo: -9, publish_time: 1, timestamp_ms: 1, served_publish_time: 1, sources: 1 };
    expect(() => decodeFeed({ id: BTC_ASTRA, symbol: "X", category: "c", attributes: {}, live }, "f")).toThrow(/conf/);
  });

  it("decodes a status report", () => {
    const r = decodeStatusReport(
      { ready: true, feeds: [{ id: BTC_ASTRA, symbol: "Crypto.BTC/USD", status: "trading", age_seconds: 0.3, publish_time: 1, served_publish_time: 1, sources: 5, stale: false }] },
      "s",
    );
    expect(r.feeds[0]).toMatchObject({ ageSeconds: 0.3, stale: false });
    expect(() => decodeStatusReport({ ready: true, feeds: [{ id: BTC_ASTRA }] }, "s")).toThrow(AstraValidationError);
  });

  it("decodes candles", () => {
    expect(decodeCandles({ s: "ok", t: [60, 120], o: [1, 2], h: [3, 4], l: [0.5, 1], c: [2, 3], v: [0, 0] }, "c")).toEqual([
      { time: 60, open: 1, high: 3, low: 0.5, close: 2 },
      { time: 120, open: 2, high: 4, low: 1, close: 3 },
    ]);
    expect(decodeCandles({ s: "no_data" }, "c")).toEqual([]);
    expect(() => decodeCandles({ s: "ok", t: [60], o: [], h: [1], l: [1], c: [1] }, "c")).toThrow(/length/);
    expect(() => decodeCandles({ s: "ok", t: [60.5], o: [1], h: [1], l: [1], c: [1] }, "c")).toThrow(/unix/);
    expect(() => decodeCandles({ s: "ok", t: [60], o: ["1"], h: [1], l: [1], c: [1] }, "c")).toThrow(/finite/);
    expect(() => decodeCandles({ s: "error", errmsg: "x" }, "c")).toThrow(/status/);
  });
});
