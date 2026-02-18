export type RuntimeKvRecord = {
  id: string;
  keyHash: string;
  hmacSecretBinding: string;
  skewSeconds: number;
  updatedAt: string;
};

export function buildRuntimeKvRecord(input: {
  keyId: string;
  keyHash: string;
  hmacSecretBinding: string;
  skewSeconds?: number;
  nowIso?: string;
}): RuntimeKvRecord {
  return {
    id: input.keyId,
    keyHash: input.keyHash,
    hmacSecretBinding: input.hmacSecretBinding,
    skewSeconds: input.skewSeconds ?? 60,
    updatedAt: input.nowIso ?? new Date().toISOString(),
  };
}

export const PAIRING_TTL_SECONDS = 15 * 60;

const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PAIRING_CODE_LENGTH = 8;

export function generatePairingCode(randomBytes: Uint8Array): string {
  const chars: string[] = [];
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    chars.push(PAIRING_ALPHABET[randomBytes[i] % PAIRING_ALPHABET.length]);
  }
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

export function buildPairingKvEntry(input: {
  code: string;
  workerUrl: string;
  runtimeKey: string;
  hmacSecret: string;
}): { key: string; value: string; ttl: number } {
  const normalizedCode = input.code.trim().toUpperCase();
  return {
    key: `pairing:${normalizedCode}`,
    value: JSON.stringify({
      workerUrl: input.workerUrl,
      runtimeKey: input.runtimeKey,
      hmacSecret: input.hmacSecret,
    }),
    ttl: PAIRING_TTL_SECONDS,
  };
}
