import { describe, expect, it } from "vitest";
import { AstraValidationError, normalizeFeedId } from "../../src/astra/index.js";
import { normalizeFeedIds } from "../../src/astra/ids.js";
import { BTC, ETH } from "./fake-astra.js";

describe("feed ids", () => {
  it("accepts any spelling and returns lower-case hex without 0x", () => {
    expect(normalizeFeedId(`0x${BTC.toUpperCase()}`)).toBe(BTC);
    expect(normalizeFeedId(`0X${BTC}`)).toBe(BTC);
    expect(normalizeFeedId(BTC)).toBe(BTC);
  });

  it("rejects malformed ids", () => {
    for (const bad of ["", "0x", BTC.slice(1), `${BTC}0`, `${BTC.slice(1)}g`, ` ${BTC}`, 42 as unknown as string]) {
      expect(() => normalizeFeedId(bad)).toThrow(AstraValidationError);
    }
  });

  it("dedupes and bounds a batch", () => {
    expect(normalizeFeedIds([BTC, `0x${BTC}`, ETH], 500)).toEqual([BTC, ETH]);
    expect(() => normalizeFeedIds([], 500)).toThrow(/at least one/);
    const many = Array.from({ length: 3 }, (_, i) => i.toString(16).padStart(64, "0"));
    expect(() => normalizeFeedIds(many, 2)).toThrow(/at most 2/);
  });
});
