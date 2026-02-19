import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  password,
  spinner,
  text,
} from "@clack/prompts";
import pc from "picocolors";

import { sha256Hex, validateAdapterManifest, type AdapterManifest } from "@pincerclaw/shared-types";
import { AdminApiClient } from "./admin-api.js";
import { buildRuntimeKvRecord } from "./model.js";

type SetupValues = {
  workerUrl: string;
  workerName: string;
  runtimeKeyId: string;
  runtimeKeySecret: string;
  runtimeKeyHash: string;
  runtimeHmacSecret: string;
  runtimeHmacBinding: string;
  runtimeKeySecretBinding: string;
  bootstrapToken: string;
  vaultKek: string;
};

type SetupInputs = {
  workerName: string;
};

type DoctorArgs = {
  json: boolean;
};

type DoctorResult = {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; details: string }>;
  healthStatus?: number;
  healthError?: string;
};

type AdminRemoteInput = {
  workerUrl: string;
  username: string;
  password: string;
  api: AdminApiClient;
};

type ApplySource =
  | {
      manifest: AdapterManifest;
      sourceLabel: string;
      sourceKind: "file" | "url";
    };

type ProposalAuditEvent = {
  eventId: string;
  eventType: "proposal_submitted" | "proposal_approved" | "proposal_rejected";
  occurredAt: string;
  proposalId: string;
  adapterId: string;
  revision: number;
  actor: string;
  reason?: string;
  manifest: AdapterManifest;
};

const ADMIN_PROFILE_DIR = path.join(os.homedir(), ".pincer");
const ADMIN_PROFILE_PATH = path.join(ADMIN_PROFILE_DIR, "admin.json");
const ROOT = process.cwd();
const STARTUP_PROFILE = loadAdminProfile();
const DEFAULT_WORKER_DIR = path.join(ROOT, "apps", "pincer-worker");
const WORKER_DIR = process.env.PINCER_WORKER_DIR
  ? path.resolve(ROOT, process.env.PINCER_WORKER_DIR)
  : STARTUP_PROFILE.workerDir
    ? path.resolve(STARTUP_PROFILE.workerDir)
  : DEFAULT_WORKER_DIR;
const WRANGLER_LOG_PATH = path.join(ROOT, ".wrangler-logs");
const WRANGLER_TOML_PATH = path.join(WORKER_DIR, "wrangler.toml");
const WRANGLER_TOML_TEMPLATE_PATH = path.join(WORKER_DIR, "wrangler.toml.example");
const KV_BINDING = "PINCER_CONFIG_KV";
const RUNTIME_KEY_NAME = "runtime:active";
const RUNTIME_HMAC_BINDING = "PINCER_HMAC_SECRET_ACTIVE";
const RUNTIME_KEY_SECRET_BINDING = "PINCER_RUNTIME_KEY_SECRET_ACTIVE";

type AdminProfile = {
  workerUrl?: string;
  workerDir?: string;
  workerName?: string;
};

function usage() {
  console.log(`pincer-admin commands:
  pincer-admin setup
  pincer-admin pairing generate
  pincer-admin credentials rotate
  pincer-admin doctor [--json]
  pincer-admin proposals list [--json]
  pincer-admin proposals inspect <proposal-id> [--json]
  pincer-admin proposals approve <proposal-id> [--force]
  pincer-admin proposals reject <proposal-id> [--reason "..."]
  pincer-admin audit list [--limit <n>] [--since <iso>] [--json]
  pincer-admin adapters list [--json]
  pincer-admin adapters apply (--file <path> | --url <url>) [--force]
  pincer-admin adapters validate --file <path> [--json]
  pincer-admin adapters disable <adapter-id>
  pincer-admin adapters enable <adapter-id>
  pincer-admin adapters secret set <binding>
`);
}

function loadAdminProfile(): AdminProfile {
  if (!fs.existsSync(ADMIN_PROFILE_PATH)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(ADMIN_PROFILE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as AdminProfile;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function saveAdminProfile(profile: AdminProfile): void {
  fs.mkdirSync(ADMIN_PROFILE_DIR, { recursive: true });
  fs.writeFileSync(ADMIN_PROFILE_PATH, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
}

function ensureWorkerDir() {
  if (!fs.existsSync(WORKER_DIR)) {
    throw new Error(
      [
        `Missing worker directory at ${WORKER_DIR}.`,
        "Set PINCER_WORKER_DIR to your Worker project path before running setup/secret/pairing commands.",
        "Example: PINCER_WORKER_DIR=/absolute/path/to/pincer-worker pincer-admin setup",
      ].join("\n")
    );
  }
}

function ensureWranglerConfigFile(): void {
  if (fs.existsSync(WRANGLER_TOML_PATH)) {
    return;
  }

  if (!fs.existsSync(WRANGLER_TOML_TEMPLATE_PATH)) {
    throw new Error(
      `Missing wrangler template at ${WRANGLER_TOML_TEMPLATE_PATH}. Reinstall dependencies or restore the file.`
    );
  }

  fs.copyFileSync(WRANGLER_TOML_TEMPLATE_PATH, WRANGLER_TOML_PATH);
}

function parseDoctorArgs(args: string[]): DoctorArgs {
  return {
    json: args.includes("--json"),
  };
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function unwrapPrompt<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Operation cancelled.");
    process.exit(1);
  }

  return value as T;
}

function assertNonEmpty(value: string, field: string): string | undefined {
  if (!value || value.trim().length === 0) {
    return `${field} is required`;
  }

  return undefined;
}

async function runStage<T>(
  startMessage: string,
  successMessage: string,
  task: () => T | Promise<T>,
  failureMessage = `${startMessage} failed`
): Promise<T> {
  const stageSpinner = spinner({ indicator: "timer" });
  stageSpinner.start(startMessage);
  try {
    const result = await task();
    stageSpinner.stop(successMessage);
    return result;
  } catch (error) {
    stageSpinner.stop(failureMessage, 1);
    throw error;
  }
}

async function runWrangler(args: string[], stdinValue = ""): Promise<string> {
  fs.mkdirSync(WRANGLER_LOG_PATH, { recursive: true });

  return await new Promise<string>((resolve, reject) => {
    const child = spawn("npx", ["wrangler", ...args], {
      cwd: WORKER_DIR,
      env: {
        ...process.env,
        WRANGLER_LOG_PATH,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const details = stderr.trim() || stdout.trim() || "wrangler command failed";
        reject(new Error(details));
        return;
      }

      resolve(stdout.trim());
    });

    if (stdinValue.length > 0) {
      child.stdin?.write(stdinValue);
    }
    child.stdin?.end();
  });
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-9;]*m/g, "");
}

function inferWorkerUrl(workerName: string, deployOutput: string): string {
  const cleaned = stripAnsi(deployOutput);
  const workersDevMatch = cleaned.match(/https:\/\/[^\s"'`]+workers\.dev/);
  if (workersDevMatch) {
    return workersDevMatch[0];
  }

  const genericUrlMatch = cleaned.match(/https:\/\/[^\s"'`]+/);
  if (genericUrlMatch) {
    return genericUrlMatch[0];
  }

  return `https://${workerName}.workers.dev`;
}

function parseKvNamespaceId(output: string): string {
  const match = output.match(/id\s*=\s*"([a-f0-9]{32})"/);
  if (!match) {
    throw new Error(`Could not parse KV namespace ID from wrangler output:\n${output}`);
  }
  return match[1];
}

function readWranglerToml(): string {
  ensureWranglerConfigFile();
  return fs.readFileSync(WRANGLER_TOML_PATH, "utf-8");
}

function patchWranglerTomlKvId(namespaceId: string): void {
  const content = readWranglerToml();
  const updated = content.replace(
    /id\s*=\s*"replace-with-your-kv-namespace-id"/,
    `id = "${namespaceId}"`
  );
  if (updated === content) {
    throw new Error("Could not find placeholder KV namespace ID in wrangler.toml");
  }
  fs.writeFileSync(WRANGLER_TOML_PATH, updated);
}

function wranglerTomlHasPlaceholderKvId(): boolean {
  const content = readWranglerToml();
  return content.includes("replace-with-your-kv-namespace-id");
}

async function probeKvNamespace(namespaceId: string): Promise<boolean> {
  try {
    await runWrangler(["kv", "key", "list", "--namespace-id", namespaceId, "--remote"]);
    return true;
  } catch {
    return false;
  }
}

function resetWranglerTomlKvId(): void {
  const content = readWranglerToml();
  const updated = content.replace(
    /id\s*=\s*"[a-f0-9]{32}"/,
    `id = "replace-with-your-kv-namespace-id"`
  );
  fs.writeFileSync(WRANGLER_TOML_PATH, updated);
}

async function ensureKvNamespace(): Promise<string> {
  if (!wranglerTomlHasPlaceholderKvId()) {
    const match = readWranglerToml().match(/id\s*=\s*"([a-f0-9]{32})"/);
    if (match) {
      const existing = match[1];
      if (await probeKvNamespace(existing)) {
        return existing;
      }
      resetWranglerTomlKvId();
    }
  }

  const output = await runWrangler(["kv", "namespace", "create", KV_BINDING]);
  const namespaceId = parseKvNamespaceId(output);
  patchWranglerTomlKvId(namespaceId);
  return namespaceId;
}

async function putKvValue(
  key: string,
  value: string,
  options: { ttlSeconds?: number } = {}
): Promise<void> {
  const args = ["kv", "key", "put", key, value, "--binding", KV_BINDING, "--remote"];
  if (options.ttlSeconds !== undefined) {
    args.push("--ttl", String(options.ttlSeconds));
  }
  await runWrangler(args);
}

async function readKvValue(key: string): Promise<string | null> {
  try {
    return await runWrangler(["kv", "key", "get", key, "--binding", KV_BINDING, "--remote"]);
  } catch {
    return null;
  }
}

async function putSecret(workerName: string, binding: string, value: string): Promise<void> {
  await runWrangler(["secret", "put", binding, "--name", workerName], value);
}

function parseFlag(args: string[], name: string): string | null {
  const idx = args.indexOf(name);
  if (idx === -1) {
    return null;
  }

  if (idx + 1 >= args.length) {
    throw new Error(`Missing value for ${name}`);
  }

  return args[idx + 1];
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, col) =>
    Math.max(header.length, ...rows.map((row) => (row[col] || "").length))
  );
  const format = (row: string[]) => row.map((cell, col) => (cell || "").padEnd(widths[col])).join("  ");
  console.log(format(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(format(row));
  }
}

async function collectSetupInputs(): Promise<SetupInputs> {
  const workerName = unwrapPrompt(
    await text({
      message: "Worker name",
      placeholder: "pincer-worker",
      defaultValue: "pincer-worker",
      validate: (value) => assertNonEmpty(value, "Worker name"),
    })
  );

  return {
    workerName,
  };
}

async function runSetup(args: string[]): Promise<void> {
  intro(pc.bold(pc.cyan("Pincer setup")));
  ensureWorkerDir();
  ensureWranglerConfigFile();

  await runStage("Checking Wrangler prerequisites", "Wrangler is ready", () => {
    return (async () => {
      await runWrangler(["--version"]);
      await runWrangler(["whoami"]);
    })();
  });

  const inputs = await collectSetupInputs();

  const runtimeCreds = await runStage(
    "Generating runtime credentials",
    "Runtime credentials generated",
    async () => {
      const runtimeKeyId = `rk_${randomHex(8)}`;
      const runtimeKeySecret = randomHex(24);
      const runtimeKeyHash = await sha256Hex(runtimeKeySecret);
      const runtimeHmacSecret = randomHex(32);
      return {
        runtimeKeyId,
        runtimeKeySecret,
        runtimeKeyHash,
        runtimeHmacSecret,
      };
    }
  );

  const setupValues: SetupValues = {
    ...inputs,
    workerUrl: "",
    runtimeKeyId: runtimeCreds.runtimeKeyId,
    runtimeKeySecret: runtimeCreds.runtimeKeySecret,
    runtimeKeyHash: runtimeCreds.runtimeKeyHash,
    runtimeHmacSecret: runtimeCreds.runtimeHmacSecret,
    runtimeHmacBinding: RUNTIME_HMAC_BINDING,
    runtimeKeySecretBinding: RUNTIME_KEY_SECRET_BINDING,
    bootstrapToken: randomHex(24),
    vaultKek: randomHex(32),
  };

  await runStage("Provisioning KV namespace", "KV namespace ready", async () => {
    await ensureKvNamespace();
  });

  await runStage("Writing KV configuration", "KV configuration written", async () => {
    await putKvValue("meta:version", "2");
    await putKvValue(
      RUNTIME_KEY_NAME,
      JSON.stringify(
        buildRuntimeKvRecord({
          keyId: setupValues.runtimeKeyId,
          keyHash: setupValues.runtimeKeyHash,
          hmacSecretBinding: setupValues.runtimeHmacBinding,
          keySecretBinding: setupValues.runtimeKeySecretBinding,
        })
      )
    );
    const existingRegistry = await readKvValue("adapter_registry:index");
    if (!existingRegistry) {
      await putKvValue("adapter_registry:index", JSON.stringify({ proposals: [], active: {} }));
    }
  });

  await runStage("Writing Worker secrets", "Worker secrets written", async () => {
    await putSecret(setupValues.workerName, "PINCER_BOOTSTRAP_TOKEN", setupValues.bootstrapToken);
    await putSecret(setupValues.workerName, "PINCER_VAULT_KEK", setupValues.vaultKek);
    await putSecret(
      setupValues.workerName,
      setupValues.runtimeHmacBinding,
      setupValues.runtimeHmacSecret
    );
    await putSecret(
      setupValues.workerName,
      setupValues.runtimeKeySecretBinding,
      setupValues.runtimeKeySecret
    );
  });

  const deployOutput = await runStage("Deploying worker", "Worker deployed", async () =>
    await runWrangler(["deploy", "--name", setupValues.workerName])
  );

  setupValues.workerUrl = await runStage("Resolving Worker URL", "Worker URL resolved", () =>
    inferWorkerUrl(setupValues.workerName, deployOutput)
  );

  saveAdminProfile({
    ...loadAdminProfile(),
    workerUrl: setupValues.workerUrl,
    workerDir: WORKER_DIR,
    workerName: setupValues.workerName,
  });

  note(
    [
      "Complete bootstrap in your browser first:",
      `${setupValues.workerUrl}/admin/bootstrap`,
      "",
      "Bootstrap token:",
      setupValues.bootstrapToken,
      "",
      "After bootstrap, generate a pairing code from UI or CLI:",
      "pincer-admin pairing generate",
      "",
      "Optional env vars to avoid repeated prompts:",
      `export PINCER_WORKER_URL="${setupValues.workerUrl}"`,
      `export PINCER_WORKER_NAME="${setupValues.workerName}"`,
      "export PINCER_ADMIN_USERNAME=\"admin\"",
      "export PINCER_ADMIN_PASSWORD=\"<your-admin-password>\"",
      "Persist them in your shell profile (for example ~/.zshrc).",
    ].join("\n"),
    "Next Steps"
  );

  outro(pc.green("Pincer is ready."));
}

async function runPairingGenerate(): Promise<void> {
  intro(pc.bold(pc.cyan("Pincer pairing generate")));
  const remote = await collectAdminRemoteInput();

  const payload = (await runStage("Generating pairing code", "Pairing code generated", async () =>
    (await requestAdminJson(remote, "POST", "/v1/admin/pairing/generate", {})) as {
      ok: boolean;
      code: string;
      expiresInSeconds: number;
    }
  )) as { ok: boolean; code: string; expiresInSeconds: number };

  const workerHost = remote.workerUrl.replace(/^https?:\/\//, "");
  note(
    [
      "Run this command on your OpenClaw host machine:",
      `pincer-agent connect ${workerHost} --code ${payload.code}`,
      "",
      `Expires in: ${payload.expiresInSeconds} seconds`,
      "Pairing codes are one-time use.",
    ].join("\n"),
    "Connect your OpenClaw host"
  );

  outro(pc.green("Done."));
}

async function runCredentialsRotate(): Promise<void> {
  intro(pc.bold(pc.cyan("Pincer credentials rotate")));
  const remote = await collectAdminRemoteInput();

  note(
    [
      "This will rotate runtime credentials used by pincer-agent.",
      "Existing runtime credentials will stop working immediately after rotation.",
      "You will receive a new one-time pairing code at the end of this command.",
    ].join("\n"),
    "Incident Response Rotation"
  );

  const confirmed = unwrapPrompt(
    await confirm({
      message: "Rotate runtime credentials now?",
      initialValue: false,
    })
  );

  if (!confirmed) {
    cancel("Rotation cancelled.");
    return;
  }

  await runStage("Rotating runtime credentials", "Runtime credentials rotated", async () => {
    await requestAdminJson(remote, "POST", "/v1/admin/runtime/rotate", {});
  });

  const pairing = (await runStage("Generating pairing code", "Pairing code generated", async () =>
    (await requestAdminJson(remote, "POST", "/v1/admin/pairing/generate", {})) as {
      ok: boolean;
      code: string;
      expiresInSeconds: number;
    }
  )) as { ok: boolean; code: string; expiresInSeconds: number };

  const workerHost = remote.workerUrl.replace(/^https?:\/\//, "");

  note(
    [
      "Rotation complete.",
      "Any previously issued runtime credentials are now invalid.",
      "Reconnect agent hosts with:",
      `pincer-agent connect ${workerHost} --code ${pairing.code}`,
      `Pairing code expires in ${pairing.expiresInSeconds} seconds.`,
    ].join("\n"),
    "Rotation Result"
  );

  outro(pc.green("Done."));
}

async function collectAdminRemoteInput(): Promise<AdminRemoteInput> {
  const profile = loadAdminProfile();
  const envWorkerUrl = (process.env.PINCER_WORKER_URL || "").trim();
  const profileWorkerUrl = (profile.workerUrl || "").trim();
  const envWorkerName = (process.env.PINCER_WORKER_NAME || "").trim();
  const profileWorkerName = (profile.workerName || "").trim();
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  let workerUrl = "";
  if (envWorkerUrl.length > 0) {
    workerUrl = envWorkerUrl;
  } else if (profileWorkerUrl.length > 0) {
    workerUrl = profileWorkerUrl;
  } else if (!isInteractive) {
    throw new Error(
      [
        "Worker URL is required in non-interactive mode.",
        "Set PINCER_WORKER_URL, or run an interactive admin command once to store ~/.pincer/admin.json workerUrl.",
      ].join(" ")
    );
  } else {
    workerUrl = unwrapPrompt(
      await text({
        message: "Worker URL",
        defaultValue: profileWorkerUrl || undefined,
        validate: (value) => assertNonEmpty(value, "Worker URL"),
      })
    );
  }

  let inferredWorkerName = "";
  try {
    const host = new URL(workerUrl).host;
    if (host.endsWith(".workers.dev")) {
      inferredWorkerName = host.slice(0, -".workers.dev".length);
    }
  } catch {
    // ignore parse errors and keep current workerName defaults
  }

  const workerName = envWorkerName || profileWorkerName || inferredWorkerName;
  saveAdminProfile({
    ...profile,
    workerUrl,
    ...(workerName ? { workerName } : {}),
  });

  const usernameFromEnv = (process.env.PINCER_ADMIN_USERNAME || "").trim();
  const passwordFromEnv = (process.env.PINCER_ADMIN_PASSWORD || "").trim();
  if (!isInteractive && usernameFromEnv.length === 0) {
    throw new Error("Admin username is required in non-interactive mode. Set PINCER_ADMIN_USERNAME.");
  }
  if (!isInteractive && passwordFromEnv.length === 0) {
    throw new Error("Admin password is required in non-interactive mode. Set PINCER_ADMIN_PASSWORD.");
  }

  const username =
    usernameFromEnv.length > 0
      ? usernameFromEnv
      : unwrapPrompt(
          await text({
            message: "Admin username",
            defaultValue: "admin",
            validate: (value) => assertNonEmpty(value, "Admin username"),
          })
        );

  const passwordValue =
    passwordFromEnv.length > 0
      ? passwordFromEnv
      : unwrapPrompt(
          await password({
            message: "Admin password",
            mask: "*",
            validate: (value) => assertNonEmpty(value, "Admin password"),
          })
        );

  const api = new AdminApiClient({
    workerUrl,
    username,
    password: passwordValue,
  });

  return {
    workerUrl,
    username,
    password: passwordValue,
    api,
  };
}

async function requestAdminJson(
  input: AdminRemoteInput,
  method: "GET" | "POST" | "PUT" | "DELETE",
  pathName: string,
  payload?: unknown
): Promise<unknown> {
  return input.api.request(method, pathName, payload);
}

async function requestDoctorReport(input: AdminRemoteInput): Promise<DoctorResult> {
  const result: DoctorResult = {
    ok: false,
    checks: [],
  };

  const healthUrl = new URL("/v1/health", input.workerUrl);
  try {
    const healthResponse = await fetch(healthUrl, { method: "GET" });
    result.healthStatus = healthResponse.status;

    if (!healthResponse.ok) {
      result.healthError = await healthResponse.text();
      result.checks.push({
        name: "health",
        ok: false,
        details: `status ${healthResponse.status}`,
      });
    } else {
      result.checks.push({ name: "health", ok: true, details: "reachable" });
    }
  } catch (error) {
    result.healthError = error instanceof Error ? error.message : String(error);
    result.checks.push({
      name: "health",
      ok: false,
      details: result.healthError,
    });
    return result;
  }

  try {
    const payload = (await requestAdminJson(input, "GET", "/v1/admin/doctor")) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; details: string }>;
    };

    result.checks.push({ name: "admin_auth", ok: true, details: "authorized" });
    result.checks.push(...payload.checks);
    result.ok = payload.ok && result.checks.every((check) => check.ok);
    return result;
  } catch (error) {
    result.checks.push({
      name: "admin_auth",
      ok: false,
      details: error instanceof Error ? error.message : String(error),
    });
    result.ok = false;
    return result;
  }
}

function printDoctorHuman(result: DoctorResult): void {
  for (const check of result.checks) {
    const status = check.ok ? pc.green("OK") : pc.red("FAIL");
    console.log(`${status}  ${check.name}  ${check.details}`);
  }

  if (result.ok) {
    log.success("All readiness checks passed.");
  } else {
    log.error("Readiness checks failed.");
  }
}

async function runDoctor(args: string[]): Promise<void> {
  const parsed = parseDoctorArgs(args);
  const remote = await collectAdminRemoteInput();

  const checkSpinner = spinner({ indicator: "timer" });
  checkSpinner.start("Running remote readiness checks");
  const result = await requestDoctorReport(remote);

  if (result.ok) {
    checkSpinner.stop("Readiness checks complete");
  } else {
    checkSpinner.stop("Readiness checks complete", 1);
  }

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printDoctorHuman(result);
  }

  if (result.ok === false) {
    process.exit(1);
  }
}

function parseJsonString(input: string, sourceLabel: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    throw new Error(`${sourceLabel} is not valid JSON`);
  }
}

async function resolveApplySource(args: string[]): Promise<ApplySource> {
  const fileFlag = parseFlag(args, "--file");
  const urlFlag = parseFlag(args, "--url");
  const manifestFlag = parseFlag(args, "--manifest");
  const proposalFlag = parseFlag(args, "--proposal");

  if (manifestFlag) {
    throw new Error("`--manifest` was removed. Use `--file <path>` instead.");
  }

  if (proposalFlag) {
    throw new Error("`--proposal` was removed from adapters apply. Use `pincer-admin proposals approve <id>`.");
  }

  const provided = [fileFlag, urlFlag].filter((value) => Boolean(value));
  if (provided.length !== 1) {
    throw new Error("Provide exactly one source: --file <path> or --url <url>");
  }

  let manifestRaw: unknown;
  let sourceLabel = "";

  if (fileFlag) {
    const filePath = path.resolve(process.cwd(), fileFlag);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Manifest file does not exist: ${filePath}`);
    }
    manifestRaw = parseJsonString(fs.readFileSync(filePath, "utf-8"), filePath);
    sourceLabel = filePath;
  } else {
    const response = await fetch(String(urlFlag));
    if (!response.ok) {
      throw new Error(`Failed to fetch manifest URL (${response.status}): ${String(urlFlag)}`);
    }

    manifestRaw = parseJsonString(await response.text(), String(urlFlag));
    sourceLabel = String(urlFlag);
  }

  const validation = validateAdapterManifest(manifestRaw);
  if (validation.ok === false) {
    throw new Error(`Invalid manifest:\n- ${validation.errors.join("\n- ")}`);
  }

  return {
    manifest: validation.manifest,
    sourceLabel,
    sourceKind: fileFlag ? "file" : "url",
  };
}

function printManifestSummary(input: {
  manifest: AdapterManifest;
  sourceLabel: string;
  sourceKind: "proposal" | "file" | "url";
  secretsToWrite: number;
}): void {
  const lines = [
    `Source: ${input.sourceLabel}`,
    `Adapter ID: ${input.manifest.id}`,
    `Revision: ${input.manifest.revision}`,
    `Actions (${Object.keys(input.manifest.actions).length}): ${Object.keys(input.manifest.actions).sort().join(", "
    )}`,
    `Required secrets: ${input.manifest.requiredSecrets.length > 0 ? input.manifest.requiredSecrets.join(", ") : "none"}`,
  ];

  if (input.sourceKind === "url") {
    lines.push("WARNING: Source is an external URL. Verify domain and manifest content before applying.");
  }

  lines.push(`Secret values provided this run: ${input.secretsToWrite}`);

  note(
    lines.join("\n"),
    "Apply Summary"
  );
}

async function promptSecretValues(manifest: AdapterManifest): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  if (manifest.requiredSecrets.length === 0) {
    return values;
  }

  note(
    "Provide secret values now. Leave blank to keep an existing secret value already configured on the Worker.",
    "Secret Setup"
  );

  for (const binding of manifest.requiredSecrets) {
    const value = unwrapPrompt(
      await password({
        message: `Secret for ${binding}`,
        mask: "*",
      })
    );

    if (!value || value.trim().length === 0) {
      continue;
    }

    values[binding] = value.trim();
  }

  return values;
}

async function writeSecretValues(remote: AdminRemoteInput, values: Record<string, string>): Promise<void> {
  for (const [binding, value] of Object.entries(values)) {
    await runStage(`Writing secret ${binding}`, `Secret ${binding} written`, async () => {
      await requestAdminJson(remote, "PUT", `/v1/admin/secrets/${encodeURIComponent(binding)}`, {
        value,
      });
    });
  }
}

async function fetchProposal(
  remote: AdminRemoteInput,
  proposalId: string
): Promise<{
  proposalId: string;
  adapterId: string;
  revision: number;
  submittedBy: string;
  submittedAt: string;
  manifest: AdapterManifest;
}> {
  const payload = (await runStage("Fetching proposal", "Proposal fetched", async () =>
    (await requestAdminJson(remote, "GET", `/v1/admin/adapters/proposals/${proposalId}`)) as {
      ok: boolean;
      proposal: {
        proposalId: string;
        adapterId: string;
        revision: number;
        submittedBy: string;
        submittedAt: string;
        manifest: AdapterManifest;
      };
    }
  )) as {
    ok: boolean;
    proposal: {
      proposalId: string;
      adapterId: string;
      revision: number;
      submittedBy: string;
      submittedAt: string;
      manifest: AdapterManifest;
    };
  };

  return payload.proposal;
}

async function runApplyFlow(input: {
  remote: AdminRemoteInput;
  manifest: AdapterManifest;
  sourceLabel: string;
  sourceKind: "proposal" | "file" | "url";
  applyPayload: Record<string, unknown>;
  force: boolean;
}): Promise<boolean> {
  let secretValues: Record<string, string> = {};
  if (input.manifest.requiredSecrets.length > 0) {
    secretValues = await promptSecretValues(input.manifest);
  }

  printManifestSummary({
    manifest: input.manifest,
    sourceLabel: input.sourceLabel,
    sourceKind: input.sourceKind,
    secretsToWrite: Object.keys(secretValues).length,
  });

  if (!input.force) {
    const confirmed = unwrapPrompt(
      await confirm({
        message: "Apply this adapter?",
        initialValue: false,
      })
    );

    if (!confirmed) {
      cancel("Apply cancelled.");
      return false;
    }
  }

  if (Object.keys(secretValues).length > 0) {
    await writeSecretValues(input.remote, secretValues);
  }

  const applyResponse = (await runStage("Applying adapter", "Adapter applied", async () =>
    (await requestAdminJson(input.remote, "POST", "/v1/admin/adapters/apply", input.applyPayload)) as {
      ok: boolean;
      result: {
        adapterId: string;
        revision: number;
        updateType: "new_install" | "in_place_update" | "re_enable";
      };
      manifest: {
        id: string;
        revision: number;
        actionNames: string[];
        requiredSecrets: string[];
      };
    }
  )) as {
    ok: boolean;
    result: {
      adapterId: string;
      revision: number;
      updateType: "new_install" | "in_place_update" | "re_enable";
    };
    manifest: {
      id: string;
      revision: number;
      actionNames: string[];
      requiredSecrets: string[];
    };
  };

  note(
    [
      `Adapter: ${applyResponse.result.adapterId}@${applyResponse.result.revision}`,
      `Update type: ${applyResponse.result.updateType}`,
      `Actions: ${applyResponse.manifest.actionNames.join(", ")}`,
    ].join("\n"),
    "Apply Result"
  );

  return true;
}

async function runProposalsList(args: string[]): Promise<void> {
  const asJson = args.includes("--json");

  intro(pc.bold(pc.cyan("Pincer proposals list")));
  const remote = await collectAdminRemoteInput();

  const payload = (await runStage("Fetching proposals", "Proposals fetched", async () =>
    (await requestAdminJson(remote, "GET", "/v1/admin/adapters/proposals")) as {
      ok: boolean;
      proposals: Array<{
        proposalId: string;
        adapterId: string;
        revision: number;
        submittedAt: string;
        submittedBy: string;
      }>;
    }
  )) as {
    ok: boolean;
    proposals: Array<{
      proposalId: string;
      adapterId: string;
      revision: number;
      submittedAt: string;
      submittedBy: string;
    }>;
  };

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    outro(pc.green("Done."));
    return;
  }

  if (payload.proposals.length === 0) {
    log.info("No pending proposals.");
    outro(pc.green("Done."));
    return;
  }

  printTable(
    ["PROPOSAL", "ADAPTER", "REVISION", "SUBMITTED_BY", "SUBMITTED_AT"],
    payload.proposals.map((proposal) => [
      proposal.proposalId,
      proposal.adapterId,
      String(proposal.revision),
      proposal.submittedBy,
      proposal.submittedAt,
    ])
  );

  outro(pc.green("Done."));
}

async function runProposalsInspect(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const proposalId = args.find((arg) => !arg.startsWith("--"));
  if (!proposalId) {
    throw new Error("Usage: pincer-admin proposals inspect <proposal-id> [--json]");
  }

  intro(pc.bold(pc.cyan("Pincer proposals inspect")));
  const remote = await collectAdminRemoteInput();

  const proposal = await fetchProposal(remote, proposalId);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          proposal,
        },
        null,
        2
      )
    );
    outro(pc.green("Done."));
    return;
  }

  note(
    [
      `Proposal: ${proposal.proposalId}`,
      `Adapter: ${proposal.adapterId}@${proposal.revision}`,
      `Submitted by: ${proposal.submittedBy}`,
      `Submitted at: ${proposal.submittedAt}`,
    ].join("\n"),
    "Proposal Details"
  );
  console.log(JSON.stringify(proposal.manifest, null, 2));
  outro(pc.green("Done."));
}

async function runProposalsApprove(args: string[]): Promise<void> {
  const force = args.includes("--force");
  const proposalId = args.find((arg) => !arg.startsWith("--"));
  if (!proposalId) {
    throw new Error("Usage: pincer-admin proposals approve <proposal-id> [--force]");
  }

  intro(pc.bold(pc.cyan("Pincer proposals approve")));
  const remote = await collectAdminRemoteInput();

  const proposal = await fetchProposal(remote, proposalId);
  const validation = validateAdapterManifest(proposal.manifest);
  if (validation.ok === false) {
    throw new Error(`Proposal manifest is invalid:\n- ${validation.errors.join("\n- ")}`);
  }

  const applied = await runApplyFlow({
    remote,
    manifest: validation.manifest,
    sourceLabel: `proposal ${proposalId}`,
    sourceKind: "proposal",
    applyPayload: { proposalId },
    force,
  });
  if (!applied) {
    return;
  }

  outro(pc.green("Done."));
}

async function runProposalsReject(args: string[]): Promise<void> {
  const proposalId = args.find((arg) => !arg.startsWith("--"));
  if (!proposalId) {
    throw new Error("Usage: pincer-admin proposals reject <proposal-id> [--reason \"...\"]");
  }
  const reason = parseFlag(args, "--reason") || undefined;

  intro(pc.bold(pc.cyan("Pincer proposals reject")));
  const remote = await collectAdminRemoteInput();

  const payload = (await runStage("Rejecting proposal", "Proposal rejected", async () =>
    (await requestAdminJson(
      remote,
      "POST",
      `/v1/admin/adapters/proposals/${proposalId}/reject`,
      reason ? { reason } : {}
    )) as {
      ok: boolean;
      result: {
        proposalId: string;
        status: "rejected";
        rejectedAt: string;
      };
    }
  )) as {
    ok: boolean;
    result: {
      proposalId: string;
      status: "rejected";
      rejectedAt: string;
    };
  };

  note(
    [
      `Proposal: ${payload.result.proposalId}`,
      `Status: ${payload.result.status}`,
      `Rejected at: ${payload.result.rejectedAt}`,
      reason ? `Reason: ${reason}` : "Reason: (none provided)",
    ].join("\n"),
    "Reject Result"
  );

  outro(pc.green("Done."));
}

async function runAdaptersList(args: string[]): Promise<void> {
  const asJson = args.includes("--json");

  intro(pc.bold(pc.cyan("Pincer adapters list")));
  const remote = await collectAdminRemoteInput();

  const payload = (await runStage("Fetching active adapters", "Active adapters fetched", async () =>
    (await requestAdminJson(remote, "GET", "/v1/admin/adapters")) as {
      ok: boolean;
      adapters: Array<{
        adapterId: string;
        revision: number;
        enabled: boolean;
        updatedAt: string;
        actionNames: string[];
        requiredSecrets: string[];
      }>;
    }
  )) as {
    ok: boolean;
    adapters: Array<{
      adapterId: string;
      revision: number;
      enabled: boolean;
      updatedAt: string;
      actionNames: string[];
      requiredSecrets: string[];
    }>;
  };

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    outro(pc.green("Done."));
    return;
  }

  if (payload.adapters.length === 0) {
    log.info("No adapters are active.");
    outro(pc.green("Done."));
    return;
  }

  printTable(
    ["STATUS", "ADAPTER", "REVISION", "ACTIONS", "UPDATED_AT"],
    payload.adapters.map((adapter) => [
      adapter.enabled ? "enabled" : "disabled",
      adapter.adapterId,
      String(adapter.revision),
      String(adapter.actionNames.length),
      adapter.updatedAt,
    ])
  );

  outro(pc.green("Done."));
}

async function runAdaptersApply(args: string[]): Promise<void> {
  const force = args.includes("--force");

  intro(pc.bold(pc.cyan("Pincer adapters apply")));
  const remote = await collectAdminRemoteInput();

  const source = await resolveApplySource(args);
  const applied = await runApplyFlow({
    remote,
    manifest: source.manifest,
    sourceLabel: source.sourceLabel,
    sourceKind: source.sourceKind,
    applyPayload: { manifest: source.manifest },
    force,
  });
  if (!applied) {
    return;
  }

  outro(pc.green("Done."));
}

async function runAuditList(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const limitRaw = parseFlag(args, "--limit");
  const since = parseFlag(args, "--since");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

  if (limitRaw && (!Number.isInteger(limit) || (limit as number) <= 0)) {
    throw new Error("`--limit` must be a positive integer.");
  }

  intro(pc.bold(pc.cyan("Pincer audit list")));
  const remote = await collectAdminRemoteInput();

  const query = new URLSearchParams();
  if (limit !== undefined) {
    query.set("limit", String(limit));
  }
  if (since) {
    query.set("since", since);
  }
  const pathName = `/v1/admin/audit${query.toString().length > 0 ? `?${query.toString()}` : ""}`;

  const payload = (await runStage("Fetching audit events", "Audit events fetched", async () =>
    (await requestAdminJson(remote, "GET", pathName)) as {
      ok: boolean;
      events: ProposalAuditEvent[];
    }
  )) as {
    ok: boolean;
    events: ProposalAuditEvent[];
  };

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    outro(pc.green("Done."));
    return;
  }

  if (payload.events.length === 0) {
    log.info("No audit events found.");
    outro(pc.green("Done."));
    return;
  }

  printTable(
    ["WHEN", "EVENT", "PROPOSAL", "ADAPTER", "ACTOR", "REASON"],
    payload.events.map((event) => [
      event.occurredAt,
      event.eventType,
      event.proposalId,
      `${event.adapterId}@${event.revision}`,
      event.actor,
      event.reason || "",
    ])
  );

  outro(pc.green("Done."));
}

async function runAdaptersValidate(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const filePathFlag = parseFlag(args, "--file");
  if (!filePathFlag) {
    throw new Error("Usage: pincer-admin adapters validate --file <path> [--json]");
  }

  const filePath = path.resolve(process.cwd(), filePathFlag);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Manifest file does not exist: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = parseJsonString(raw, filePath);
  const validation = validateAdapterManifest(parsed);

  if (validation.ok === false) {
    const result = {
      ok: false,
      file: filePath,
      errors: validation.errors,
    };
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      log.error(`Manifest validation failed for ${filePath}`);
      for (const error of validation.errors) {
        console.log(`- ${error}`);
      }
    }
    process.exit(1);
  }

  {
    const result = {
      ok: true,
      file: filePath,
      adapterId: validation.manifest.id,
      revision: validation.manifest.revision,
      actionCount: Object.keys(validation.manifest.actions).length,
    };

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      note(
        [
          `File: ${filePath}`,
          `Adapter: ${validation.manifest.id}@${validation.manifest.revision}`,
          `Actions: ${Object.keys(validation.manifest.actions).length}`,
          "Validation: OK",
        ].join("\n"),
        "Manifest Validation"
      );
    }
  }
}

async function runAdaptersDisable(args: string[]): Promise<void> {
  const adapterId = args.find((arg) => !arg.startsWith("--"));

  if (!adapterId) {
    throw new Error("Usage: pincer-admin adapters disable <adapter-id>");
  }

  intro(pc.bold(pc.cyan("Pincer adapters disable")));
  const remote = await collectAdminRemoteInput();

  await runStage("Disabling adapter", "Adapter disabled", async () => {
    await requestAdminJson(remote, "POST", `/v1/admin/adapters/${adapterId}/disable`, {});
  });

  outro(pc.green("Done."));
}

async function runAdaptersEnable(args: string[]): Promise<void> {
  const adapterId = args.find((arg) => !arg.startsWith("--"));

  if (!adapterId) {
    throw new Error("Usage: pincer-admin adapters enable <adapter-id>");
  }

  intro(pc.bold(pc.cyan("Pincer adapters enable")));
  const remote = await collectAdminRemoteInput();

  await runStage("Enabling adapter", "Adapter enabled", async () => {
    await requestAdminJson(remote, "POST", `/v1/admin/adapters/${adapterId}/enable`, {});
  });

  outro(pc.green("Done."));
}

async function runAdaptersSecretSet(args: string[]): Promise<void> {
  intro(pc.bold(pc.cyan("Pincer adapters secret set")));
  const remote = await collectAdminRemoteInput();

  const binding = args.find((arg) => !arg.startsWith("--"));
  if (!binding) {
    throw new Error("Usage: pincer-admin adapters secret set <binding>");
  }

  const value = unwrapPrompt(
    await password({
      message: `Secret value for ${binding}`,
      mask: "*",
      validate: (v) => assertNonEmpty(v, `Secret value for ${binding}`),
    })
  );

  await runStage(`Writing ${binding}`, `${binding} updated`, async () => {
    await requestAdminJson(remote, "PUT", `/v1/admin/secrets/${encodeURIComponent(binding)}`, {
      value,
    });
  });

  outro(pc.green("Done."));
}

async function runAdapters(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === "list") {
    await runAdaptersList(args.slice(1));
    return;
  }

  if (subcommand === "apply") {
    await runAdaptersApply(args.slice(1));
    return;
  }

  if (subcommand === "disable") {
    await runAdaptersDisable(args.slice(1));
    return;
  }

  if (subcommand === "enable") {
    await runAdaptersEnable(args.slice(1));
    return;
  }

  if (subcommand === "secret" && args[1] === "set") {
    await runAdaptersSecretSet(args.slice(2));
    return;
  }

  if (subcommand === "secret") {
    throw new Error("Usage: pincer-admin adapters secret set <binding>");
  }

  if (subcommand === "validate") {
    await runAdaptersValidate(args.slice(1));
    return;
  }

  throw new Error("Unknown adapters subcommand.");
}

async function runProposals(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === "list") {
    await runProposalsList(args.slice(1));
    return;
  }

  if (subcommand === "inspect") {
    await runProposalsInspect(args.slice(1));
    return;
  }

  if (subcommand === "approve") {
    await runProposalsApprove(args.slice(1));
    return;
  }

  if (subcommand === "reject") {
    await runProposalsReject(args.slice(1));
    return;
  }

  throw new Error("Unknown proposals subcommand.");
}

async function runAudit(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "list") {
    await runAuditList(args.slice(1));
    return;
  }

  throw new Error("Unknown audit subcommand.");
}

async function runCredentials(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "rotate") {
    await runCredentialsRotate();
    return;
  }

  throw new Error("Unknown credentials subcommand.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (args.includes("--with-access") || args.includes("--no-access")) {
    throw new Error("Cloudflare Access flags were removed in v1. Remove --with-access/--no-access.");
  }

  if (command === "--version" || command === "-v") {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    return;
  }

  if (!command || command === "help" || command === "--help") {
    usage();
    return;
  }

  if (command === "setup") {
    await runSetup(args.slice(1));
    return;
  }

  if (command === "pairing" && args[1] === "generate") {
    await runPairingGenerate();
    return;
  }

  if (command === "credentials") {
    await runCredentials(args.slice(1));
    return;
  }

  if (command === "doctor") {
    await runDoctor(args.slice(1));
    return;
  }

  if (command === "proposals") {
    await runProposals(args.slice(1));
    return;
  }

  if (command === "audit") {
    await runAudit(args.slice(1));
    return;
  }

  if (command === "adapters") {
    await runAdapters(args.slice(1));
    return;
  }

  throw new Error(`Unknown command '${args.join(" ")}'. Run 'pincer-admin --help'.`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  log.error(message);
  process.exit(1);
});
