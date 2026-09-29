import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageRoot, resolve, schemas, spec } from "./fake.js";

type Schema = Record<string, unknown>;
const contract = JSON.parse(readFileSync(join(packageRoot, "spec", "sdk-contract.json"), "utf8")) as {
  operations: Record<string, { method: string; path: string; params: string[]; response: string }>;
  fields: Record<string, Record<string, string>>;
};

function contractType(n: Schema): string {
  if (typeof n.$ref === "string") return `#${n.$ref.split("/").pop()}`;
  if (n.oneOf) return "oneOf";
  if (n.type === "array") return `${contractType(n.items as Schema)}[]`;
  if (n.type === "object") {
    if (n.additionalProperties && typeof n.additionalProperties === "object") return `map<${contractType(n.additionalProperties as Schema)}>`;
    return n.properties ? "object" : "map<any>";
  }
  if (Array.isArray(n.enum)) return "string";
  return typeof n.type === "string" ? n.type : "any";
}

describe("contract with spec/openapi.yml", () => {
  it.each(Object.entries(contract.operations))("still serves %s with every parameter the SDK sends", (id, op) => {
    const item = (spec.paths as Record<string, Record<string, Schema>>)[op.path]?.[op.method.toLowerCase()];
    expect(item?.operationId, `${op.method} ${op.path}`).toBe(id);
    const names = ((item!.parameters ?? []) as Schema[]).map((p) => resolve(p).name);
    for (const p of op.params) expect(names, `${id} ${p}`).toContain(p);
    expect(contractType(((item!.responses as Record<string, Schema>)["200"]!.content as Record<string, Schema>)["application/json"]!.schema as Schema)).toBe(`#${op.response}`);
  });

  for (const [schema, fields] of Object.entries(contract.fields)) {
    it.each(Object.entries(fields))(`${schema}.%s keeps type %s`, (path, want) => {
      let node: Schema = schemas[schema]!;
      for (const part of path.split(".")) node = ((resolve(node).properties ?? {}) as Record<string, Schema>)[part]!;
      expect(node, `${schema}.${path}`).toBeDefined();
      expect(contractType(node)).toBe(want.startsWith("oneOf<") ? "oneOf" : want);
    });
  }

  const scripts = join(packageRoot, "..", "scripts");
  it.skipIf(!existsSync(join(scripts, "rename.mjs")))("has the names from names.json applied", () => {
    expect(() => execFileSync("node", [join(scripts, "rename.mjs"), "--check"], { stdio: "pipe" })).not.toThrow();
  });

  it.skipIf(!existsSync(join(scripts, "generate.mjs")))("has generated code matching the spec copy", () => {
    expect(() => execFileSync("node", [join(scripts, "generate.mjs"), "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
