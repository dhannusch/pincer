import { jsonResponse, parseJson } from "./http.js";
import type { WorkerEnv } from "./types.js";

type ConnectRequestBody = {
  code: string;
};

type PairingRecord = {
  workerUrl: string;
  runtimeKey: string;
  hmacSecret: string;
};

const PAIRING_KEY_PREFIX = "pairing:";

export function pairingKvKey(code: string): string {
  return `${PAIRING_KEY_PREFIX}${code.trim().toUpperCase()}`;
}

export async function handleConnect(request: Request, env: WorkerEnv): Promise<Response> {
  const kv = env.PINCER_CONFIG_KV;
  if (!kv) {
    return jsonResponse(500, { error: "missing_kv_binding" });
  }

  const bodyText = await request.text();
  const body = parseJson<ConnectRequestBody | null>(bodyText, null);
  const normalizedCode = body && typeof body.code === "string" ? body.code.trim() : "";
  if (normalizedCode.length === 0) {
    return jsonResponse(400, { error: "missing_code" });
  }

  const key = pairingKvKey(normalizedCode);
  const stored = await kv.get(key);
  if (!stored) {
    return jsonResponse(404, { error: "invalid_or_expired_code" });
  }

  const record = parseJson<PairingRecord | null>(stored, null);
  if (!record) {
    await kv.delete(key);
    return jsonResponse(500, { error: "corrupt_pairing_record" });
  }

  await kv.delete(key);

  return jsonResponse(200, {
    ok: true,
    workerUrl: record.workerUrl,
    runtimeKey: record.runtimeKey,
    hmacSecret: record.hmacSecret,
  });
}
