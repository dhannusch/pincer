import type { AdapterRuntimeState } from "./adapters/types.js";

export type RuntimeKeyRecord = {
  id: string;
  keyHash: string;
  hmacSecretBinding: string;
  keySecretBinding: string;
  skewSeconds?: number;
  updatedAt?: string;
};

export type MetricsBinding = {
  writeDataPoint: (point: { blobs: string[]; doubles: number[] }) => void;
};

export type KvNamespaceBinding = {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>;
  delete: (key: string) => Promise<void>;
  list: (options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }) => Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
};

export type WorkerEnv = {
  PINCER_CONFIG_KV?: KvNamespaceBinding;
  PINCER_SKEW_SECONDS?: string;
  PINCER_BOOTSTRAP_TOKEN?: string;
  PINCER_VAULT_KEK?: string;
  PINCER_METRICS?: MetricsBinding;
  [key: string]: unknown;
};

export type RuntimeConfigSnapshot = {
  version: string;
  runtime: RuntimeKeyRecord;
  adapters: Record<string, AdapterRuntimeState>;
};

export type RuntimeAuthFailure = {
  ok: false;
  reason: string;
  status: number;
};

export type RuntimeAuthSuccess = {
  ok: true;
  keyId: string;
};

export type RuntimeAuthResult = RuntimeAuthFailure | RuntimeAuthSuccess;

export type ProxyMetric = {
  adapter: string;
  action: string;
  outcome: "allowed" | "denied" | "error";
  statusClass: string;
  denyReason: string;
  latencyMs: number;
};
