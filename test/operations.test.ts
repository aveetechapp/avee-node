import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AveeClient, OPERATIONS } from "../src/index.js";
import { activeTimers, calls, type Fake, fake, instance, schemas, spec, type Variant } from "./fake.js";

let body: unknown;
let server: Fake;
let timersBefore: number;

beforeAll(async () => {
  timersBefore = activeTimers();
  server = await fake((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
});

afterAll(async () => {
  await server.close();
  expect(activeTimers()).toBeLessThanOrEqual(timersBefore);
});

function invoke(client: AveeClient, call: (typeof calls)[number]): Promise<unknown> {
  const fn = (client as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[call.operation]!;
  const args: unknown[] = [...call.pathArgs];
  if (Object.keys(call.params).length > 0) args.push(call.params);
  if (call.body !== null) args.push(call.body);
  return fn.apply(client, args);
}

describe("every operation", () => {
  it("covers the spec one to one", () => {
    const specOps = Object.values(spec.paths as Record<string, Record<string, { operationId?: string }>>).flatMap((item) =>
      Object.entries(item)
        .filter(([m]) => m === "get" || m === "post")
        .map(([, op]) => op.operationId),
    );
    expect(OPERATIONS.map((o) => o.id).sort()).toEqual([...specOps].sort());
    expect(calls.map((c) => c.operation).sort()).toEqual([...specOps].sort());
  });

  describe.each(["required", "full", "unknown-values"] as Variant[])("with a %s response", (variant) => {
    it.each(calls.map((c) => [c.operation, c] as const))("%s sends the specified request and returns the body", async (_, call) => {
      body = instance(schemas[call.response]!, variant);
      const client = new AveeClient({ baseUrl: server.baseUrl });
      const before = server.requests.length;
      await expect(invoke(client, call)).resolves.toEqual(body);
      expect(server.requests.length - before).toBe(1);
      const req = server.requests.at(-1)!;
      expect(req.method).toBe(call.method);
      expect(req.url.pathname).toBe(`/api/v1${call.path}`);
      expect([...req.url.searchParams].sort()).toEqual([...call.query].sort());
      if (call.body !== null) {
        expect(JSON.parse(req.body)).toEqual(call.body);
        expect(req.headers["content-type"]).toBe("application/json");
      } else expect(req.body).toBe("");
      expect(req.headers["accept-payment"]).toBeUndefined();
      expect(req.headers["x-api-key"]).toBeUndefined();
      expect(client.lastResponse?.operation).toBe(call.operation);
    });
  });
});
