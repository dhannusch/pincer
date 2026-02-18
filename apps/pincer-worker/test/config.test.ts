import test from "node:test";
import assert from "node:assert/strict";

import { getConfigSnapshot } from "../src/config.js";

type KvShape = Record<string, string>;

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

function makeEnv(kvValues: KvShape) {
  return {
    PINCER_CONFIG_KV: createKvStore(kvValues),
    PINCER_SKEW_SECONDS: "60",
  };
}

const manifest = {
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
        ratePerMinute: 120,
      },
      inputSchema: {
        type: "object",
        required: ["channelId"],
        additionalProperties: false,
        properties: {
          channelId: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

const baseKv: KvShape = {
  "meta:version": "2",
  "runtime:active": JSON.stringify({
    id: "rk_1",
    keyHash: "hash",
    hmacSecretBinding: "PINCER_HMAC_SECRET_1",
    skewSeconds: 60,
  }),
  "adapter_registry:index": JSON.stringify({
    proposals: [],
    active: {
      youtube: {
        adapterId: "youtube",
        revision: 1,
        enabled: true,
        updatedAt: "2026-02-17T00:00:00.000Z",
      },
    },
  }),
  "adapter_registry:manifest:youtube:1": JSON.stringify(manifest),
};

test("getConfigSnapshot parses valid KV configuration", async () => {
  const snapshot = await getConfigSnapshot(makeEnv(baseKv), true);
  assert.equal(snapshot.version, "2");
  assert.equal(snapshot.runtime.id, "rk_1");
  assert.equal(snapshot.adapters.youtube.enabled, true);
  assert.equal(snapshot.adapters.youtube.revision, 1);
});

test("getConfigSnapshot rejects invalid registry index", async () => {
  await assert.rejects(
    () =>
      getConfigSnapshot(
        makeEnv({
          ...baseKv,
          "adapter_registry:index": "not-json",
        }),
        true
      ),
    /valid JSON/
  );
});

test("getConfigSnapshot rejects non-boolean enabled flag", async () => {
  await assert.rejects(
    () =>
      getConfigSnapshot(
        makeEnv({
          ...baseKv,
          "adapter_registry:index": JSON.stringify({
            proposals: [],
            active: {
              youtube: {
                adapterId: "youtube",
                revision: 1,
                enabled: "yes",
                updatedAt: "2026-02-17T00:00:00.000Z",
              },
            },
          }),
        }),
        true
      ),
    /enabled must be boolean/
  );
});

test("getConfigSnapshot rejects missing runtime:active", async () => {
  const next = { ...baseKv };
  delete next["runtime:active"];

  await assert.rejects(() => getConfigSnapshot(makeEnv(next), true), /missing KV key runtime:active/);
});
