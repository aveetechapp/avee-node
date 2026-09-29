import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface Recorded {
  method: string;
  url: URL;
  headers: IncomingMessage["headers"];
  body: string;
}

export type Handler = (req: Recorded, res: ServerResponse, n: number) => void | Promise<void>;

export interface Fake {
  baseUrl: string;
  requests: Recorded[];
  close(): Promise<void>;
}

export async function fake(handler: Handler): Promise<Fake> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rec = { method: req.method ?? "", url: new URL(req.url ?? "/", "http://x"), headers: req.headers, body: Buffer.concat(chunks).toString() };
      requests.push(rec);
      void Promise.resolve(handler(rec, res, requests.length)).catch(() => res.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export function problem(res: ServerResponse, status: number, code: string, detail: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/problem+json", "x-request-id": "req-1", ...headers });
  res.end(JSON.stringify({ type: `https://docs.avee.tech/errors/${code}`, title: code, status, code, detail, request_id: "req-1" }));
}

type Schema = Record<string, unknown>;
export const spec = parse(readFileSync(join(packageRoot, "spec", "openapi.yml"), "utf8")) as Schema;
const components = spec.components as Record<string, Record<string, Schema>>;
export const schemas = components.schemas!;

export function resolve(node: Schema): Schema {
  let n = node;
  while (typeof n.$ref === "string") {
    const [, section, name] = /^#\/components\/(\w+)\/(.+)$/.exec(n.$ref) ?? [];
    const target = components[section!]?.[name!];
    if (!target) throw new Error(`unresolved ${n.$ref}`);
    n = target;
  }
  return n;
}

export type Variant = "required" | "full" | "unknown-values";

export function instance(node: Schema, variant: Variant): unknown {
  const n = resolve(node);
  if (Array.isArray(n.enum)) return variant === "unknown-values" ? "x_future_value" : n.enum[0];
  if (Array.isArray(n.oneOf)) return instance(n.oneOf[0] as Schema, variant);
  switch (n.type) {
    case "object": {
      const props = (n.properties ?? {}) as Record<string, Schema>;
      const required = new Set((n.required ?? []) as string[]);
      const out: Record<string, unknown> = variant !== "required" && Object.keys(props).length > 0 ? { x_future_field: { nested: [1] } } : {};
      for (const [k, v] of Object.entries(props)) if (variant !== "required" || required.has(k)) out[k] = instance(v, variant);
      if (Object.keys(props).length === 0 && n.additionalProperties && typeof n.additionalProperties === "object" && variant !== "required") {
        out.k1 = instance(n.additionalProperties as Schema, variant);
      }
      return out;
    }
    case "array":
      return [instance(n.items as Schema, variant)];
    case "string":
      return n.format === "date-time" ? "2026-09-28T00:00:00Z" : "1";
    case "integer":
      return 1;
    case "number":
      return 1.5;
    case "boolean":
      return true;
    default:
      return "1";
  }
}

export function valid(schema: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(instance(schemas[schema]!, "required") as Record<string, unknown>), ...overrides };
}

export function pair(address: string): Record<string, unknown> {
  return valid("PairInfo", { pair_address: address });
}

export interface SdkCall {
  operation: string;
  method: string;
  path: string;
  pathArgs: string[];
  params: Record<string, unknown>;
  query: [string, string][];
  body: unknown;
  response: string;
  paged: boolean;
}

export const calls = JSON.parse(readFileSync(join(packageRoot, "spec", "sdk-calls.json"), "utf8")) as SdkCall[];

export function activeTimers(): number {
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
}
