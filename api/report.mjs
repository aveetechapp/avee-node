#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const entries = [
  ["index.d.ts", "public-api.txt"],
  ["astra/index.d.ts", "astra-public-api.txt"],
];
const args = process.argv.slice(2);
const distIndex = args.indexOf("--dist");
const dist = resolve(distIndex >= 0 ? args[distIndex + 1] : join(here, "..", "dist", "esm"));

const flat = (node) => node.getText().replace(/\s+/g, " ").replace(/;$/, "").trim();
const isPrivate = (m) => ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Private || (m.name && ts.isPrivateIdentifier(m.name));

function members(prefix, list) {
  const out = [];
  for (const m of list) {
    if (isPrivate(m)) continue;
    out.push(`${prefix} ${flat(m)}`);
  }
  return out;
}

function describe(name, decl) {
  const models = decl.getSourceFile().fileName.endsWith("generated/models.d.ts");
  if (ts.isInterfaceDeclaration(decl)) {
    const prefix = `${models ? "model" : "interface"} ${name}`;
    const heritage = (decl.heritageClauses ?? []).flatMap((h) => h.types.map((t) => `${prefix} extends ${flat(t)}`));
    return [prefix, ...heritage, ...members(prefix, decl.members)];
  }
  if (ts.isClassDeclaration(decl)) {
    const prefix = `class ${name}`;
    const heritage = (decl.heritageClauses ?? []).flatMap((h) => h.types.map((t) => `${prefix} ${h.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements"} ${flat(t)}`));
    return [prefix, ...heritage, ...members(prefix, decl.members)];
  }
  if (ts.isTypeAliasDeclaration(decl)) {
    const params = decl.typeParameters ? `<${decl.typeParameters.map(flat).join(", ")}>` : "";
    if (ts.isUnionTypeNode(decl.type)) return decl.type.types.map((t) => `type ${name}${params} | ${flat(t)}`);
    return [`type ${name}${params} = ${flat(decl.type)}`];
  }
  if (ts.isFunctionDeclaration(decl)) {
    return [`function ${flat(decl).replace(/^export declare function /, "").replace(/^declare function /, "")}`];
  }
  if (ts.isVariableDeclaration(decl)) {
    let type = decl.type;
    if (type && ts.isTypeOperatorNode(type)) type = type.type;
    if (type && ts.isTupleTypeNode(type)) return type.elements.map((e) => `const ${name} item ${flat(e)}`);
    return [`const ${name}: ${decl.type ? flat(decl.type) : "unknown"}`];
  }
  return [`${ts.SyntaxKind[decl.kind]} ${name}`];
}

function surface(entryName) {
  const entry = join(dist, entryName);
  const program = ts.createProgram([entry], { noEmit: true, skipLibCheck: true, types: [] });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  if (!source) throw new Error(`${entry} is missing; run npm run build first`);
  const lines = new Set();
  for (const exported of checker.getExportsOfModule(checker.getSymbolAtLocation(source))) {
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    for (const decl of symbol.declarations ?? []) for (const line of describe(exported.name, decl)) lines.add(line);
  }
  return [...lines].sort();
}

function problems(baseline, current) {
  const now = new Set(current);
  const before = new Set(baseline);
  const inputs = new Set(baseline.filter((l) => /^interface \S+$/.test(l)));
  const out = baseline.filter((l) => !now.has(l)).map((l) => `removed or changed: ${l}`);
  for (const line of current) {
    if (before.has(line)) continue;
    const m = /^(interface \S+) (?!extends )([^(:?]+)(\??)[(:]/.exec(line);
    if (m && inputs.has(m[1]) && m[3] !== "?") out.push(`new required member on an interface callers may implement or build: ${line}`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let failed = false;
  for (const [entryName, reportName] of entries) {
    const reportPath = join(here, reportName);
    const current = surface(entryName);
    if (args.includes("--update")) {
      writeFileSync(reportPath, `${current.join("\n")}\n`);
      console.log(`api: ${reportName} now describes ${join(dist, entryName)} (${current.length} lines)`);
      continue;
    }
    const found = problems(readFileSync(reportPath, "utf8").trimEnd().split("\n"), current);
    for (const p of found) console.error(`${reportName}: ${p}`);
    if (found.length > 0) failed = true;
    else console.log(`api: the public TypeScript API is compatible with api/${reportName}`);
  }
  if (failed) {
    console.error("api: breaking changes to the public TypeScript API; they wait for a new major version");
    process.exit(1);
  }
}
