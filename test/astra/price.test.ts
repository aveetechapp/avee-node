import { describe, expect, it } from "vitest";
import { AstraValidationError, Price } from "../../src/astra/index.js";

describe("Price", () => {
  it("renders the exact decimal", () => {
    expect(new Price("83095442500000", "1", -9, 0).toDecimalString()).toBe("83095.4425");
    expect(new Price("-12345", "1", -2, 0).toDecimalString()).toBe("-123.45");
    expect(new Price("5", "1", -3, 0).toDecimalString()).toBe("0.005");
    expect(new Price("-5", "1", -3, 0).toDecimalString()).toBe("-0.005");
    expect(new Price("12", "1", 3, 0).toDecimalString()).toBe("12000");
    expect(new Price("0", "0", -8, 0).toDecimalString()).toBe("0");
    expect(new Price("-0", "0", 2, 0).toDecimalString()).toBe("0");
    expect(new Price("000123", "1", -1, 0).toDecimalString()).toBe("12.3");
    expect(new Price("1000", "1", -3, 0).toDecimalString()).toBe("1");
  });

  it("converts to a correctly rounded float", () => {
    expect(new Price("83095442500000", "4947500000", -9, 0).toNumber()).toBe(83095.4425);
    expect(new Price("83095442500000", "4947500000", -9, 0).confToNumber()).toBe(4.9475);
    expect(new Price("1", "0", 2, 0).toNumber()).toBe(100);
  });

  it("scales without float loss and truncates toward zero", () => {
    const p = new Price("83095442500000", "4947500000", -9, 0);
    expect(p.scaled(18)).toBe(83095442500000000000000n);
    expect(p.scaled(2)).toBe(8309544n);
    expect(p.scaled(0)).toBe(83095n);
    expect(p.confScaled(6)).toBe(4947500n);
    expect(new Price("-12345", "0", -2, 0).scaled(1)).toBe(-1234n);
    expect(new Price("7", "0", 3, 0).scaled(2)).toBe(700000n);
    const huge = new Price("9".repeat(40), "0", -8, 0);
    expect(huge.scaled(77)).toBe(BigInt("9".repeat(40)) * 10n ** 69n);
  });

  it("refuses a bad decimals count", () => {
    const p = new Price("1", "0", -8, 0);
    expect(() => p.scaled(-1)).toThrow(AstraValidationError);
    expect(() => p.scaled(1.5)).toThrow(AstraValidationError);
    expect(() => p.scaled(78)).toThrow(AstraValidationError);
  });
});
