import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createCanonicalString, hmacSha256Hex, sha256Hex } from "@pincerclaw/shared-types";
import { createApp } from "../src/index.js";
import { pairingKvKey } from "../src/connect.js";

type KvShape = Record<string, string>;
const RUNTIME_SECRET = "runtime-secret";
const RUNTIME_KEY_HASH = createHash("sha256").update(RUNTIME_SECRET).digest("hex");

function createKvStore(initial: KvShape) {
  const data = new Map(Object.entries(initial));
  return {
    async get(key: string): Promise<string | null> {
      return data.has(key) ? data.get(key) || null : null;
    },
    async put(key: string, value: string): Promise<void> {
      data.set(key, value);
    },
    async delete(key: string): Promise<void> {
      data.delete(key);
    },
    async list(options?: {
      prefix?: string;
      limit?: number;
      cursor?: string;
    }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }> {
      const prefix = options?.prefix || "";
      const limit = options?.limit && options.limit > 0 ? options.limit : 1000;
      const offset = options?.cursor ? Number.parseInt(options.cursor, 10) || 0 : 0;
      const keys = [...data.keys()].filter((key) => key.startsWith(prefix)).sort();
      const page = keys.slice(offset, offset + limit);
      const nextOffset = offset + page.length;

      return {
        keys: page.map((name) => ({ name })),
        list_complete: nextOffset >= keys.length,
        cursor: nextOffset >= keys.length ? undefined : String(nextOffset),
      };
    },
  };
}

const sampleManifest = {
  id: "youtube",
  revision: 1,
  baseUrl: "https://youtube.googleapis.com",
  allowedHosts: ["youtube.googleapis.com"],
  requiredSecrets: ["YOUTUBE_API_KEY"],
  actions: {
    list_channel_videos: {
      method: "GET",
      path: "/youtube/v3/search",
      requestMode: "query",
      auth: {
        placement: "query",
        name: "key",
        secretBinding: "YOUTUBE_API_KEY",
      },
      limits: {
        maxBodyKb: 8,
        timeoutMs: 10000,
        ratePerMinute: 90,
      },
      inputSchema: {
        type: "object",
        required: ["channelId"],
        additionalProperties: false,
        properties: {
          channelId: { type: "string", minLength: 1, maxLength: 128 },
          maxResults: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
    },
  },
};

function makeEnv(overrides: Record<string, unknown> = {}, kvOverrides: KvShape = {}) {
  const baseKv = {
    "meta:version": "2",
    "runtime:active": JSON.stringify({
      id: "rk_1",
      keyHash: RUNTIME_KEY_HASH,
      hmacSecretBinding: "PINCER_HMAC_SECRET_1",
      skewSeconds: 60,
      updatedAt: "2026-02-15T00:00:00Z",
    }),
    "adapter_registry:index": JSON.stringify({
      proposals: [],
      active: {},
    }),
    ...kvOverrides,
  };

  return {
    PINCER_CONFIG_KV: createKvStore(baseKv),
    PINCER_HMAC_SECRET_1: "hmac-secret",
    PINCER_ADMIN_PASSPHRASE: "admin-pass",
    PINCER_SKEW_SECONDS: "60",
    YOUTUBE_API_KEY: "youtube-key",
    ...overrides,
  };
}

async function signedHeaders({
  method,
  path,
  body,
  hmacSecret = "hmac-secret",
}: {
  method: string;
  path: string;
  body: string;
  hmacSecret?: string;
}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyHash = await sha256Hex(body);
  const canonical = createCanonicalString(method, path, timestamp, bodyHash);
  const signature = await hmacSha256Hex(hmacSecret, canonical);

  return {
    authorization: `Bearer rk_1.${RUNTIME_SECRET}`,
    "x-pincer-timestamp": String(timestamp),
    "x-pincer-body-sha256": bodyHash,
    "x-pincer-signature": `v1=${signature}`,
    "content-type": "application/json",
  };
}

function adminHeaders() {
  return {
    "x-pincer-admin-passphrase": "admin-pass",
    "content-type": "application/json",
  };
}

test("health endpoint returns ok", async () => {
  const app = createApp();
  const env = makeEnv();
  const response = await app.fetch(new Request("https://example.com/v1/health"), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.configVersion, "2");
  assert.equal("adapters" in payload, false);
});

test("proposal endpoint accepts runtime-authenticated manifest", async () => {
  const app = createApp();
  const env = makeEnv();
  const body = JSON.stringify({ manifest: sampleManifest });
  const path = "/v1/adapters/proposals";

  const response = await app.fetch(
    new Request(`https://example.com${path}`, {
      method: "POST",
      headers: await signedHeaders({ method: "POST", path, body }),
      body,
    }),
    env
  );

  assert.equal(response.status, 202);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.proposal.adapterId, "youtube");
});

test("proposal endpoint rejects invalid signature", async () => {
  const app = createApp();
  const env = makeEnv();
  const body = JSON.stringify({ manifest: sampleManifest });
  const path = "/v1/adapters/proposals";
  const headers = await signedHeaders({ method: "POST", path, body });
  headers["x-pincer-signature"] = "v1=deadbeef";

  const response = await app.fetch(
    new Request(`https://example.com${path}`, {
      method: "POST",
      headers,
      body,
    }),
    env
  );

  assert.equal(response.status, 401);
});

test("admin can list proposals and apply proposal", async () => {
  const captures: Array<{ url: string; init: RequestInit }> = [];
  const app = createApp({
    fetchImpl: async (url, init) => {
      captures.push({ url: String(url), init: init || {} });
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const env = makeEnv();
  const proposalBody = JSON.stringify({ manifest: sampleManifest });
  const proposalPath = "/v1/adapters/proposals";

  const proposalResponse = await app.fetch(
    new Request(`https://example.com${proposalPath}`, {
      method: "POST",
      headers: await signedHeaders({ method: "POST", path: proposalPath, body: proposalBody }),
      body: proposalBody,
    }),
    env
  );

  const proposalPayload = await proposalResponse.json();
  const proposalId = proposalPayload.proposal.proposalId as string;
  assert.match(proposalId, /^pr_[0-9a-z]+_[0-9a-z]{6}$/);

  const listResponse = await app.fetch(
    new Request("https://example.com/v1/admin/adapters/proposals", {
      method: "GET",
      headers: adminHeaders(),
    }),
    env
  );
  assert.equal(listResponse.status, 200);
  const listPayload = await listResponse.json();
  assert.equal(listPayload.proposals.length, 1);

  const applyResponse = await app.fetch(
    new Request("https://example.com/v1/admin/adapters/apply", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ proposalId }),
    }),
    env
  );

  assert.equal(applyResponse.status, 200);
  const applyPayload = await applyResponse.json();
  assert.equal(applyPayload.result.adapterId, "youtube");

  const auditResponse = await app.fetch(
    new Request("https://example.com/v1/admin/audit?limit=10", {
      method: "GET",
      headers: adminHeaders(),
    }),
    env
  );
  assert.equal(auditResponse.status, 200);
  const auditPayload = await auditResponse.json();
  const eventTypes = new Set(
    (auditPayload.events as Array<{ proposalId: string; eventType: string }>)
      .filter((event) => event.proposalId === proposalId)
      .map((event) => event.eventType)
  );
  assert.equal(eventTypes.has("proposal_submitted"), true);
  assert.equal(eventTypes.has("proposal_approved"), true);

  const callBody = JSON.stringify({ input: { channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw", maxResults: 10 } });
  const callPath = "/v1/adapter/youtube/list_channel_videos";
  const callResponse = await app.fetch(
    new Request(`https://example.com${callPath}`, {
      method: "POST",
      headers: await signedHeaders({ method: "POST", path: callPath, body: callBody }),
      body: callBody,
    }),
    env
  );

  assert.equal(callResponse.status, 200);
  assert.equal(captures.length, 1);
  assert.match(captures[0].url, /youtube\/v3\/search/);
});

test("admin can reject proposal and audit includes reason + manifest", async () => {
  const app = createApp();
  const env = makeEnv();
  const proposalBody = JSON.stringify({ manifest: sampleManifest });
  const proposalPath = "/v1/adapters/proposals";

  const proposalResponse = await app.fetch(
    new Request(`https://example.com${proposalPath}`, {
      method: "POST",
      headers: await signedHeaders({ method: "POST", path: proposalPath, body: proposalBody }),
      body: proposalBody,
    }),
    env
  );
  assert.equal(proposalResponse.status, 202);
  const proposalPayload = await proposalResponse.json();
  const proposalId = proposalPayload.proposal.proposalId as string;

  const rejectResponse = await app.fetch(
    new Request(`https://example.com/v1/admin/adapters/proposals/${proposalId}/reject`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ reason: "malicious scope expansion" }),
    }),
    env
  );
  assert.equal(rejectResponse.status, 200);

  const listResponse = await app.fetch(
    new Request("https://example.com/v1/admin/adapters/proposals", {
      method: "GET",
      headers: adminHeaders(),
    }),
    env
  );
  assert.equal(listResponse.status, 200);
  const listPayload = await listResponse.json();
  assert.equal(listPayload.proposals.length, 0);

  const inspectResponse = await app.fetch(
    new Request(`https://example.com/v1/admin/adapters/proposals/${proposalId}`, {
      method: "GET",
      headers: adminHeaders(),
    }),
    env
  );
  assert.equal(inspectResponse.status, 404);

  const auditResponse = await app.fetch(
    new Request(`https://example.com/v1/admin/audit?limit=10`, {
      method: "GET",
      headers: adminHeaders(),
    }),
    env
  );
  assert.equal(auditResponse.status, 200);
  const auditPayload = await auditResponse.json();
  const rejectEvent = (auditPayload.events as Array<{
    eventType: string;
    proposalId: string;
    reason?: string;
    manifest: { id: string };
  }>).find((event) => event.eventType === "proposal_rejected" && event.proposalId === proposalId);
  assert.ok(rejectEvent);
  assert.equal(rejectEvent?.reason, "malicious scope expansion");
  assert.equal(rejectEvent?.manifest.id, "youtube");
});

test("admin apply rejects when required secrets are missing", async () => {
  const app = createApp();
  const env = makeEnv({ YOUTUBE_API_KEY: undefined });

  const response = await app.fetch(
    new Request("https://example.com/v1/admin/adapters/apply", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ manifest: sampleManifest }),
    }),
    env
  );

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error, "missing_required_secrets");
  assert.deepEqual(payload.missingSecrets, ["YOUTUBE_API_KEY"]);
});

test("disable endpoint disables adapter actions", async () => {
  const app = createApp();
  const env = makeEnv();

  const applyResponse = await app.fetch(
    new Request("https://example.com/v1/admin/adapters/apply", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ manifest: sampleManifest }),
    }),
    env
  );
  assert.equal(applyResponse.status, 200);

  const disableResponse = await app.fetch(
    new Request("https://example.com/v1/admin/adapters/youtube/disable", {
      method: "POST",
      headers: adminHeaders(),
      body: "{}",
    }),
    env
  );
  assert.equal(disableResponse.status, 200);

  const callBody = JSON.stringify({ input: { channelId: "abc" } });
  const callPath = "/v1/adapter/youtube/list_channel_videos";
  const callResponse = await app.fetch(
    new Request(`https://example.com${callPath}`, {
      method: "POST",
      headers: await signedHeaders({ method: "POST", path: callPath, body: callBody }),
      body: callBody,
    }),
    env
  );

  assert.equal(callResponse.status, 403);
  const payload = await callResponse.json();
  assert.equal(payload.error, "action_not_allowed");
});

test("enable endpoint re-enables adapter actions", async () => {
  const app = createApp({
    fetchImpl: async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  const env = makeEnv();

  const applyResponse = await app.fetch(
    new Request("https://example.com/v1/admin/adapters/apply", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ manifest: sampleManifest }),
    }),
    env
  );
  assert.equal(applyResponse.status, 200);

  const disableResponse = await app.fetch(
    new Request("https://example.com/v1/admin/adapters/youtube/disable", {
      method: "POST",
      headers: adminHeaders(),
      body: "{}",
    }),
    env
  );
  assert.equal(disableResponse.status, 200);

  const enableResponse = await app.fetch(
    new Request("https://example.com/v1/admin/adapters/youtube/enable", {
      method: "POST",
      headers: adminHeaders(),
      body: "{}",
    }),
    env
  );
  assert.equal(enableResponse.status, 200);

  const callBody = JSON.stringify({ input: { channelId: "abc" } });
  const callPath = "/v1/adapter/youtube/list_channel_videos";
  const callResponse = await app.fetch(
    new Request(`https://example.com${callPath}`, {
      method: "POST",
      headers: await signedHeaders({ method: "POST", path: callPath, body: callBody }),
      body: callBody,
    }),
    env
  );
  assert.equal(callResponse.status, 200);
});

test("proxy rejects schema-invalid input with 400 invalid_input", async () => {
  const app = createApp();
  const env = makeEnv();

  const applyResponse = await app.fetch(
    new Request("https://example.com/v1/admin/adapters/apply", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ manifest: sampleManifest }),
    }),
    env
  );
  assert.equal(applyResponse.status, 200);

  const callBody = JSON.stringify({ input: {} });
  const callPath = "/v1/adapter/youtube/list_channel_videos";
  const callResponse = await app.fetch(
    new Request(`https://example.com${callPath}`, {
      method: "POST",
      headers: await signedHeaders({ method: "POST", path: callPath, body: callBody }),
      body: callBody,
    }),
    env
  );

  assert.equal(callResponse.status, 400);
  const payload = await callResponse.json();
  assert.equal(payload.error, "invalid_input");
  assert.equal(Array.isArray(payload.details), true);
  assert.equal(payload.details.length > 0, true);
});

test("runtime adapters list returns enabled adapters only", async () => {
  const app = createApp();
  const env = makeEnv();

  const applyResponse = await app.fetch(
    new Request("https://example.com/v1/admin/adapters/apply", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ manifest: sampleManifest }),
    }),
    env
  );
  assert.equal(applyResponse.status, 200);

  const listPath = "/v1/adapters";
  const listResponse = await app.fetch(
    new Request(`https://example.com${listPath}`, {
      method: "GET",
      headers: await signedHeaders({ method: "GET", path: listPath, body: "" }),
    }),
    env
  );
  assert.equal(listResponse.status, 200);
  const listPayload = await listResponse.json();
  assert.equal(listPayload.ok, true);
  assert.equal(listPayload.adapters.length, 1);
  assert.equal(listPayload.adapters[0].adapterId, "youtube");

  const disableResponse = await app.fetch(
    new Request("https://example.com/v1/admin/adapters/youtube/disable", {
      method: "POST",
      headers: adminHeaders(),
      body: "{}",
    }),
    env
  );
  assert.equal(disableResponse.status, 200);

  const listAfterDisable = await app.fetch(
    new Request(`https://example.com${listPath}`, {
      method: "GET",
      headers: await signedHeaders({ method: "GET", path: listPath, body: "" }),
    }),
    env
  );
  assert.equal(listAfterDisable.status, 200);
  const disabledPayload = await listAfterDisable.json();
  assert.equal(disabledPayload.adapters.length, 0);
});

test("connect endpoint returns credentials for valid pairing code", async () => {
  const app = createApp();
  const pairingRecord = JSON.stringify({
    workerUrl: "https://pincer.example.workers.dev",
    runtimeKey: "runtime-key-placeholder",
    hmacSecret: "hmac-secret-value",
  });

  const env = makeEnv({}, { [pairingKvKey("ABCD-1234")]: pairingRecord });

  const response = await app.fetch(
    new Request("https://example.com/v1/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "ABCD-1234" }),
    }),
    env
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.workerUrl, "https://pincer.example.workers.dev");
  assert.equal(payload.runtimeKey, "runtime-key-placeholder");
  assert.equal(payload.hmacSecret, "hmac-secret-value");
});

test("connect endpoint trims whitespace around pairing code", async () => {
  const app = createApp();
  const pairingRecord = JSON.stringify({
    workerUrl: "https://pincer.example.workers.dev",
    runtimeKey: "runtime-key-placeholder",
    hmacSecret: "hmac-secret-value",
  });

  const env = makeEnv({}, { [pairingKvKey("ABCD-1234")]: pairingRecord });

  const response = await app.fetch(
    new Request("https://example.com/v1/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "  abcd-1234  " }),
    }),
    env
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
});

test("connect endpoint rejects invalid pairing code", async () => {
  const app = createApp();
  const env = makeEnv();

  const response = await app.fetch(
    new Request("https://example.com/v1/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "WRONG-CODE" }),
    }),
    env
  );

  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.equal(payload.error, "invalid_or_expired_code");
});

test("connect endpoint deletes code after use (one-time use)", async () => {
  const app = createApp();
  const pairingRecord = JSON.stringify({
    workerUrl: "https://pincer.example.workers.dev",
    runtimeKey: "runtime-key-placeholder",
    hmacSecret: "hmac-secret-value",
  });

  const env = makeEnv({}, { [pairingKvKey("ONCE-CODE")]: pairingRecord });

  const first = await app.fetch(
    new Request("https://example.com/v1/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "ONCE-CODE" }),
    }),
    env
  );
  assert.equal(first.status, 200);

  const second = await app.fetch(
    new Request("https://example.com/v1/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "ONCE-CODE" }),
    }),
    env
  );
  assert.equal(second.status, 404);
});

test("admin doctor endpoint requires auth and returns checks", async () => {
  const app = createApp();
  const env = makeEnv();

  const unauthorized = await app.fetch(new Request("https://example.com/v1/admin/doctor"), env);
  assert.equal(unauthorized.status, 401);

  const authorized = await app.fetch(
    new Request("https://example.com/v1/admin/doctor", {
      headers: adminHeaders(),
    }),
    env
  );

  assert.equal(authorized.status, 200);
  const payload = await authorized.json();
  assert.equal(payload.ok, true);
  assert.equal(Array.isArray(payload.checks), true);
});

test("admin audit endpoint requires auth", async () => {
  const app = createApp();
  const env = makeEnv();

  const unauthorized = await app.fetch(new Request("https://example.com/v1/admin/audit"), env);
  assert.equal(unauthorized.status, 401);
});
