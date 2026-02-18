import test from "node:test";
import assert from "node:assert/strict";

import {
  asVersionedSignature,
  createCanonicalString,
  hmacSha256Hex,
  sha256Hex,
  verifySignedRequest,
} from "../src/auth.js";

test("verifySignedRequest accepts valid signature", async () => {
  const method = "POST";
  const path = "/v1/adapter/google/drive_list_files";
  const body = JSON.stringify({ input: { q: "mimeType='application/pdf'" } });
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyHash = await sha256Hex(body);
  const canonical = createCanonicalString(method, path, timestamp, bodyHash);
  const signature = await hmacSha256Hex("super-secret", canonical);

  const result = await verifySignedRequest({
    method,
    path,
    timestamp,
    body,
    bodySha256: bodyHash,
    signature: asVersionedSignature(signature),
    secret: "super-secret",
    skewSeconds: 60,
  });

  assert.equal(result.ok, true);
});

test("verifySignedRequest rejects stale timestamp", async () => {
  const method = "POST";
  const path = "/v1/adapter/google/drive_list_files";
  const body = JSON.stringify({ input: {} });
  const timestamp = Math.floor(Date.now() / 1000) - 120;
  const bodyHash = await sha256Hex(body);
  const canonical = createCanonicalString(method, path, timestamp, bodyHash);
  const signature = await hmacSha256Hex("super-secret", canonical);

  const result = await verifySignedRequest({
    method,
    path,
    timestamp,
    body,
    bodySha256: bodyHash,
    signature,
    secret: "super-secret",
    skewSeconds: 60,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "stale_timestamp");
  }
});
