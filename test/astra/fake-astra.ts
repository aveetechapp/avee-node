import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";

export const BTC = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
export const ETH = "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
export const BTC_ASTRA = "1de769477ecf66f69ca287676658956a211c207a9ca608ad5235bd095b02f4b2";

export function price(value: string, publishTime: number, expo = -8) {
  return { price: value, conf: "1000", expo, publish_time: publishTime };
}

export function parsed(id: string, value: string, publishTime: number) {
  return {
    id,
    price: price(value, publishTime),
    ema_price: price(value, publishTime),
    metadata: { slot: 0, proof_available_time: publishTime, prev_publish_time: publishTime - 1 },
  };
}

export function envelope(...items: unknown[]) {
  return { binary: { encoding: "hex", data: [] }, parsed: items };
}

export function wsUpdate(id: string, value: string, publishTime: number) {
  return JSON.stringify({
    type: "price_update",
    price_feed: {
      id,
      price: price(value, publishTime),
      ema_price: price(value, publishTime),
      metadata: { slot: 0, emitter_chain: 0, price_service_receive_time: publishTime, prev_publish_time: publishTime - 1 },
    },
  });
}

export type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;
export type WsHandler = (socket: WebSocket, url: URL) => void;

export interface FakeAstra {
  url: string;
  requests: URL[];
  wsConnections: number;
  sockets: Set<WebSocket>;
  close(): Promise<void>;
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export function text(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

export async function startFake(handler: Handler, wsHandler?: WsHandler): Promise<FakeAstra> {
  const requests: URL[] = [];
  const connections = new Set<Socket>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    requests.push(url);
    handler(req, res, url);
  });
  server.on("connection", (s) => {
    connections.add(s);
    s.on("close", () => connections.delete(s));
  });
  const wss = new WebSocketServer({ noServer: true });
  const fake: FakeAstra = {
    url: "",
    requests,
    wsConnections: 0,
    sockets: new Set(),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of fake.sockets) s.terminate();
        wss.close();
        for (const c of connections) c.destroy();
        server.close(() => resolve());
      }),
  };
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://fake");
    requests.push(url);
    if (!wsHandler || url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      fake.wsConnections++;
      fake.sockets.add(ws);
      ws.on("close", () => fake.sockets.delete(ws));
      wsHandler(ws, url);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
