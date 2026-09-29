import { AveeValidationError } from "./errors.js";

export type Query = Array<readonly [string, string]>;
export type ChainInput = string | number;

export interface RequestOptions {
  signal?: AbortSignal | undefined;
  maxPages?: number | undefined;
}

export interface Call {
  operation: string;
  method: "GET" | "POST";
  path: string;
  query: Query;
  body?: unknown;
  check: (value: unknown) => void;
}

interface Bounds {
  required?: boolean;
  min?: number;
  max?: number;
  uuid?: boolean;
  itemMin?: number;
  itemMax?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string): never {
  throw new AveeValidationError(message);
}

function checkLength(name: string, value: string, b: Bounds): void {
  const n = [...value].length;
  if ((b.min !== undefined && n < b.min) || (b.max !== undefined && n > b.max)) {
    fail(`${name} must be ${b.min ?? 0} to ${b.max ?? "any"} characters, got ${n}`);
  }
  if (b.uuid && !UUID.test(value)) fail(`${name} must be a UUID`);
}

export function pathParam(name: string, value: ChainInput, b: Bounds): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a non-negative integer or a string`);
    value = String(value);
  }
  if (typeof value !== "string") fail(`${name} must be a string`);
  const v = value.trim();
  if (v === "" || v === "." || v === "..") fail(`${name} must not be empty`);
  checkLength(name, v, b);
  return encodeURIComponent(v);
}

function missing(name: string, value: unknown, b: Bounds): boolean {
  if (value !== undefined && value !== null) return false;
  if (b.required) fail(`${name} is required`);
  return true;
}

export function qString(q: Query, name: string, value: string | undefined, b: Bounds): void {
  if (missing(name, value, b)) return;
  if (typeof value !== "string") fail(`${name} must be a string`);
  if (b.required && value === "") fail(`${name} is required`);
  checkLength(name, value, b);
  q.push([name, value]);
}

export function qInteger(q: Query, name: string, value: number | undefined, b: Bounds): void {
  if (missing(name, value, b)) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(`${name} must be an integer`);
  if ((b.min !== undefined && value < b.min) || (b.max !== undefined && value > b.max)) fail(`${name} is out of range: ${value}`);
  q.push([name, String(value)]);
}

export function qNumber(q: Query, name: string, value: number | undefined, b: Bounds): void {
  if (missing(name, value, b)) return;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${name} must be a finite number`);
  if ((b.min !== undefined && value < b.min) || (b.max !== undefined && value > b.max)) fail(`${name} is out of range: ${value}`);
  q.push([name, String(value)]);
}

export function qBoolean(q: Query, name: string, value: boolean | undefined, b: Bounds): void {
  if (missing(name, value, b)) return;
  if (typeof value !== "boolean") fail(`${name} must be a boolean`);
  q.push([name, String(value)]);
}

export function qList(q: Query, name: string, values: readonly (string | number)[] | undefined, b: Bounds): void {
  if (missing(name, values, b)) return;
  if (!Array.isArray(values)) fail(`${name} must be an array`);
  if (values.length === 0) {
    if (b.required || (b.min ?? 0) > 0) fail(`${name} needs at least one value`);
    return;
  }
  checkItems(name, values, b);
  const parts = values.map((v, i) => {
    const s = String(v).trim();
    if (s === "" || s.includes(",")) fail(`${name}[${i}] must be a non-empty value without commas`);
    checkLength(`${name}[${i}]`, s, { min: b.itemMin, max: b.itemMax } as Bounds);
    return s;
  });
  q.push([name, parts.join(",")]);
}

export function checkItems(name: string, values: readonly unknown[] | undefined, b: Bounds): void {
  if (!Array.isArray(values)) {
    if (b.required) fail(`${name} must be an array`);
    return;
  }
  if ((b.min !== undefined && values.length < b.min) || (b.max !== undefined && values.length > b.max)) {
    fail(`${name} must hold ${b.min ?? 0} to ${b.max ?? "any"} items, got ${values.length}`);
  }
}

export async function* paginate<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; next_cursor?: string | undefined }>,
  start: string | undefined,
  maxPages: number | undefined,
): AsyncGenerator<T, void, undefined> {
  const loops = new CursorLoop();
  let cursor = start;
  for (let page = 0; maxPages === undefined || page < maxPages; page++) {
    const { items, next_cursor: next } = await fetchPage(cursor);
    yield* items;
    if (!next) return;
    if (loops.repeats(cursor, next)) throw new AveeValidationError(`the server repeated cursor ${next.slice(0, 64)}`);
    cursor = next;
  }
}

export class CursorLoop {
  private mark: string | undefined;
  private steps = 0;
  private span = 0;

  repeats(current: string | undefined, next: string): boolean {
    if (next === current || next === this.mark) return true;
    if (++this.steps >= this.span) {
      this.mark = next;
      this.steps = 0;
      this.span = Math.max(1, 2 * this.span);
    }
    return false;
  }
}
