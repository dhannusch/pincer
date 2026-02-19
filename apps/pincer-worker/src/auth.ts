import { constantTimeEqual, sha256Hex, verifySignedRequest } from "@pincerclaw/shared-types";

import { getRuntimeRecord } from "./config.js";
import { getHeader } from "./http.js";
import type { RuntimeAuthResult, WorkerEnv } from "./types.js";
import { resolveSecretValue } from "./vault.js";

type ParsedBearer = {
  keyId: string;
  keySecret: string;
};

function parseBearer(authorizationHeader: string): ParsedBearer | null {
  if (!authorizationHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authorizationHeader.slice("Bearer ".length).trim();
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [keyId, keySecret] = parts;
  if (!keyId || !keySecret) {
    return null;
  }

  return {
    keyId,
    keySecret,
  };
}

export async function authenticateRuntimeRequest(
  request: Request,
  env: WorkerEnv,
  rawBody: string,
  path: string
): Promise<RuntimeAuthResult> {
  const bearer = parseBearer(getHeader(request, "authorization"));
  if (!bearer) {
    return { ok: false, reason: "invalid_runtime_key_format", status: 401 };
  }

  let runtime;
  try {
    runtime = await getRuntimeRecord(env);
  } catch {
    return { ok: false, reason: "missing_runtime_config", status: 500 };
  }

  if (bearer.keyId !== runtime.id) {
    return { ok: false, reason: "unknown_runtime_key", status: 401 };
  }

  const providedHash = await sha256Hex(bearer.keySecret);
  if (!constantTimeEqual(providedHash, runtime.keyHash)) {
    return { ok: false, reason: "invalid_runtime_key", status: 401 };
  }

  const hmacSecret = await resolveSecretValue(env, runtime.hmacSecretBinding);
  if (!hmacSecret) {
    return { ok: false, reason: "missing_hmac_secret", status: 500 };
  }

  const signatureCheck = await verifySignedRequest({
    method: request.method,
    path,
    timestamp: getHeader(request, "x-pincer-timestamp"),
    body: rawBody,
    bodySha256: getHeader(request, "x-pincer-body-sha256"),
    signature: getHeader(request, "x-pincer-signature"),
    secret: hmacSecret,
    skewSeconds: runtime.skewSeconds || 60,
  });

  if (signatureCheck.ok === false) {
    return { ok: false, reason: signatureCheck.reason, status: 401 };
  }

  return {
    ok: true,
    keyId: runtime.id,
  };
}
