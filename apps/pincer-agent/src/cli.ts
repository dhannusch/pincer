import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { intro, log, outro, spinner } from "@clack/prompts";
import pc from "picocolors";

import {
  asVersionedSignature,
  hmacSha256Hex,
  sha256Hex,
  validateAdapterManifest,
  type AdapterManifest,
} from "@pincer/shared-types";
import { loadCredentials, writeCredentials, getCredentialsPath } from "./credentials.js";
import { parseInputJson } from "./input.js";
import { installSkill } from "./skill.js";

type SignedRequestInput = {
  method: "GET" | "POST";
  pathName: string;
  body?: string;
};

function printUsage() {
  console.log(`pincer-agent commands:
  pincer-agent connect <worker-host> --code <CODE>
  pincer-agent call <adapter> <action> [--input '<json>' | --input-file <path>]
  pincer-agent adapters list [--json]
  pincer-agent adapters validate --file <path> [--json]
  pincer-agent adapters propose (--manifest '<json>' | --file <path>)
`);
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

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseManifestSource(args: string[]): AdapterManifest {
  const manifestRaw = parseFlag(args, "--manifest");
  const filePathRaw = parseFlag(args, "--file");
  const sourceCount = [manifestRaw, filePathRaw].filter((value) => Boolean(value)).length;

  if (sourceCount !== 1) {
    throw new Error("Provide exactly one source: --manifest '<json>' or --file <path>");
  }

  let parsed: unknown;
  if (manifestRaw) {
    parsed = tryParseJson(manifestRaw);
    if (!parsed) {
      throw new Error("--manifest must be valid JSON");
    }
  } else {
    const absolutePath = path.resolve(process.cwd(), String(filePathRaw));
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Manifest file not found: ${absolutePath}`);
    }

    const raw = fs.readFileSync(absolutePath, "utf-8");
    parsed = tryParseJson(raw);
    if (!parsed) {
      throw new Error(`Manifest file must contain valid JSON: ${absolutePath}`);
    }
  }

  const validation = validateAdapterManifest(parsed);
  if (validation.ok === false) {
    throw new Error(`Invalid manifest:\n- ${validation.errors.join("\n- ")}`);
  }

  return validation.manifest;
}

async function signedRequest({ method, pathName, body }: SignedRequestInput): Promise<unknown> {
  const creds = loadCredentials();
  const workerUrl = creds.workerUrl.replace(/\/$/, "");

  const rawBody = body ?? "";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHash = await sha256Hex(rawBody);
  const canonical = [method.toUpperCase(), pathName, timestamp, bodyHash].join("\n");
  const signature = await hmacSha256Hex(creds.hmacSecret, canonical);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${creds.runtimeKey}`,
    "x-pincer-timestamp": timestamp,
    "x-pincer-body-sha256": bodyHash,
    "x-pincer-signature": asVersionedSignature(signature),
  };

  const response = await fetch(`${workerUrl}${pathName}`, {
    method,
    headers,
    body: method === "POST" ? rawBody : undefined,
  });

  const text = await response.text();
  const parsed = tryParseJson(text);
  if (!response.ok) {
    const details = parsed || text;
    throw new Error(`Request failed (${response.status}): ${JSON.stringify(details)}`);
  }

  return parsed ?? { raw: text };
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, col) =>
    Math.max(header.length, ...rows.map((row) => (row[col] || "").length))
  );

  const format = (row: string[]): string =>
    row.map((value, col) => (value || "").padEnd(widths[col])).join("  ");

  console.log(format(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    console.log(format(row));
  }
}

async function runConnect(args: string[]): Promise<void> {
  if (args.length < 1) {
    throw new Error("Usage: pincer-agent connect <worker-host> --code <CODE>");
  }

  const workerHost = args[0];
  const code = parseFlag(args, "--code");
  if (!code) {
    throw new Error("Missing --code flag. Usage: pincer-agent connect <worker-host> --code <CODE>");
  }

  const workerUrl = workerHost.startsWith("http") ? workerHost : `https://${workerHost}`;

  intro(pc.bold(pc.cyan("Pincer agent connect")));
  const s = spinner();

  s.start("Requesting credentials");
  const response = await fetch(`${workerUrl}/v1/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });

  if (!response.ok) {
    const text = await response.text();
    const parsed = tryParseJson(text);
    const detail = parsed && typeof parsed === "object" && "error" in parsed
      ? (parsed as { error: string }).error
      : text;

    const hint =
      detail === "invalid_or_expired_code"
        ? "\nUse the exact connect command printed by `pincer-admin setup` on your OpenClaw host machine. Pairing codes are one-time and tied to the latest setup run."
        : "";

    s.stop("Failed to receive credentials", 1);
    throw new Error(`Connect failed (${response.status}): ${detail}${hint}`);
  }

  const payload = (await response.json()) as {
    ok: boolean;
    workerUrl: string;
    runtimeKey: string;
    hmacSecret: string;
  };
  s.stop("Credentials received");

  s.start("Saving credentials");
  writeCredentials({
    workerUrl: payload.workerUrl,
    runtimeKey: payload.runtimeKey,
    hmacSecret: payload.hmacSecret,
  });
  s.stop(`Saved to ${getCredentialsPath()}`);

  s.start("Verifying connection");
  const healthResponse = await fetch(`${payload.workerUrl}/v1/health`);
  if (!healthResponse.ok) {
    s.stop("Health check failed", 1);
    throw new Error(`Worker health check returned ${healthResponse.status}`);
  }
  s.stop("Connection verified");

  s.start("Installing OpenClaw skill");
  const skillPath = installSkill(payload.workerUrl);
  s.stop(`OpenClaw skill installed at ${skillPath}`);

  log.success("Connected!");
  outro(pc.green("Run: pincer-agent adapters propose --file ./manifest.json"));
}

async function runCall(args: string[]): Promise<void> {
  if (args.length < 2) {
    throw new Error(
      "Usage: pincer-agent call <adapter> <action> [--input '<json>' | --input-file <path>]"
    );
  }

  const adapter = args[0];
  const action = args[1];
  const inputRaw = parseFlag(args, "--input");
  const inputFile = parseFlag(args, "--input-file");

  if (inputRaw && inputFile) {
    throw new Error("Use only one input source: --input or --input-file");
  }

  let resolvedInputRaw = "{}";
  if (inputFile) {
    const absolutePath = path.resolve(process.cwd(), inputFile);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Input file not found: ${absolutePath}`);
    }
    resolvedInputRaw = fs.readFileSync(absolutePath, "utf-8");
  } else if (inputRaw) {
    resolvedInputRaw = inputRaw;
  }

  const input = parseInputJson(resolvedInputRaw);

  intro(pc.bold(pc.cyan("Pincer agent call")));
  const s = spinner();
  s.start(`Calling ${adapter}.${action}`);

  try {
    const pathName = `/v1/adapter/${adapter}/${action}`;
    const response = await signedRequest({
      method: "POST",
      pathName,
      body: JSON.stringify({ input }),
    });

    s.stop(`Call completed for ${adapter}.${action}`);
    console.log(JSON.stringify(response, null, 2));
    outro(pc.green("Done."));
  } catch (error) {
    s.stop(`Call failed for ${adapter}.${action}`, 1);
    throw error;
  }
}

async function runAdaptersPropose(args: string[]): Promise<void> {
  const manifest = parseManifestSource(args);

  intro(pc.bold(pc.cyan("Pincer agent propose adapter")));
  const s = spinner();
  s.start(`Submitting proposal ${manifest.id}@${manifest.revision}`);

  try {
    const response = await signedRequest({
      method: "POST",
      pathName: "/v1/adapters/proposals",
      body: JSON.stringify({ manifest }),
    });

    s.stop(`Proposal submitted for ${manifest.id}@${manifest.revision}`);
    console.log(JSON.stringify(response, null, 2));
    outro(pc.green("Done."));
  } catch (error) {
    s.stop(`Proposal failed for ${manifest.id}@${manifest.revision}`, 1);
    throw error;
  }
}

async function runAdaptersList(args: string[]): Promise<void> {
  const asJson = args.includes("--json");

  intro(pc.bold(pc.cyan("Pincer agent adapters list")));
  const s = spinner();
  s.start("Fetching enabled adapters");

  try {
    const payload = (await signedRequest({
      method: "GET",
      pathName: "/v1/adapters",
    })) as {
      ok: boolean;
      adapters: Array<{
        adapterId: string;
        revision: number;
        actionNames: string[];
      }>;
    };
    s.stop("Enabled adapters fetched");

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
      outro(pc.green("Done."));
      return;
    }

    if (payload.adapters.length === 0) {
      log.info("No adapters are enabled.");
      outro(pc.green("Done."));
      return;
    }

    printTable(
      ["ADAPTER", "REVISION", "ACTIONS"],
      payload.adapters.map((adapter) => [
        adapter.adapterId,
        String(adapter.revision),
        adapter.actionNames.join(", "),
      ])
    );

    outro(pc.green("Done."));
  } catch (error) {
    s.stop("Failed to fetch enabled adapters", 1);
    throw error;
  }
}

async function runAdaptersValidate(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const filePathRaw = parseFlag(args, "--file");
  if (!filePathRaw) {
    throw new Error("Usage: pincer-agent adapters validate --file <path> [--json]");
  }

  const absolutePath = path.resolve(process.cwd(), filePathRaw);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Manifest file not found: ${absolutePath}`);
  }

  const raw = fs.readFileSync(absolutePath, "utf-8");
  const parsed = tryParseJson(raw);
  if (!parsed) {
    throw new Error(`Manifest file must contain valid JSON: ${absolutePath}`);
  }

  const validation = validateAdapterManifest(parsed);
  if (validation.ok === false) {
    const payload = {
      ok: false,
      file: absolutePath,
      errors: validation.errors,
    };
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      log.error(`Manifest validation failed for ${absolutePath}`);
      for (const error of validation.errors) {
        console.log(`- ${error}`);
      }
    }
    process.exit(1);
  }

  {
    const payload = {
      ok: true,
      file: absolutePath,
      adapterId: validation.manifest.id,
      revision: validation.manifest.revision,
      actionCount: Object.keys(validation.manifest.actions).length,
    };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      log.success(
        `Manifest valid: ${validation.manifest.id}@${validation.manifest.revision} (${Object.keys(validation.manifest.actions).length} actions)`
      );
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "help") {
    printUsage();
    return;
  }

  if (command === "connect") {
    await runConnect(args.slice(1));
    return;
  }

  if (command === "call") {
    await runCall(args.slice(1));
    return;
  }

  if (command === "adapters") {
    if (args[1] === "propose") {
      await runAdaptersPropose(args.slice(2));
      return;
    }
    if (args[1] === "list") {
      await runAdaptersList(args.slice(2));
      return;
    }
    if (args[1] === "validate") {
      await runAdaptersValidate(args.slice(2));
      return;
    }
  }

  throw new Error(`Unknown command: ${args.join(" ")}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  log.error(message);
  process.exit(1);
});
