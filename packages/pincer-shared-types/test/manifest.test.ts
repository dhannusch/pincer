import test from "node:test";
import assert from "node:assert/strict";

import {
  stableStringify,
  validateAdapterManifest,
  validateInputWithSchema,
} from "../src/manifest.js";

test("validateAdapterManifest accepts a valid manifest", () => {
  const result = validateAdapterManifest({
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
            maxResults: { type: "integer", minimum: 1, maximum: 50 },
          },
        },
      },
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.manifest.id, "youtube");
    assert.equal(result.manifest.revision, 1);
  }
});

test("validateAdapterManifest rejects disallowed host/path configuration", () => {
  const result = validateAdapterManifest({
    id: "bad",
    revision: 1,
    baseUrl: "https://example.com",
    allowedHosts: ["example.com"],
    requiredSecrets: ["BAD_TOKEN"],
    actions: {
      call: {
        method: "GET",
        path: "https://not-allowed.com/api",
        requestMode: "query",
        auth: {
          placement: "header",
          name: "Authorization",
          secretBinding: "BAD_TOKEN",
        },
        limits: {
          maxBodyKb: 8,
          timeoutMs: 10000,
          ratePerMinute: 10,
        },
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.errors.join("\n"), /resolved host not in allowedHosts/);
  }
});

test("validateInputWithSchema enforces required fields and types", () => {
  const errors = validateInputWithSchema(
    { channelId: 123, unknown: true },
    {
      type: "object",
      required: ["channelId"],
      additionalProperties: false,
      properties: {
        channelId: { type: "string", minLength: 1 },
      },
    }
  );

  assert.deepEqual(errors, [
    "input.channelId: expected string",
    "input.unknown: property is not allowed",
  ]);
});

test("stableStringify returns deterministic key order", () => {
  const one = stableStringify({ b: 1, a: { z: 2, y: 1 } });
  const two = stableStringify({ a: { y: 1, z: 2 }, b: 1 });
  assert.equal(one, two);
});
