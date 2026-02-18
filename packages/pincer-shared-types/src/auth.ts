import { webcrypto } from "node:crypto";

const textEncoder = new TextEncoder();
const cryptoApi = globalThis.crypto?.subtle ? globalThis.crypto : webcrypto;

type VerifyRequestOptions = {
  method: string;
  path: string;
  timestamp: string | number;
  body: string;
  bodySha256: string;
  signature: string;
  secret: string;
  skewSeconds?: number;
  nowMs?: number;
};

type VerifyFailure = {
  ok: false;
  reason:
    | "missing_secret"
    | "invalid_timestamp"
    | "stale_timestamp"
    | "invalid_body_hash"
    | "invalid_signature";
};

type VerifySuccess = {
  ok: true;
  canonical: string;
  bodySha256: string;
};

export type VerifySignedRequestResult = VerifyFailure | VerifySuccess;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  if (typeof hex !== "string" || hex.length % 2 !== 0) {
    throw new Error("Invalid hex");
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }

  const aBytes = textEncoder.encode(a);
  const bBytes = textEncoder.encode(b);
  const length = Math.max(aBytes.length, bBytes.length);
  let mismatch = aBytes.length === bBytes.length ? 0 : 1;

  for (let i = 0; i < length; i += 1) {
    const aByte = i < aBytes.length ? aBytes[i] : 0;
    const bByte = i < bBytes.length ? bBytes[i] : 0;
    mismatch |= aByte ^ bByte;
  }

  return mismatch === 0;
}

export function normalizeSignature(signature: string): string {
  if (typeof signature !== "string") {
    return "";
  }
  const trimmed = signature.trim();
  if (trimmed.startsWith("v1=")) {
    return trimmed.slice(3);
  }
  return trimmed;
}

export function createCanonicalString(
  method: string,
  path: string,
  timestamp: string | number,
  bodySha256: string
): string {
  return [method.toUpperCase(), path, String(timestamp), bodySha256].join("\n");
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = textEncoder.encode(value);
  const hash = await cryptoApi.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(hash));
}

export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const keyData = textEncoder.encode(secret);
  const key = await cryptoApi.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigBuffer = await cryptoApi.subtle.sign("HMAC", key, textEncoder.encode(value));

  return toHex(new Uint8Array(sigBuffer));
}

export async function verifySignedRequest({
  method,
  path,
  timestamp,
  body,
  bodySha256,
  signature,
  secret,
  skewSeconds = 60,
  nowMs = Date.now(),
}: VerifyRequestOptions): Promise<VerifySignedRequestResult> {
  if (!secret || typeof secret !== "string") {
    return { ok: false, reason: "missing_secret" };
  }

  const ts = Number.parseInt(String(timestamp), 10);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  const currentSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(currentSeconds - ts) > skewSeconds) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const normalizedBodyHash = normalizeSignature(bodySha256);
  const computedBodyHash = await sha256Hex(body);
  if (!constantTimeEqual(normalizedBodyHash, computedBodyHash)) {
    return { ok: false, reason: "invalid_body_hash" };
  }

  const canonical = createCanonicalString(method, path, ts, computedBodyHash);
  const expectedSignature = await hmacSha256Hex(secret, canonical);
  const presentedSignature = normalizeSignature(signature);

  if (!constantTimeEqual(expectedSignature, presentedSignature)) {
    return { ok: false, reason: "invalid_signature" };
  }

  return {
    ok: true,
    canonical,
    bodySha256: computedBodyHash,
  };
}

export function asVersionedSignature(signatureHex: string): string {
  return `v1=${signatureHex}`;
}

export function isHex(value: string): boolean {
  try {
    fromHex(value);
    return true;
  } catch {
    return false;
  }
}
