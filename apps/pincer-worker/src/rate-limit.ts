import { RATE_BUCKET_MS } from "./constants.js";

const rateCounters = new Map<string, number>();

export function enforceRateLimit(
  keyId: string,
  adapter: string,
  action: string,
  limitPerMinute: number,
  nowMs: number
): { ok: true } | { ok: false; reason: "rate_limited" } {
  if (!Number.isFinite(limitPerMinute) || limitPerMinute <= 0) {
    return { ok: true };
  }

  const bucket = Math.floor(nowMs / RATE_BUCKET_MS);
  const counterKey = `${keyId}:${adapter}:${action}:${bucket}`;
  const existing = rateCounters.get(counterKey) || 0;

  if (existing >= limitPerMinute) {
    return { ok: false, reason: "rate_limited" };
  }

  rateCounters.set(counterKey, existing + 1);
  return { ok: true };
}
