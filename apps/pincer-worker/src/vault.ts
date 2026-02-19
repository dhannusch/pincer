import type { KvNamespaceBinding, WorkerEnv } from "./types.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const VAULT_SECRET_PREFIX = "vault:secret:";
const DEFAULT_LIST_PAGE_SIZE = 1000;

export const DEFAULT_RUNTIME_HMAC_BINDING = "PINCER_HMAC_SECRET_ACTIVE";
export const DEFAULT_RUNTIME_KEY_SECRET_BINDING = "PINCER_RUNTIME_KEY_SECRET_ACTIVE";

export type VaultSecretRecord = {
  keyId: string;
  nonce: string;
  ciphertext: string;
  updatedAt: string;
  updatedBy: string;
};

export type SecretMetadata = {
  binding: string;
  present: boolean;
  updatedAt?: string;
};

function ensureKv(env: WorkerEnv): KvNamespaceBinding {
  const kv = env.PINCER_CONFIG_KV;
  if (
    !kv ||
    typeof kv.get !== "function" ||
    typeof kv.put !== "function" ||
    typeof kv.delete !== "function" ||
    typeof kv.list !== "function"
  ) {
    throw new Error("PINCER_CONFIG_KV binding is missing");
  }

  return kv;
}

function validateBindingName(binding: string): string {
  const normalized = String(binding || "").trim();
  if (!/^[A-Za-z0-9_]{1,128}$/.test(normalized)) {
    throw new Error("invalid secret binding name");
  }
  return normalized;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array {
  if (typeof value !== "string" || value.length % 2 !== 0) {
    throw new Error("invalid hex value");
  }

  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const next = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isInteger(next)) {
      throw new Error("invalid hex value");
    }
    bytes[i] = next;
  }

  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function runtimeCrypto(): Crypto {
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    throw new Error("Web Crypto API unavailable");
  }
  return globalThis.crypto;
}

async function deriveVaultKey(env: WorkerEnv): Promise<CryptoKey> {
  const kek = String(env.PINCER_VAULT_KEK || "").trim();
  if (!kek) {
    throw new Error("PINCER_VAULT_KEK is missing");
  }

  const cryptoApi = runtimeCrypto();
  const digest = await cryptoApi.subtle.digest("SHA-256", textEncoder.encode(kek));
  return cryptoApi.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function secretKvKey(binding: string): string {
  return `${VAULT_SECRET_PREFIX}${validateBindingName(binding)}`;
}

function parseVaultRecord(raw: string | null): VaultSecretRecord | null {
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.keyId !== "string" ||
    typeof candidate.nonce !== "string" ||
    typeof candidate.ciphertext !== "string" ||
    typeof candidate.updatedAt !== "string" ||
    typeof candidate.updatedBy !== "string"
  ) {
    return null;
  }

  return {
    keyId: candidate.keyId,
    nonce: candidate.nonce,
    ciphertext: candidate.ciphertext,
    updatedAt: candidate.updatedAt,
    updatedBy: candidate.updatedBy,
  };
}

async function encryptValue(env: WorkerEnv, plaintext: string): Promise<{ nonce: string; ciphertext: string }> {
  const cryptoApi = runtimeCrypto();
  const nonce = cryptoApi.getRandomValues(new Uint8Array(12));
  const key = await deriveVaultKey(env);
  const ciphertext = await cryptoApi.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
    },
    key,
    textEncoder.encode(plaintext)
  );

  return {
    nonce: toHex(nonce),
    ciphertext: toHex(new Uint8Array(ciphertext)),
  };
}

async function decryptValue(env: WorkerEnv, record: VaultSecretRecord): Promise<string> {
  const key = await deriveVaultKey(env);
  const plaintext = await runtimeCrypto().subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(fromHex(record.nonce)),
    },
    key,
    toArrayBuffer(fromHex(record.ciphertext))
  );

  return textDecoder.decode(plaintext);
}

async function listVaultKeys(env: WorkerEnv): Promise<string[]> {
  const kv = ensureKv(env);
  const keys: string[] = [];

  let cursor: string | undefined;
  do {
    const page = await kv.list({
      prefix: VAULT_SECRET_PREFIX,
      limit: DEFAULT_LIST_PAGE_SIZE,
      cursor,
    });

    for (const key of page.keys) {
      keys.push(key.name);
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return keys;
}

export async function getVaultSecretRecord(
  env: WorkerEnv,
  binding: string
): Promise<VaultSecretRecord | null> {
  const kv = ensureKv(env);
  const raw = await kv.get(secretKvKey(binding));
  return parseVaultRecord(raw);
}

export async function getVaultSecretValue(env: WorkerEnv, binding: string): Promise<string> {
  const record = await getVaultSecretRecord(env, binding);
  if (!record) {
    return "";
  }

  try {
    return await decryptValue(env, record);
  } catch {
    return "";
  }
}

export async function putVaultSecret(
  env: WorkerEnv,
  input: { binding: string; value: string; updatedBy: string }
): Promise<VaultSecretRecord> {
  const binding = validateBindingName(input.binding);
  const plaintext = String(input.value || "");
  if (plaintext.length === 0) {
    throw new Error("secret value must be non-empty");
  }

  const kv = ensureKv(env);
  const encrypted = await encryptValue(env, plaintext);
  const record: VaultSecretRecord = {
    keyId: "v1",
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
    updatedAt: new Date().toISOString(),
    updatedBy: String(input.updatedBy || "admin").trim() || "admin",
  };

  await kv.put(secretKvKey(binding), JSON.stringify(record));
  return record;
}

export async function deleteVaultSecret(env: WorkerEnv, binding: string): Promise<void> {
  const kv = ensureKv(env);
  await kv.delete(secretKvKey(binding));
}

export async function resolveSecretValue(env: WorkerEnv, binding: string): Promise<string> {
  const normalized = validateBindingName(binding);
  const vaultValue = await getVaultSecretValue(env, normalized);
  if (vaultValue.length > 0) {
    return vaultValue;
  }

  const envValue = env[normalized];
  return typeof envValue === "string" ? envValue : "";
}

export async function listSecretMetadata(
  env: WorkerEnv,
  hints: string[]
): Promise<SecretMetadata[]> {
  const known = new Set<string>();
  for (const hint of hints) {
    try {
      known.add(validateBindingName(hint));
    } catch {
      // Ignore invalid hint values from user-controlled inputs.
    }
  }

  for (const key of await listVaultKeys(env)) {
    if (!key.startsWith(VAULT_SECRET_PREFIX)) {
      continue;
    }
    known.add(key.slice(VAULT_SECRET_PREFIX.length));
  }

  const rows: SecretMetadata[] = [];
  for (const binding of [...known].sort((a, b) => a.localeCompare(b))) {
    const record = await getVaultSecretRecord(env, binding);
    if (record) {
      rows.push({
        binding,
        present: true,
        updatedAt: record.updatedAt,
      });
      continue;
    }

    const fallback = env[binding];
    rows.push({
      binding,
      present: typeof fallback === "string" && fallback.length > 0,
      updatedAt: undefined,
    });
  }

  return rows;
}

export function createPairingCode(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = runtimeCrypto().getRandomValues(new Uint8Array(8));
  const chars: string[] = [];

  for (const byte of bytes) {
    chars.push(alphabet[byte % alphabet.length]);
  }

  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}
