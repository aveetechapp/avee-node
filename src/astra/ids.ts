import { AstraValidationError, clip } from "./errors.js";

export type FeedId = string;

export const MAX_IDS_PER_REQUEST = 500;
export const MAX_HISTORICAL_FEEDS = 100;
export const MAX_IDS_PER_URL = 200;

const HEX64 = /^[0-9a-f]{64}$/;

export function normalizeFeedId(id: string): FeedId {
  if (typeof id !== "string") throw new AstraValidationError("feed id must be a string");
  const lower = id.toLowerCase();
  const hex = lower.startsWith("0x") ? lower.slice(2) : lower;
  if (!HEX64.test(hex)) throw new AstraValidationError(`invalid feed id: ${clip(id)}`);
  return hex;
}

export function uniqueFeedIds(ids: Iterable<string>): FeedId[] {
  if (typeof ids === "string") throw new AstraValidationError("feed ids must be a list, not a single string");
  return [...new Set(Array.from(ids, normalizeFeedId))];
}

export function normalizeFeedIds(ids: Iterable<string>, max: number): FeedId[] {
  const unique = uniqueFeedIds(ids);
  if (unique.length === 0) throw new AstraValidationError("at least one feed id is required");
  if (unique.length > max) throw new AstraValidationError(`at most ${max} distinct feed ids per request, got ${unique.length}`);
  return unique;
}
