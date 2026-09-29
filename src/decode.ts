export type Check = (value: unknown) => void;

export class Mismatch extends Error {
  readonly path: string[] = [];

  where(root: string): string {
    return root + this.path.reduceRight((acc, seg) => acc + (seg.startsWith("[") ? seg : `.${seg}`), "");
  }
}

function kind(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

function mismatch(want: string, v: unknown): never {
  throw new Mismatch(`must be ${want}, got ${kind(v)}`);
}

function within(err: unknown, segment: string): unknown {
  if (err instanceof Mismatch) err.path.push(segment);
  return err;
}

export function str(v: unknown): void {
  if (typeof v !== "string") mismatch("a string", v);
}

export function int(v: unknown): void {
  if (!Number.isInteger(v)) mismatch("an integer", v);
}

export function num(v: unknown): void {
  if (typeof v !== "number") mismatch("a number", v);
}

export function bool(v: unknown): void {
  if (typeof v !== "boolean") mismatch("a boolean", v);
}

export function any(): void {}

export function obj(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) mismatch("an object", v);
  return v as Record<string, unknown>;
}

export function req(o: Record<string, unknown>, key: string, check: Check): void {
  const v = o[key];
  if (v === undefined || v === null) throw within(new Mismatch("is missing"), key);
  try {
    check(v);
  } catch (err) {
    throw within(err, key);
  }
}

export function opt(o: Record<string, unknown>, key: string, check: Check): void {
  const v = o[key];
  if (v === null) o[key] = undefined;
  if (v === undefined || v === null) return;
  try {
    check(v);
  } catch (err) {
    throw within(err, key);
  }
}

export function list(check: Check): Check {
  return (v) => {
    if (!Array.isArray(v)) mismatch("an array", v);
    for (let i = 0; i < v.length; i++) {
      try {
        check(v[i]);
      } catch (err) {
        throw within(err, `[${i}]`);
      }
    }
  };
}

export function map(check: Check): Check {
  return (v) => {
    const o = obj(v);
    for (const key in o) {
      try {
        check(o[key]);
      } catch (err) {
        throw within(err, key);
      }
    }
  };
}
