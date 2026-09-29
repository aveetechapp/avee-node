import { describe, expect, it } from "vitest";
import { fullJitter, parseRetryAfter, sleep } from "../../src/astra/backoff.js";

describe("backoff", () => {
  it("draws in [0, min(cap, base * 2^attempt))", () => {
    expect(fullJitter(0, 500, 30_000, () => 0.999)).toBe(499);
    expect(fullJitter(3, 500, 30_000, () => 0.5)).toBe(2000);
    expect(fullJitter(20, 500, 30_000, () => 0.999)).toBe(29_970);
    expect(fullJitter(1_000, 500, 30_000, () => 0)).toBe(0);
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("soon")).toBeUndefined();
    const now = Date.parse("2026-09-28T00:00:00Z");
    expect(parseRetryAfter("Mon, 28 Sep 2026 00:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfter("Mon, 27 Sep 2026 00:00:05 GMT", now)).toBe(0);
  });

  it("sleep resolves early on abort", async () => {
    const c = new AbortController();
    const started = Date.now();
    const p = sleep(10_000, c.signal);
    c.abort();
    await p;
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
