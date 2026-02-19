import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createCanonicalString, hmacSha256Hex, sha256Hex } from "@pincerclaw/shared-types";
import { createApp } from "../src/index.js";

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

function makeEnv(overrides: Record<string, unknown> = {}, kvOverrides: KvShape = {}) {
  const baseKv = {
    "meta:version": "2",
    "runtime:active": JSON.stringify({
      id: "rk_1",
      keyHash: RUNTIME_KEY_HASH,
      hmacSecretBinding: "PINCER_HMAC_SECRET_ACTIVE",
      keySecretBinding: "PINCER_RUNTIME_KEY_SECRET_ACTIVE",
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
    PINCER_HMAC_SECRET_ACTIVE: "hmac-secret",
    PINCER_RUNTIME_KEY_SECRET_ACTIVE: RUNTIME_SECRET,
    PINCER_BOOTSTRAP_TOKEN: "bootstrap-token",
    PINCER_VAULT_KEK: "vault-kek",
    PINCER_SKEW_SECONDS: "60",
    ...overrides,
  };
}

async function runtimeHeaders({
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

async function bootstrapAndLogin(app: ReturnType<typeof createApp>, env: Record<string, unknown>) {
  const bootstrapRes = await app.fetch(
    new Request("https://example.com/v1/admin/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "bootstrap-token",
        username: "admin",
        password: "correct horse battery staple",
      }),
    }),
    env as never
  );
  assert.equal(bootstrapRes.status, 200);

  const loginRes = await app.fetch(
    new Request("https://example.com/v1/admin/session/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "correct horse battery staple",
      }),
    }),
    env as never
  );

  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.get("set-cookie") || "";
  const payload = (await loginRes.json()) as { csrfToken?: string };
  assert.equal(typeof payload.csrfToken, "string");

  return {
    cookie,
    csrfToken: String(payload.csrfToken || ""),
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

test("bootstrap endpoint creates first admin and blocks second bootstrap", async () => {
  const app = createApp();
  const env = makeEnv();

  const first = await app.fetch(
    new Request("https://example.com/v1/admin/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "bootstrap-token",
        username: "admin",
        password: "password123456789",
      }),
    }),
    env as never
  );
  assert.equal(first.status, 200);

  const second = await app.fetch(
    new Request("https://example.com/v1/admin/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "bootstrap-token",
        username: "admin2",
        password: "password123456789",
      }),
    }),
    env as never
  );
  assert.equal(second.status, 409);
});

test("login creates cookie session and session is required for admin endpoints", async () => {
  const app = createApp();
  const env = makeEnv();

  const unauthorized = await app.fetch(new Request("https://example.com/v1/admin/doctor"), env as never);
  assert.equal(unauthorized.status, 401);

  const { cookie } = await bootstrapAndLogin(app, env);

  const authorized = await app.fetch(
    new Request("https://example.com/v1/admin/doctor", {
      headers: {
        cookie,
      },
    }),
    env as never
  );
  assert.equal(authorized.status, 200);
});

test("csrf token is required for mutating admin endpoints", async () => {
  const app = createApp();
  const env = makeEnv({ YOUTUBE_API_KEY: "apikey" });
  const auth = await bootstrapAndLogin(app, env);

  const missingCsrf = await app.fetch(
    new Request("https://example.com/v1/admin/adapters/apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: auth.cookie,
      },
      body: JSON.stringify({ manifest: sampleManifest }),
    }),
    env as never
  );
  assert.equal(missingCsrf.status, 403);

  const withCsrf = await app.fetch(
    new Request("https://example.com/v1/admin/adapters/apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: auth.cookie,
        "x-pincer-csrf": auth.csrfToken,
      },
      body: JSON.stringify({ manifest: sampleManifest }),
    }),
    env as never
  );
  assert.equal(withCsrf.status, 200);
});

test("runtime rotate invalidates old runtime credentials", async () => {
  const app = createApp();
  const env = makeEnv();
  const auth = await bootstrapAndLogin(app, env);

  const beforePath = "/v1/adapters";
  const before = await app.fetch(
    new Request(`https://example.com${beforePath}`, {
      method: "GET",
      headers: await runtimeHeaders({ method: "GET", path: beforePath, body: "" }),
    }),
    env as never
  );
  assert.equal(before.status, 200);

  const rotate = await app.fetch(
    new Request("https://example.com/v1/admin/runtime/rotate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: auth.cookie,
        "x-pincer-csrf": auth.csrfToken,
      },
      body: "{}",
    }),
    env as never
  );
  assert.equal(rotate.status, 200);

  const after = await app.fetch(
    new Request(`https://example.com${beforePath}`, {
      method: "GET",
      headers: await runtimeHeaders({ method: "GET", path: beforePath, body: "" }),
    }),
    env as never
  );
  assert.equal(after.status, 401);
});

test("pairing generation via admin API produces code consumable by connect endpoint", async () => {
  const app = createApp();
  const env = makeEnv();
  const auth = await bootstrapAndLogin(app, env);

  const generate = await app.fetch(
    new Request("https://example.com/v1/admin/pairing/generate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: auth.cookie,
        "x-pincer-csrf": auth.csrfToken,
      },
      body: "{}",
    }),
    env as never
  );

  assert.equal(generate.status, 200);
  const payload = (await generate.json()) as { code: string };
  assert.match(payload.code, /^[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/);

  const connect = await app.fetch(
    new Request("https://example.com/v1/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: payload.code }),
    }),
    env as never
  );

  assert.equal(connect.status, 200);
});

test("repeated failed logins trigger lockout backoff", async () => {
  const app = createApp();
  const env = makeEnv();

  const bootstrap = await app.fetch(
    new Request("https://example.com/v1/admin/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "bootstrap-token",
        username: "admin",
        password: "correct horse battery staple",
      }),
    }),
    env as never
  );
  assert.equal(bootstrap.status, 200);

  for (let i = 0; i < 4; i += 1) {
    const failed = await app.fetch(
      new Request("https://example.com/v1/admin/session/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "admin",
          password: "wrong-password",
        }),
      }),
      env as never
    );
    assert.equal(failed.status, 401);
  }

  const locked = await app.fetch(
    new Request("https://example.com/v1/admin/session/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "wrong-password",
      }),
    }),
    env as never
  );
  assert.equal(locked.status, 429);
});

test("session idle timeout expires after 30 minutes", async () => {
  const app = createApp();
  const env = makeEnv();
  const auth = await bootstrapAndLogin(app, env);

  const originalNow = Date.now;
  try {
    const now = originalNow();
    Date.now = () => now + 31 * 60 * 1000;

    const response = await app.fetch(
      new Request("https://example.com/v1/admin/doctor", {
        headers: {
          cookie: auth.cookie,
        },
      }),
      env as never
    );
    assert.equal(response.status, 401);
  } finally {
    Date.now = originalNow;
  }
});

test("active session rotates cookie after 15 minutes", async () => {
  const app = createApp();
  const env = makeEnv();
  const auth = await bootstrapAndLogin(app, env);

  const originalNow = Date.now;
  try {
    const now = originalNow();
    Date.now = () => now + 16 * 60 * 1000;

    const response = await app.fetch(
      new Request("https://example.com/v1/admin/session/me", {
        headers: {
          cookie: auth.cookie,
        },
      }),
      env as never
    );
    assert.equal(response.status, 200);
    assert.equal((response.headers.get("set-cookie") || "").length > 0, true);
  } finally {
    Date.now = originalNow;
  }
});
