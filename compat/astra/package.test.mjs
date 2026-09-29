import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { it } from "node:test";

const require = createRequire(import.meta.url);

it("resolves the same public names from import and require", async () => {
  const esm = await import("@avee/sdk/astra");
  const cjs = require("@avee/sdk/astra");
  assert.deepEqual(Object.keys(cjs).filter((k) => k !== "__esModule").sort(), Object.keys(esm).sort());
  assert.equal(new cjs.Price("150", "1", -2, 1).toDecimalString(), "1.5");
  assert.ok(new cjs.AstraValidationError("x") instanceof cjs.AstraError);
  assert.equal(require("@avee/sdk/package.json").name, "@avee/sdk");
});
