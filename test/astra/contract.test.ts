import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  decodeCandles,
  decodeFeed,
  decodeFeedIdMap,
  decodeFeedMetadata,
  decodeStatusReport,
  decodeStreamedPriceFeed,
  decodeUpdateEnvelope,
} from "../../src/astra/models.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
type Schema = Record<string, unknown>;
const spec = parse(readFileSync(join(packageRoot, "spec", "astra", "astra.yml"), "utf8")) as Schema;
const contract = JSON.parse(readFileSync(join(packageRoot, "spec", "astra", "sdk-contract.json"), "utf8")) as {
  routes: Record<string, string[]>;
  fields: Record<string, Record<string, string>>;
  enums: Record<string, string[]>;
};
const components = spec.components as Record<string, Record<string, Schema>>;

function resolve(node: Schema): Schema {
  let n = node;
  while (typeof n.$ref === "string") {
    const [, section, name] = /^#\/components\/(\w+)\/(.+)$/.exec(n.$ref) ?? [];
    const target = components[section!]?.[name!];
    if (!target) throw new Error(`unresolved ${n.$ref}`);
    n = target;
  }
  return n;
}

function walk(schemaName: string, path: string): Schema {
  let node = resolve(components.schemas![schemaName]!);
  for (const part of path.split(".")) {
    const isItems = part.endsWith("[]");
    const key = isItems ? part.slice(0, -2) : part;
    const props = node.properties as Record<string, Schema> | undefined;
    const next = props?.[key];
    if (!next) throw new Error(`${schemaName}.${path}: no property ${key}`);
    node = resolve(next);
    if (isItems) {
      if (node.type !== "array") throw new Error(`${schemaName}.${path}: ${key} is not an array`);
      node = resolve(node.items as Schema);
    }
  }
  return node;
}

function instance(node: Schema, full: boolean): unknown {
  const n = resolve(node);
  if ("const" in n) return n.const;
  if (Array.isArray(n.enum)) return n.enum[0];
  if (Array.isArray(n.oneOf)) return instance(n.oneOf[0] as Schema, full);
  switch (n.type) {
    case "object": {
      const props = (n.properties ?? {}) as Record<string, Schema>;
      const required = new Set((n.required ?? []) as string[]);
      const out: Record<string, unknown> = full ? { x_future_field: { nested: [1] } } : {};
      for (const [k, v] of Object.entries(props)) if (full || required.has(k)) out[k] = instance(v, full);
      return out;
    }
    case "array":
      return (n.maxItems as number | undefined) === 0 ? [] : [instance(n.items as Schema, full)];
    case "string":
      return typeof n.pattern === "string" && n.pattern.includes("{64}") ? "ab".repeat(32) : "1";
    case "integer":
      return 1;
    case "number":
      return 1.5;
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return "1";
  }
}

describe("contract with spec/astra.yml", () => {
  it.each(Object.entries(contract.routes))("serves GET %s with the parameters the SDK sends", (route, params) => {
    const op = (spec.paths as Record<string, Record<string, Schema>>)[route]?.get;
    expect(op, route).toBeDefined();
    const names = ((op!.parameters ?? []) as Schema[]).map((p) => resolve(p).name);
    for (const p of params) expect(names, `${route} ${p}`).toContain(p);
  });

  for (const [schema, fields] of Object.entries(contract.fields)) {
    it.each(Object.entries(fields))(`${schema}.%s has type %s`, (path, type) => {
      expect(walk(schema, path).type).toBe(type);
    });
  }

  it.each(Object.entries(contract.enums))("%s still offers every value the SDK types", (ref, values) => {
    const [section, name] = ref.split(".") as [string, string];
    const node = resolve(components[section]![name]!);
    const schema = section === "parameters" ? resolve(node.schema as Schema) : node;
    for (const v of values) expect(schema.enum).toContain(v);
  });

  const decoders: Array<[string, (v: unknown) => unknown]> = [
    ["PriceUpdate", (v) => decodeUpdateEnvelope(v, "x")],
    ["PriceFeed", (v) => decodeStreamedPriceFeed(v, "x")],
    ["PriceFeedMetadata", (v) => decodeFeedMetadata(v, "x")],
    ["Feed", (v) => decodeFeed(v, "x")],
    ["StatusReport", (v) => decodeStatusReport(v, "x")],
    ["FeedIDList", (v) => decodeFeedIdMap(v, "x")],
    ["Bars", (v) => decodeCandles(v, "x")],
  ];

  it.each(decoders)("decodes a %s holding only the required fields", (name, decode) => {
    expect(() => decode(instance(components.schemas![name]!, false))).not.toThrow();
  });

  it.each(decoders)("decodes a %s holding every field plus unknown ones", (name, decode) => {
    expect(() => decode(instance(components.schemas![name]!, true))).not.toThrow();
  });

  it("decodes the spec's own PriceUpdate example", () => {
    const example = resolve(components.schemas!.PriceUpdate!).example;
    expect(decodeUpdateEnvelope(example, "example")[0]?.price.toDecimalString()).toBe("65123.45");
  });

  const renameScript = join(packageRoot, "..", "scripts", "rename.mjs");
  it.skipIf(!existsSync(renameScript))("has the names from names.json applied", () => {
    expect(() => execFileSync("node", [renameScript, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
