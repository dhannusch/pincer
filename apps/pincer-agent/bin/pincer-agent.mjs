#!/usr/bin/env node
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntrypoint = path.resolve(here, "../src/cli.ts");

function resolveTsxModule() {
  return require.resolve("tsx", { paths: [here] });
}

function supportsImportFlag() {
  const [major, minor] = process.versions.node.split(".").map((part) => Number(part));
  if (major > 20) {
    return true;
  }
  if (major === 20 && minor >= 6) {
    return true;
  }
  if (major === 18 && minor >= 19) {
    return true;
  }
  return major === 19;
}

try {
  const tsxModule = resolveTsxModule();
  const tsxImport = pathToFileURL(tsxModule).href;
  const loaderArgs = supportsImportFlag() ? ["--import", tsxImport] : ["--loader", tsxModule];
  const result = spawnSync(
    process.execPath,
    [...loaderArgs, cliEntrypoint, ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to launch pincer-agent: ${message}`);
  console.error("Run `npm install` in the repository root, then relink via `./scripts/install-cli.sh`.");
  process.exit(1);
}
