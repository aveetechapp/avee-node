import { AstraValidationError } from "./errors.js";

export const MIN_EXPO = -32;
export const MAX_EXPO = 32;
export const MAX_SCALE_DECIMALS = 77;

export class Price {
  readonly price: string;
  readonly conf: string;
  readonly expo: number;
  readonly publishTime: number;

  constructor(price: string, conf: string, expo: number, publishTime: number) {
    this.price = price;
    this.conf = conf;
    this.expo = expo;
    this.publishTime = publishTime;
  }

  toNumber(): number {
    return toNumber(this.price, this.expo);
  }

  toDecimalString(): string {
    return toDecimalString(this.price, this.expo);
  }

  scaled(decimals: number): bigint {
    return scale(this.price, this.expo, decimals);
  }

  confToNumber(): number {
    return toNumber(this.conf, this.expo);
  }

  confScaled(decimals: number): bigint {
    return scale(this.conf, this.expo, decimals);
  }
}

function toNumber(mantissa: string, expo: number): number {
  return Number(`${mantissa}e${expo}`);
}

function toDecimalString(mantissa: string, expo: number): string {
  const negative = mantissa.startsWith("-");
  const digits = (negative ? mantissa.slice(1) : mantissa).replace(/^0+(?=\d)/, "");
  let out: string;
  if (expo >= 0) {
    out = digits === "0" ? "0" : digits + "0".repeat(expo);
  } else {
    const places = -expo;
    const padded = digits.padStart(places + 1, "0");
    const whole = padded.slice(0, padded.length - places);
    const frac = padded.slice(padded.length - places).replace(/0+$/, "");
    out = frac ? `${whole}.${frac}` : whole;
  }
  return negative && out !== "0" ? `-${out}` : out;
}

function scale(mantissa: string, expo: number, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_SCALE_DECIMALS) {
    throw new AstraValidationError(`decimals must be an integer in [0, ${MAX_SCALE_DECIMALS}], got ${decimals}`);
  }
  const value = BigInt(mantissa);
  const shift = expo + decimals;
  return shift >= 0 ? value * 10n ** BigInt(shift) : value / 10n ** BigInt(-shift);
}
