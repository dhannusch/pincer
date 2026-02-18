import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(dirname, "../src/cli.ts");

function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      ...env,
    },
    timeout: 10_000,
  });
}

function createTempHome(profile?: Record<string, unknown>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pincer-admin-test-"));
  if (profile) {
    const profileDir = path.join(home, ".pincer");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, "admin.json"), JSON.stringify(profile, null, 2));
  }
  return home;
}

function outputFor(result: ReturnType<typeof runCli>): string {
  return `${result.stdout}\n${result.stderr}`;
}

test("adapters secret without subcommand prints secret usage", () => {
  const result = runCli(["adapters", "secret"]);

  assert.equal(result.status, 1);
  assert.match(outputFor(result), /Usage: pincer-admin adapters secret set <binding> \[--worker-name <name>\]/);
});

test("doctor fails fast in non-interactive mode when worker URL is missing", () => {
  const home = createTempHome();
  try {
    const result = runCli(["doctor"], {
      HOME: home,
      PINCER_WORKER_URL: "",
      PINCER_ADMIN_PASSPHRASE: "test-passphrase",
    });
    assert.equal(result.status, 1);
    assert.match(outputFor(result), /Worker URL is required in non-interactive mode\./);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("doctor uses saved profile worker URL when env URL is unset", () => {
  const home = createTempHome({
    workerUrl: "https://127.0.0.1:9",
  });
  try {
    const result = runCli(["doctor", "--json"], {
      HOME: home,
      PINCER_WORKER_URL: "",
      PINCER_ADMIN_PASSPHRASE: "test-passphrase",
    });

    assert.equal(result.status, 1);
    assert.doesNotMatch(outputFor(result), /Worker URL is required in non-interactive mode\./);
    assert.match(outputFor(result), /"name": "health"/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("doctor prefers PINCER_WORKER_URL over saved profile worker URL", () => {
  const home = createTempHome({
    workerUrl: "https://127.0.0.1:9",
  });
  try {
    const result = runCli(["doctor"], {
      HOME: home,
      PINCER_WORKER_URL: "not-a-url",
      PINCER_ADMIN_PASSPHRASE: "test-passphrase",
    });

    assert.equal(result.status, 1);
    assert.match(outputFor(result), /(Invalid URL|Failed to parse URL)/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("doctor persists workerName from PINCER_WORKER_NAME", () => {
  const home = createTempHome();
  try {
    runCli(["doctor"], {
      HOME: home,
      PINCER_WORKER_URL: "https://127.0.0.1:9",
      PINCER_WORKER_NAME: "pincer-from-env",
      PINCER_ADMIN_PASSPHRASE: "test-passphrase",
    });

    const profilePath = path.join(home, ".pincer", "admin.json");
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf8")) as {
      workerName?: string;
    };
    assert.equal(profile.workerName, "pincer-from-env");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("doctor infers and persists workerName from workers.dev URL", () => {
  const home = createTempHome();
  try {
    runCli(["doctor"], {
      HOME: home,
      PINCER_WORKER_URL: "https://pincer-inferred.workers.dev",
      PINCER_WORKER_NAME: "",
      PINCER_ADMIN_PASSPHRASE: "test-passphrase",
    });

    const profilePath = path.join(home, ".pincer", "admin.json");
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf8")) as {
      workerName?: string;
    };
    assert.equal(profile.workerName, "pincer-inferred");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
