import type { IncomingMessage, ServerResponse } from "node:http";
import { BTC, BTC_ASTRA, envelope, type FakeAstra, json, parsed, startFake, text, wsUpdate } from "../../test/astra/fake-astra.ts";

export { BTC, BTC_ASTRA, ETH } from "../../test/astra/fake-astra.ts";
export const UNKNOWN = "1".repeat(64);

const PUBLISH_TIME = 1700000000;

function feedMetadata() {
  return {
    id: BTC,
    attributes: {
      asset_type: "Crypto",
      base: "BTC",
      description: "BITCOIN / US DOLLAR",
      display_symbol: "BTC/USD",
      quote_currency: "USD",
      symbol: "Crypto.BTC/USD",
      min_channel: "real_time",
      astra_id: BTC_ASTRA,
      future: "x",
    },
    market_hours: { is_open: true },
  };
}

function status(stale: boolean) {
  return {
    ready: true,
    feeds: [{ id: BTC_ASTRA, symbol: "Crypto.BTC/USD", status: "trading", age_seconds: 1.5, publish_time: 1, served_publish_time: 1, sources: 3, stale }],
  };
}

function updates(url: URL) {
  return envelope(...url.searchParams.getAll("ids[]").map((id) => parsed(id.replace(/^0x/, ""), "6500000000000", PUBLISH_TIME)));
}

function rest(_req: IncomingMessage, res: ServerResponse, url: URL): void {
  const path = url.pathname;
  if (path === "/v2/price_feeds") return json(res, 200, [feedMetadata()]);
  if (path === `/v2/price_feeds/${BTC}`) return json(res, 200, feedMetadata());
  if (path.startsWith("/v2/price_feeds/")) return text(res, 404, `Price ids not found: ${path.slice(16)}`);
  if (path === "/v2/updates/price/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(`data: ${JSON.stringify(updates(url))}\n\n`);
    return;
  }
  if (path.split("/").length === 6) return json(res, 200, [updates(url)]);
  if (path.startsWith("/v2/updates/price/")) return json(res, 200, updates(url));
  if (path === "/v1/feeds") {
    return json(res, 200, [
      {
        id: BTC_ASTRA,
        pyth_id: BTC,
        symbol: "Crypto.BTC/USD",
        category: "crypto",
        attributes: {},
        live: { status: "trading", price: "6500000", conf: "10", expo: -2, publish_time: 1, timestamp_ms: 1000, served_publish_time: 1, sources: 3 },
      },
    ]);
  }
  if (path === "/v1/feed-ids") {
    return json(res, 200, {
      items: [{ symbol: "Crypto.BTC/USD", asset_type: "Crypto", category: "crypto", astra_id: BTC_ASTRA, pyth_id: BTC }],
      missing: [UNKNOWN],
    });
  }
  if (path === "/v1/status") return url.searchParams.has("feed") ? json(res, 503, status(true)) : json(res, 200, status(false));
  if (path === "/v1/candles") return json(res, 200, { s: "ok", t: [0], o: [1], h: [2], l: [0.5], c: [1.5], v: [0] });
  res.writeHead(404, { "content-type": "application/problem+json" });
  res.end(JSON.stringify({ type: "about:blank", title: "Not Found", status: 404, detail: "no route" }));
}

export function startAstra(): Promise<FakeAstra> {
  return startFake(rest, (socket) => {
    socket.on("message", (data) => {
      const msg = JSON.parse(String(data)) as { type: string; ids: string[] };
      if (msg.type !== "subscribe") return;
      socket.send(JSON.stringify({ type: "response", status: "success" }));
      for (const id of msg.ids) socket.send(wsUpdate(id, "6500000000000", PUBLISH_TIME));
    });
  });
}
