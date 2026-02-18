import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPairingKvEntry,
  buildRuntimeKvRecord,
  generatePairingCode,
  PAIRING_TTL_SECONDS,
} from "../src/model.js";

test("buildRuntimeKvRecord returns stable shape", () => {
  const record = buildRuntimeKvRecord({
    keyId: "rk_1",
    keyHash: "abc",
    hmacSecretBinding: "PINCER_HMAC_SECRET_ACTIVE",
    skewSeconds: 30,
    nowIso: "2026-02-15T00:00:00.000Z",
  });

  assert.deepEqual(record, {
    id: "rk_1",
    keyHash: "abc",
    hmacSecretBinding: "PINCER_HMAC_SECRET_ACTIVE",
    skewSeconds: 30,
    updatedAt: "2026-02-15T00:00:00.000Z",
  });
});

test("generatePairingCode returns XXXX-XXXX format", () => {
  const bytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
  const code = generatePairingCode(bytes);
  assert.match(code, /^[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/);
});

test("buildPairingKvEntry returns correct key, value, and ttl", () => {
  const entry = buildPairingKvEntry({
    code: "ABCD-1234",
    workerUrl: "https://pincer.example.workers.dev",
    runtimeKey: "rk_1.secret",
    hmacSecret: "hmac",
  });

  assert.equal(entry.key, "pairing:ABCD-1234");
  assert.equal(entry.ttl, PAIRING_TTL_SECONDS);
  const parsed = JSON.parse(entry.value);
  assert.equal(parsed.workerUrl, "https://pincer.example.workers.dev");
  assert.equal(parsed.runtimeKey, "rk_1.secret");
  assert.equal(parsed.hmacSecret, "hmac");
});
