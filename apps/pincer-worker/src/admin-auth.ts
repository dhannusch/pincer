import { constantTimeEqual } from "@pincerclaw/shared-types";

import { createCookie, getCookie, getHeader } from "./http.js";
import type { KvNamespaceBinding, WorkerEnv } from "./types.js";

const textEncoder = new TextEncoder();

const ADMIN_USER_KEY = "admin:user:primary";
const ADMIN_SESSION_PREFIX = "admin:session:";
const ADMIN_LOGIN_PREFIX = "admin:login:";

const PASSWORD_ITERATIONS = 120_000;

const SESSION_COOKIE = "pincer_admin_session";
const SESSION_ABSOLUTE_TTL_SECONDS = 8 * 60 * 60;
const SESSION_IDLE_TTL_SECONDS = 30 * 60;
const SESSION_ROTATE_INTERVAL_MS = 15 * 60 * 1000;

const LOGIN_LOCK_THRESHOLD = 5;
const LOGIN_LOCK_MAX_SECONDS = 15 * 60;

type AdminUserRecord = {
  username: string;
  passwordSaltHex: string;
  passwordHashHex: string;
  iterations: number;
  createdAt: string;
  updatedAt: string;
};

export type AdminSessionRecord = {
  sessionId: string;
  username: string;
  csrfToken: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  rotatedAt: string;
  expiresAt: string;
  idleExpiresAt: string;
};

type LoginState = {
  failedCount: number;
  lockUntilMs: number;
  updatedAt: string;
};

export type SessionValidationResult =
  | {
      ok: true;
      session: AdminSessionRecord;
      setCookie?: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
      setCookie?: string;
      retryAfterSeconds?: number;
    };

function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function ensureKv(env: WorkerEnv): KvNamespaceBinding {
  const kv = env.PINCER_CONFIG_KV;
  if (
    !kv ||
    typeof kv.get !== "function" ||
    typeof kv.put !== "function" ||
    typeof kv.delete !== "function"
  ) {
    throw new Error("PINCER_CONFIG_KV binding is missing");
  }
  return kv;
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

function randomHex(byteLength: number): string {
  if (!globalThis.crypto) {
    throw new Error("Web Crypto API unavailable");
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(byteLength));
  return toHex(bytes);
}

function isValidUsername(value: string): boolean {
  return /^[A-Za-z0-9._-]{3,64}$/.test(value);
}

function sessionKvKey(sessionId: string): string {
  return `${ADMIN_SESSION_PREFIX}${sessionId}`;
}

function loginKvKey(username: string, clientId: string): string {
  return `${ADMIN_LOGIN_PREFIX}${username}:${clientId}`;
}

function normalizeUsername(value: string): string {
  return String(value || "").trim().toLowerCase();
}

function parseUser(raw: string | null): AdminUserRecord | null {
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
    typeof candidate.username !== "string" ||
    typeof candidate.passwordSaltHex !== "string" ||
    typeof candidate.passwordHashHex !== "string" ||
    typeof candidate.iterations !== "number" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    username: candidate.username,
    passwordSaltHex: candidate.passwordSaltHex,
    passwordHashHex: candidate.passwordHashHex,
    iterations: candidate.iterations,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

function parseSession(raw: string | null): AdminSessionRecord | null {
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
    typeof candidate.sessionId !== "string" ||
    typeof candidate.username !== "string" ||
    typeof candidate.csrfToken !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.updatedAt !== "string" ||
    typeof candidate.lastSeenAt !== "string" ||
    typeof candidate.rotatedAt !== "string" ||
    typeof candidate.expiresAt !== "string" ||
    typeof candidate.idleExpiresAt !== "string"
  ) {
    return null;
  }

  return {
    sessionId: candidate.sessionId,
    username: candidate.username,
    csrfToken: candidate.csrfToken,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    lastSeenAt: candidate.lastSeenAt,
    rotatedAt: candidate.rotatedAt,
    expiresAt: candidate.expiresAt,
    idleExpiresAt: candidate.idleExpiresAt,
  };
}

function parseLoginState(raw: string | null): LoginState {
  if (!raw) {
    return {
      failedCount: 0,
      lockUntilMs: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      failedCount: 0,
      lockUntilMs: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      failedCount: 0,
      lockUntilMs: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }

  const candidate = parsed as Record<string, unknown>;
  return {
    failedCount:
      typeof candidate.failedCount === "number" && Number.isFinite(candidate.failedCount)
        ? Math.max(0, Math.floor(candidate.failedCount))
        : 0,
    lockUntilMs:
      typeof candidate.lockUntilMs === "number" && Number.isFinite(candidate.lockUntilMs)
        ? Math.max(0, Math.floor(candidate.lockUntilMs))
        : 0,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
  };
}

async function hashPassword(input: {
  password: string;
  saltHex: string;
  iterations: number;
}): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto API unavailable");
  }

  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    textEncoder.encode(input.password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(fromHex(input.saltHex)),
      iterations: input.iterations,
      hash: "SHA-256",
    },
    key,
    256
  );

  return toHex(new Uint8Array(bits));
}

async function getAdminUser(env: WorkerEnv): Promise<AdminUserRecord | null> {
  const kv = ensureKv(env);
  return parseUser(await kv.get(ADMIN_USER_KEY));
}

export async function hasAdminUser(env: WorkerEnv): Promise<boolean> {
  return (await getAdminUser(env)) !== null;
}

function buildSessionCookie(sessionId: string): string {
  return createCookie({
    name: SESSION_COOKIE,
    value: sessionId,
    maxAgeSeconds: SESSION_ABSOLUTE_TTL_SECONDS,
    path: "/",
    sameSite: "Lax",
    httpOnly: true,
    secure: true,
  });
}

export function buildExpiredSessionCookie(): string {
  return createCookie({
    name: SESSION_COOKIE,
    value: "",
    maxAgeSeconds: 0,
    path: "/",
    sameSite: "Lax",
    httpOnly: true,
    secure: true,
  });
}

async function writeSession(env: WorkerEnv, session: AdminSessionRecord): Promise<void> {
  const kv = ensureKv(env);

  const expiresMs = Date.parse(session.expiresAt);
  const ttl = Math.max(60, Math.floor((expiresMs - Date.now()) / 1000));
  await kv.put(sessionKvKey(session.sessionId), JSON.stringify(session), {
    expirationTtl: ttl,
  });
}

function parseClientId(request: Request): string {
  const forwarded = getHeader(request, "cf-connecting-ip");
  if (forwarded.length > 0) {
    return forwarded;
  }
  return "unknown";
}

async function clearLoginState(env: WorkerEnv, username: string, clientId: string): Promise<void> {
  const kv = ensureKv(env);
  await kv.delete(loginKvKey(username, clientId));
}

async function trackLoginFailure(
  env: WorkerEnv,
  username: string,
  clientId: string,
  nowMs: number
): Promise<{ retryAfterSeconds: number }> {
  const kv = ensureKv(env);
  const key = loginKvKey(username, clientId);
  const state = parseLoginState(await kv.get(key));

  const nextCount = state.failedCount + 1;
  let lockSeconds = 0;
  if (nextCount >= LOGIN_LOCK_THRESHOLD) {
    const exponent = nextCount - LOGIN_LOCK_THRESHOLD;
    lockSeconds = Math.min(LOGIN_LOCK_MAX_SECONDS, 30 * 2 ** exponent);
  }

  const next: LoginState = {
    failedCount: nextCount,
    lockUntilMs: lockSeconds > 0 ? nowMs + lockSeconds * 1000 : 0,
    updatedAt: nowIso(nowMs),
  };

  await kv.put(key, JSON.stringify(next), { expirationTtl: 24 * 60 * 60 });
  return {
    retryAfterSeconds: lockSeconds,
  };
}

async function readLoginState(
  env: WorkerEnv,
  username: string,
  clientId: string
): Promise<LoginState> {
  const kv = ensureKv(env);
  return parseLoginState(await kv.get(loginKvKey(username, clientId)));
}

export async function bootstrapAdminUser(
  env: WorkerEnv,
  input: { token: string; username: string; password: string }
): Promise<{ ok: true; username: string } | { ok: false; status: number; error: string }> {
  const existing = await getAdminUser(env);
  if (existing) {
    return {
      ok: false,
      status: 409,
      error: "admin_already_initialized",
    };
  }

  const expectedToken = String(env.PINCER_BOOTSTRAP_TOKEN || "").trim();
  const providedToken = String(input.token || "").trim();
  if (!expectedToken || !constantTimeEqual(expectedToken, providedToken)) {
    return {
      ok: false,
      status: 401,
      error: "invalid_bootstrap_token",
    };
  }

  const username = normalizeUsername(input.username);
  const password = String(input.password || "");
  if (!isValidUsername(username)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_username",
    };
  }

  if (password.length < 12) {
    return {
      ok: false,
      status: 400,
      error: "invalid_password",
    };
  }

  const saltHex = randomHex(16);
  const hashHex = await hashPassword({
    password,
    saltHex,
    iterations: PASSWORD_ITERATIONS,
  });

  const now = new Date().toISOString();
  const record: AdminUserRecord = {
    username,
    passwordSaltHex: saltHex,
    passwordHashHex: hashHex,
    iterations: PASSWORD_ITERATIONS,
    createdAt: now,
    updatedAt: now,
  };

  const kv = ensureKv(env);
  await kv.put(ADMIN_USER_KEY, JSON.stringify(record));

  return {
    ok: true,
    username,
  };
}

export async function loginAdminUser(
  request: Request,
  env: WorkerEnv,
  input: { username: string; password: string },
  nowMs = Date.now()
): Promise<
  | {
      ok: true;
      session: AdminSessionRecord;
      setCookie: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
      retryAfterSeconds?: number;
    }
> {
  const username = normalizeUsername(input.username);
  const password = String(input.password || "");
  const clientId = parseClientId(request);

  const lockState = await readLoginState(env, username, clientId);
  if (lockState.lockUntilMs > nowMs) {
    return {
      ok: false,
      status: 429,
      error: "login_locked",
      retryAfterSeconds: Math.max(1, Math.ceil((lockState.lockUntilMs - nowMs) / 1000)),
    };
  }

  const user = await getAdminUser(env);
  if (!user || !constantTimeEqual(user.username, username)) {
    const tracked = await trackLoginFailure(env, username, clientId, nowMs);
    return {
      ok: false,
      status: tracked.retryAfterSeconds > 0 ? 429 : 401,
      error: tracked.retryAfterSeconds > 0 ? "login_locked" : "invalid_credentials",
      retryAfterSeconds: tracked.retryAfterSeconds > 0 ? tracked.retryAfterSeconds : undefined,
    };
  }

  const computedHash = await hashPassword({
    password,
    saltHex: user.passwordSaltHex,
    iterations: user.iterations,
  });

  if (!constantTimeEqual(computedHash, user.passwordHashHex)) {
    const tracked = await trackLoginFailure(env, username, clientId, nowMs);
    return {
      ok: false,
      status: tracked.retryAfterSeconds > 0 ? 429 : 401,
      error: tracked.retryAfterSeconds > 0 ? "login_locked" : "invalid_credentials",
      retryAfterSeconds: tracked.retryAfterSeconds > 0 ? tracked.retryAfterSeconds : undefined,
    };
  }

  await clearLoginState(env, username, clientId);

  const sessionId = randomHex(24);
  const csrfToken = randomHex(24);
  const createdAt = nowIso(nowMs);
  const expiresAt = nowIso(nowMs + SESSION_ABSOLUTE_TTL_SECONDS * 1000);
  const idleExpiresAt = nowIso(nowMs + SESSION_IDLE_TTL_SECONDS * 1000);

  const session: AdminSessionRecord = {
    sessionId,
    username,
    csrfToken,
    createdAt,
    updatedAt: createdAt,
    lastSeenAt: createdAt,
    rotatedAt: createdAt,
    expiresAt,
    idleExpiresAt,
  };

  await writeSession(env, session);

  return {
    ok: true,
    session,
    setCookie: buildSessionCookie(sessionId),
  };
}

export async function logoutAdminSession(request: Request, env: WorkerEnv): Promise<{ setCookie: string }> {
  const sessionId = getCookie(request, SESSION_COOKIE);
  if (sessionId) {
    const kv = ensureKv(env);
    await kv.delete(sessionKvKey(sessionId));
  }

  return {
    setCookie: buildExpiredSessionCookie(),
  };
}

async function rotateSession(
  env: WorkerEnv,
  session: AdminSessionRecord,
  nowMs: number
): Promise<{ session: AdminSessionRecord; setCookie: string }> {
  const kv = ensureKv(env);
  await kv.delete(sessionKvKey(session.sessionId));

  const nextSessionId = randomHex(24);
  const updatedAt = nowIso(nowMs);
  const next: AdminSessionRecord = {
    ...session,
    sessionId: nextSessionId,
    csrfToken: randomHex(24),
    rotatedAt: updatedAt,
    updatedAt,
    lastSeenAt: updatedAt,
    idleExpiresAt: nowIso(nowMs + SESSION_IDLE_TTL_SECONDS * 1000),
  };

  await writeSession(env, next);

  return {
    session: next,
    setCookie: buildSessionCookie(nextSessionId),
  };
}

export async function requireAdminSession(
  request: Request,
  env: WorkerEnv,
  options: { requireCsrf: boolean; nowMs?: number }
): Promise<SessionValidationResult> {
  const sessionId = getCookie(request, SESSION_COOKIE);
  if (!sessionId) {
    return {
      ok: false,
      status: 401,
      error: "missing_admin_session",
      setCookie: buildExpiredSessionCookie(),
    };
  }

  const kv = ensureKv(env);
  const session = parseSession(await kv.get(sessionKvKey(sessionId)));
  if (!session) {
    return {
      ok: false,
      status: 401,
      error: "invalid_admin_session",
      setCookie: buildExpiredSessionCookie(),
    };
  }

  const nowMs = options.nowMs ?? Date.now();
  const expiresAtMs = Date.parse(session.expiresAt);
  const idleExpiresAtMs = Date.parse(session.idleExpiresAt);

  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(idleExpiresAtMs) || nowMs > expiresAtMs || nowMs > idleExpiresAtMs) {
    await kv.delete(sessionKvKey(session.sessionId));
    return {
      ok: false,
      status: 401,
      error: "expired_admin_session",
      setCookie: buildExpiredSessionCookie(),
    };
  }

  if (options.requireCsrf) {
    const csrfHeader = getHeader(request, "x-pincer-csrf");
    if (!csrfHeader || !constantTimeEqual(csrfHeader, session.csrfToken)) {
      return {
        ok: false,
        status: 403,
        error: "invalid_csrf_token",
      };
    }
  }

  const rotateAgeMs = nowMs - Date.parse(session.rotatedAt);
  if (Number.isFinite(rotateAgeMs) && rotateAgeMs >= SESSION_ROTATE_INTERVAL_MS) {
    const rotated = await rotateSession(env, session, nowMs);
    return {
      ok: true,
      session: rotated.session,
      setCookie: rotated.setCookie,
    };
  }

  const updated: AdminSessionRecord = {
    ...session,
    updatedAt: nowIso(nowMs),
    lastSeenAt: nowIso(nowMs),
    idleExpiresAt: nowIso(nowMs + SESSION_IDLE_TTL_SECONDS * 1000),
  };

  await writeSession(env, updated);

  return {
    ok: true,
    session: updated,
  };
}
