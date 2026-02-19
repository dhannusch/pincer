export type RuntimeKvRecord = {
  id: string;
  keyHash: string;
  hmacSecretBinding: string;
  keySecretBinding: string;
  skewSeconds: number;
  updatedAt: string;
};

export function buildRuntimeKvRecord(input: {
  keyId: string;
  keyHash: string;
  hmacSecretBinding: string;
  keySecretBinding: string;
  skewSeconds?: number;
  nowIso?: string;
}): RuntimeKvRecord {
  return {
    id: input.keyId,
    keyHash: input.keyHash,
    hmacSecretBinding: input.hmacSecretBinding,
    keySecretBinding: input.keySecretBinding,
    skewSeconds: input.skewSeconds ?? 60,
    updatedAt: input.nowIso ?? new Date().toISOString(),
  };
}
