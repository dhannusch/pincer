import test from "node:test";
import assert from "node:assert/strict";

import { buildRuntimeKvRecord } from "../src/model.js";

test("buildRuntimeKvRecord returns stable shape", () => {
  const record = buildRuntimeKvRecord({
    keyId: "rk_1",
    keyHash: "abc",
    hmacSecretBinding: "PINCER_HMAC_SECRET_ACTIVE",
    keySecretBinding: "PINCER_RUNTIME_KEY_SECRET_ACTIVE",
    skewSeconds: 30,
    nowIso: "2026-02-15T00:00:00.000Z",
  });

  assert.deepEqual(record, {
    id: "rk_1",
    keyHash: "abc",
    hmacSecretBinding: "PINCER_HMAC_SECRET_ACTIVE",
    keySecretBinding: "PINCER_RUNTIME_KEY_SECRET_ACTIVE",
    skewSeconds: 30,
    updatedAt: "2026-02-15T00:00:00.000Z",
  });
});
