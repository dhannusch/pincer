import { listActiveAdapterStates, listActiveAdapters } from "./adapters/index.js";
import { parseJson } from "./http.js";
import type { RuntimeKeyRecord, RuntimeConfigSnapshot, WorkerEnv } from "./types.js";

const CONFIG_CACHE_TTL_MS = 10_000;

// TODO: Keep this cache shape aligned with adapters/index.ts or extract a shared helper.
const configCache: {
  loadedAtMs: number;
  snapshot: RuntimeConfigSnapshot | null;
  kvRef: unknown;
} = {
  loadedAtMs: 0,
  snapshot: null,
  kvRef: null,
};

function parseRuntimeRecord(raw: string | null): RuntimeKeyRecord {
  if (!raw) {
    throw new Error("missing KV key runtime:active");
  }

  const parsed = parseJson<unknown>(raw, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("KV runtime:active must be a JSON object");
  }

  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    throw new Error("KV runtime:active.id must be a non-empty string");
  }

  if (typeof candidate.keyHash !== "string" || candidate.keyHash.length === 0) {
    throw new Error("KV runtime:active.keyHash must be a non-empty string");
  }

  if (
    typeof candidate.hmacSecretBinding !== "string" ||
    candidate.hmacSecretBinding.length === 0
  ) {
    throw new Error("KV runtime:active.hmacSecretBinding must be a non-empty string");
  }

  const skewSeconds =
    typeof candidate.skewSeconds === "number" && Number.isFinite(candidate.skewSeconds)
      ? Math.floor(candidate.skewSeconds)
      : 60;

  return {
    id: candidate.id,
    keyHash: candidate.keyHash,
    hmacSecretBinding: candidate.hmacSecretBinding,
    skewSeconds,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : undefined,
  };
}

function resolveSkewSeconds(env: WorkerEnv, runtime: RuntimeKeyRecord): number {
  const envValue = Number.parseInt(String(env.PINCER_SKEW_SECONDS || ""), 10);
  if (Number.isFinite(envValue) && envValue > 0) {
    return envValue;
  }

  if (typeof runtime.skewSeconds === "number" && runtime.skewSeconds > 0) {
    return runtime.skewSeconds;
  }

  return 60;
}

export async function getConfigSnapshot(
  env: WorkerEnv,
  forceReload = false
): Promise<RuntimeConfigSnapshot> {
  const kv = env.PINCER_CONFIG_KV;
  if (!kv || typeof kv.get !== "function") {
    throw new Error("PINCER_CONFIG_KV binding is missing");
  }

  const nowMs = Date.now();
  if (
    !forceReload &&
    configCache.snapshot &&
    configCache.kvRef === kv &&
    nowMs - configCache.loadedAtMs < CONFIG_CACHE_TTL_MS
  ) {
    return configCache.snapshot;
  }

  const [versionRaw, runtimeRaw, adapters] = await Promise.all([
    kv.get("meta:version"),
    kv.get("runtime:active"),
    listActiveAdapterStates(env, forceReload),
  ]);

  const runtime = parseRuntimeRecord(runtimeRaw);
  runtime.skewSeconds = resolveSkewSeconds(env, runtime);

  const version = versionRaw && versionRaw.trim().length > 0 ? versionRaw.trim() : "1";

  const snapshot: RuntimeConfigSnapshot = {
    version,
    runtime,
    adapters,
  };

  configCache.snapshot = snapshot;
  configCache.loadedAtMs = nowMs;
  configCache.kvRef = kv;

  return snapshot;
}

export async function getRuntimeRecord(env: WorkerEnv): Promise<RuntimeKeyRecord> {
  const snapshot = await getConfigSnapshot(env, false);
  return snapshot.runtime;
}

export function readSecretBinding(env: WorkerEnv, bindingName: string): string {
  if (!bindingName || typeof bindingName !== "string") {
    return "";
  }

  const value = env[bindingName];
  return typeof value === "string" ? value : "";
}

export async function getDoctorChecks(
  env: WorkerEnv
): Promise<Array<{ name: string; ok: boolean; details: string }>> {
  const checks: Array<{ name: string; ok: boolean; details: string }> = [];

  try {
    const snapshot = await getConfigSnapshot(env, true);

    checks.push({ name: "kv_version", ok: true, details: snapshot.version });
    checks.push({ name: "runtime_active", ok: true, details: snapshot.runtime.id });

    for (const [adapterId, state] of Object.entries(snapshot.adapters).sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      checks.push({
        name: `adapter_${adapterId}`,
        ok: true,
        details: `${state.enabled ? "enabled" : "disabled"} (revision ${state.revision})`,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ name: "kv_config", ok: false, details: message });
    return checks;
  }

  checks.push({
    name: "admin_passphrase",
    ok: typeof env.PINCER_ADMIN_PASSPHRASE === "string" && env.PINCER_ADMIN_PASSPHRASE.length > 0,
    details: "PINCER_ADMIN_PASSPHRASE",
  });

  const runtime = await getRuntimeRecord(env);
  checks.push({
    name: "runtime_hmac_secret_binding",
    ok: readSecretBinding(env, runtime.hmacSecretBinding).length > 0,
    details: runtime.hmacSecretBinding,
  });

  const activeAdapters = await listActiveAdapters(env);
  for (const adapter of activeAdapters.filter((item) => item.enabled)) {
    const missing = adapter.requiredSecrets.filter(
      (bindingName) => readSecretBinding(env, bindingName).length === 0
    );

    checks.push({
      name: `adapter_${adapter.adapterId}_secrets`,
      ok: missing.length === 0,
      details: missing.length === 0 ? "present" : `missing: ${missing.join(", ")}`,
    });
  }

  return checks;
}
