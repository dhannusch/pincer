import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { loadCredentials, writeCredentials, getCredentialsPath } from "../src/credentials.js";

function withTmpHome(fn: (tmpHome: string) => void | Promise<void>) {
  return async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pincer-test-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;

    // Clear env vars to test file-based loading
    const savedEnv: Record<string, string | undefined> = {};
    for (const key of [
      "PINCER_WORKER_URL",
      "PINCER_RUNTIME_KEY",
      "PINCER_HMAC_SECRET",
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    try {
      await fn(tmpHome);
    } finally {
      process.env.HOME = origHome;
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  };
}

test(
  "loadCredentials prefers env vars over file",
  withTmpHome(() => {
    process.env.PINCER_WORKER_URL = "https://env.workers.dev";
    process.env.PINCER_RUNTIME_KEY = "rk_env.secret";
    process.env.PINCER_HMAC_SECRET = "env-hmac";

    const creds = loadCredentials();
    assert.equal(creds.workerUrl, "https://env.workers.dev");
    assert.equal(creds.runtimeKey, "rk_env.secret");
    assert.equal(creds.hmacSecret, "env-hmac");
  })
);

test(
  "loadCredentials loads from file when env vars are not set",
  withTmpHome((tmpHome) => {
    const credsDir = path.join(tmpHome, ".pincer");
    fs.mkdirSync(credsDir, { recursive: true });
    fs.writeFileSync(
      path.join(credsDir, "credentials.json"),
      JSON.stringify({
        workerUrl: "https://file.workers.dev",
        runtimeKey: "rk_file.secret",
        hmacSecret: "file-hmac",
      })
    );

    const creds = loadCredentials();
    assert.equal(creds.workerUrl, "https://file.workers.dev");
    assert.equal(creds.runtimeKey, "rk_file.secret");
    assert.equal(creds.hmacSecret, "file-hmac");
  })
);

test(
  "loadCredentials throws when no env vars and no file",
  withTmpHome(() => {
    assert.throws(() => loadCredentials(), /No credentials found/);
  })
);

test(
  "writeCredentials creates file and directory",
  withTmpHome((tmpHome) => {
    writeCredentials({
      workerUrl: "https://test.workers.dev",
      runtimeKey: "rk_test.secret",
      hmacSecret: "test-hmac",
    });

    const credsPath = path.join(tmpHome, ".pincer", "credentials.json");
    assert.equal(fs.existsSync(credsPath), true);

    const content = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
    assert.equal(content.workerUrl, "https://test.workers.dev");
    assert.equal(content.runtimeKey, "rk_test.secret");
    assert.equal(content.hmacSecret, "test-hmac");
  })
);
