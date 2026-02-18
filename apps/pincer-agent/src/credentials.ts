import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";

export type PincerCredentials = {
  workerUrl: string;
  runtimeKey: string;
  hmacSecret: string;
};

function credentialsDir(): string {
  return path.join(os.homedir(), ".pincer");
}

function credentialsFilePath(): string {
  return path.join(credentialsDir(), "credentials.json");
}

export function loadCredentials(): PincerCredentials {
  const envUrl = process.env.PINCER_WORKER_URL;
  const envKey = process.env.PINCER_RUNTIME_KEY;
  const envHmac = process.env.PINCER_HMAC_SECRET;

  if (envUrl && envKey && envHmac) {
    return {
      workerUrl: envUrl,
      runtimeKey: envKey,
      hmacSecret: envHmac,
    };
  }

  const filePath = credentialsFilePath();
  if (!fs.existsSync(filePath)) {
    throw new Error(
      "No credentials found. Run `pincer-agent connect <worker-host> --code <CODE>` or set PINCER_WORKER_URL, PINCER_RUNTIME_KEY, and PINCER_HMAC_SECRET env vars."
    );
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as PincerCredentials;

  if (!parsed.workerUrl || !parsed.runtimeKey || !parsed.hmacSecret) {
    throw new Error(`Invalid credentials file at ${filePath}`);
  }

  return parsed;
}

export function writeCredentials(creds: PincerCredentials): void {
  const dir = credentialsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "credentials.json"),
    JSON.stringify(creds, null, 2) + "\n",
    { mode: 0o600 }
  );
}

export function getCredentialsPath(): string {
  return credentialsFilePath();
}
