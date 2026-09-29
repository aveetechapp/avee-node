import { AveePaymentError } from "./errors.js";
import type { PaymentRequired, PaymentRequirements } from "./generated/models.js";

const X402_VERSION = 2;
const MAX_SIGNATURE_HEADER = 16 * 1024;

/** What the payer is asked to approve: the operation, and the one `accepts` entry the SDK chose. */
export interface PaymentContext {
  operation: string;
  method: string;
  url: string;
  requirement: PaymentRequirements;
  required: PaymentRequired;
  paymentId: string;
}

/** Either the scheme payload (the SDK wraps it into an x402 v2 PaymentPayload) or a finished `PAYMENT-SIGNATURE` value. */
export type PaymentSignature = { payload: Record<string, unknown> } | { header: string };

/** Signs x402 payments. The SDK never holds a key; without a payer it never pays. */
export interface Payer {
  /** CAIP-2 networks the payer can pay on, most preferred first; omit to take the first `exact` offer. */
  networks?: readonly string[] | undefined;
  /** Return null to decline; the request then fails with AveePaymentError. */
  sign(context: PaymentContext): Promise<PaymentSignature | null | undefined> | PaymentSignature | null | undefined;
}

export interface PaymentReceipt {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string | undefined;
  errorReason?: string | undefined;
}

function toBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): string | undefined {
  try {
    const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

function parseJSON(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function decodeRequired(header: string | null, body: string): Record<string, unknown> | undefined {
  const candidate = header ? parseJSON(fromBase64(header)) : parseJSON(body);
  if (!isObject(candidate)) return undefined;
  const accepts = candidate.accepts;
  return Array.isArray(accepts) && accepts.length > 0 && accepts.every(isObject) ? candidate : undefined;
}

export function parseReceipt(headers: Headers): PaymentReceipt | undefined {
  const value = headers.get("payment-response") ?? headers.get("x-payment-response");
  if (!value) return undefined;
  const parsed = parseJSON(fromBase64(value));
  if (!isObject(parsed)) return undefined;
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    success: parsed.success === true,
    transaction: text(parsed.transaction) ?? "",
    network: text(parsed.network) ?? "",
    payer: text(parsed.payer),
    errorReason: text(parsed.errorReason),
  };
}

function pickRequirement(accepts: readonly Record<string, unknown>[], networks: readonly string[] | undefined): number {
  const exact = (a: Record<string, unknown>) => a.scheme === "exact" && typeof a.network === "string";
  if (!networks || networks.length === 0) return accepts.findIndex(exact);
  for (const n of networks) {
    const i = accepts.findIndex((a) => exact(a) && (a.network as string).toLowerCase() === n.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

const AMOUNT = /^[0-9]{1,78}$/;

function isAmount(v: unknown): v is string {
  return typeof v === "string" && AMOUNT.test(v) && /[1-9]/.test(v);
}

export function offerProblem(a: Record<string, unknown>): string | undefined {
  if (![a.network, a.asset, a.payTo].every((v) => typeof v === "string" && v !== "")) return "it names no network, asset or payee";
  if (!isAmount(a.amount)) return `amount ${JSON.stringify(a.amount)?.slice(0, 100)} is not a positive integer`;
  const max = a.maxAmountRequired;
  if (max === undefined || max === "") return undefined;
  if (!isAmount(max)) return `maxAmountRequired ${JSON.stringify(max)?.slice(0, 100)} is not a positive integer`;
  return BigInt(a.amount) > BigInt(max) ? `amount ${a.amount} exceeds maxAmountRequired ${max}` : undefined;
}

function paymentId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return `avee_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

export async function signPayment(payer: Payer, operation: string, method: string, url: string, raw: Record<string, unknown>): Promise<string> {
  const required = raw as unknown as PaymentRequired;
  const accepts = raw.accepts as Record<string, unknown>[];
  const choice = pickRequirement(accepts, payer.networks);
  if (choice < 0) throw new AveePaymentError("no accepted network the payer supports", operation, required);
  const accepted = accepts[choice]!;
  const problem = offerProblem(accepted);
  if (problem) throw new AveePaymentError(`the offer is malformed: ${problem}`, operation, required);
  const id = paymentId();
  let signature: PaymentSignature | null | undefined;
  try {
    signature = await payer.sign({ operation, method, url, requirement: accepted as unknown as PaymentRequirements, required, paymentId: id });
  } catch (err) {
    throw new AveePaymentError("the payer did not sign", operation, required, { cause: err });
  }
  if (signature === null || signature === undefined) throw new AveePaymentError("the payer declined", operation, required);
  if (!isObject(signature)) throw new AveePaymentError("the payer returned an unusable signature", operation, required);
  if ("header" in signature) {
    if (typeof signature.header !== "string" || signature.header === "" || signature.header.length > MAX_SIGNATURE_HEADER || /[\r\n]/.test(signature.header)) {
      throw new AveePaymentError("the payer returned an unusable PAYMENT-SIGNATURE", operation, required);
    }
    return signature.header;
  }
  if (!isObject(signature.payload)) throw new AveePaymentError("the payer returned no payload", operation, required);
  const payload: Record<string, unknown> = {
    x402Version: typeof raw.x402Version === "number" && raw.x402Version > 0 ? raw.x402Version : X402_VERSION,
    accepted,
    payload: signature.payload,
    extensions: { "payment-identifier": { info: { id } } },
  };
  if (raw.resource !== undefined) payload.resource = raw.resource;
  let header: string;
  try {
    header = toBase64(JSON.stringify(payload));
  } catch (err) {
    throw new AveePaymentError("the signed payload cannot be encoded", operation, required, { cause: err });
  }
  if (header.length > MAX_SIGNATURE_HEADER) throw new AveePaymentError("the signed payload is too large", operation, required);
  return header;
}
