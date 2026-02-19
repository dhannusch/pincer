import { sha256Hex } from "@pincerclaw/shared-types";

import { authenticateRuntimeRequest } from "./auth.js";
import {
  bootstrapAdminUser,
  hasAdminUser,
  loginAdminUser,
  logoutAdminSession,
  requireAdminSession,
  type AdminSessionRecord,
} from "./admin-auth.js";
import {
  applyAdapterManifest,
  enableAdapter,
  disableAdapter,
  getProposalManifestSummary,
  listProposalAuditEvents,
  listActiveAdapters,
  listEnabledAdapters,
  listAdapterProposals,
  rejectAdapterProposal,
  submitAdapterProposal,
} from "./adapters/index.js";
import { renderAdminPage } from "./admin-ui.js";
import { handleConnect, pairingKvKey } from "./connect.js";
import { APP_VERSION } from "./constants.js";
import { getConfigSnapshot, getDoctorChecks, getRuntimeRecord } from "./config.js";
import { getPathParts, jsonResponse, parseJson } from "./http.js";
import { getMetricsSnapshot } from "./metrics.js";
import { proxyAdapterRequest } from "./proxy.js";
import type { WorkerEnv } from "./types.js";
import {
  createPairingCode,
  deleteVaultSecret,
  listSecretMetadata,
  putVaultSecret,
  resolveSecretValue,
} from "./vault.js";

const PAIRING_TTL_SECONDS = 15 * 60;

type AdminGate = {
  session: AdminSessionRecord;
  headers: Record<string, string>;
};

function randomHex(byteLength: number): string {
  if (!globalThis.crypto) {
    throw new Error("Web Crypto API unavailable");
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unauthorizedAdminResponse(input: {
  status: number;
  error: string;
  setCookie?: string;
  retryAfterSeconds?: number;
}): Response {
  const headers: Record<string, string> = {};
  if (input.setCookie) {
    headers["set-cookie"] = input.setCookie;
  }
  if (typeof input.retryAfterSeconds === "number") {
    headers["retry-after"] = String(input.retryAfterSeconds);
  }

  return jsonResponse(input.status, { error: input.error }, headers);
}

async function requireAdmin(request: Request, env: WorkerEnv): Promise<Response | AdminGate> {
  const requireCsrf = request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
  const auth = await requireAdminSession(request, env, { requireCsrf });
  if (auth.ok === false) {
    return unauthorizedAdminResponse({
      status: auth.status,
      error: auth.error,
      setCookie: auth.setCookie,
      retryAfterSeconds: auth.retryAfterSeconds,
    });
  }

  return {
    session: auth.session,
    headers: auth.setCookie ? { "set-cookie": auth.setCookie } : {},
  };
}

export function createApp({ fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {}) {
  return {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
      const url = new URL(request.url);
      const parts = getPathParts(url.pathname);

      if (request.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/bootstrap")) {
        const needsBootstrap = !(await hasAdminUser(env));
        return renderAdminPage({ needsBootstrap });
      }

      if (request.method === "GET" && url.pathname === "/v1/health") {
        try {
          const snapshot = await getConfigSnapshot(env, false);
          return jsonResponse(200, {
            ok: true,
            service: "pincer-worker",
            version: APP_VERSION,
            configVersion: snapshot.version,
          });
        } catch (error) {
          return jsonResponse(500, {
            ok: false,
            error: "invalid_config",
            details: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (request.method === "POST" && url.pathname === "/v1/connect") {
        return handleConnect(request, env);
      }

      if (request.method === "POST" && url.pathname === "/v1/adapters/proposals") {
        const rawBody = await request.text();
        const auth = await authenticateRuntimeRequest(request, env, rawBody, "/v1/adapters/proposals");
        if (auth.ok === false) {
          return jsonResponse(auth.status, { error: auth.reason });
        }

        const payload = parseJson<Record<string, unknown> | null>(rawBody, null);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return jsonResponse(400, { error: "invalid_payload" });
        }

        const result = await submitAdapterProposal(env, payload.manifest, auth.keyId);
        if (result.ok === false) {
          return jsonResponse(result.error.status, {
            error: result.error.error,
            details: result.error.details,
          });
        }

        return jsonResponse(202, {
          ok: true,
          proposal: result.data,
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/adapters") {
        const auth = await authenticateRuntimeRequest(request, env, "", "/v1/adapters");
        if (auth.ok === false) {
          return jsonResponse(auth.status, { error: auth.reason });
        }

        const adapters = await listEnabledAdapters(env);
        return jsonResponse(200, {
          ok: true,
          adapters,
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/bootstrap") {
        const needsBootstrap = !(await hasAdminUser(env));
        return jsonResponse(200, {
          ok: true,
          needsBootstrap,
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/bootstrap") {
        const payload = parseJson<Record<string, unknown> | null>(await request.text(), null);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return jsonResponse(400, { error: "invalid_payload" });
        }

        const result = await bootstrapAdminUser(env, {
          token: typeof payload.token === "string" ? payload.token : "",
          username: typeof payload.username === "string" ? payload.username : "",
          password: typeof payload.password === "string" ? payload.password : "",
        });

        if (result.ok === false) {
          return jsonResponse(result.status, { error: result.error });
        }

        return jsonResponse(200, {
          ok: true,
          username: result.username,
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/session/login") {
        const payload = parseJson<Record<string, unknown> | null>(await request.text(), null);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return jsonResponse(400, { error: "invalid_payload" });
        }

        const result = await loginAdminUser(request, env, {
          username: typeof payload.username === "string" ? payload.username : "",
          password: typeof payload.password === "string" ? payload.password : "",
        });

        if (result.ok === false) {
          return unauthorizedAdminResponse({
            status: result.status,
            error: result.error,
            retryAfterSeconds: result.retryAfterSeconds,
          });
        }

        return jsonResponse(
          200,
          {
            ok: true,
            username: result.session.username,
            csrfToken: result.session.csrfToken,
            expiresAt: result.session.expiresAt,
            idleExpiresAt: result.session.idleExpiresAt,
          },
          { "set-cookie": result.setCookie }
        );
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/session/logout") {
        const result = await logoutAdminSession(request, env);
        return jsonResponse(200, { ok: true }, { "set-cookie": result.setCookie });
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/session/me") {
        const admin = await requireAdminSession(request, env, { requireCsrf: false });
        if (admin.ok === false) {
          return unauthorizedAdminResponse({
            status: admin.status,
            error: admin.error,
            setCookie: admin.setCookie,
          });
        }

        return jsonResponse(
          200,
          {
            ok: true,
            username: admin.session.username,
            csrfToken: admin.session.csrfToken,
            expiresAt: admin.session.expiresAt,
            idleExpiresAt: admin.session.idleExpiresAt,
          },
          admin.setCookie ? { "set-cookie": admin.setCookie } : {}
        );
      }

      if (parts.length >= 2 && parts[0] === "v1" && parts[1] === "admin") {
        const admin = await requireAdmin(request, env);
        if (admin instanceof Response) {
          return admin;
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/doctor") {
          const checks = await getDoctorChecks(env);
          const ok = checks.every((check) => check.ok);

          return jsonResponse(
            ok ? 200 : 500,
            {
              ok,
              generatedAt: new Date().toISOString(),
              checks,
            },
            admin.headers
          );
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/metrics") {
          return jsonResponse(
            200,
            {
              ok: true,
              generatedAt: new Date().toISOString(),
              metrics: getMetricsSnapshot(),
            },
            admin.headers
          );
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/secrets") {
          const runtime = await getRuntimeRecord(env);
          const activeAdapters = await listActiveAdapters(env);
          const hints = [runtime.hmacSecretBinding, runtime.keySecretBinding];
          for (const adapter of activeAdapters) {
            hints.push(...adapter.requiredSecrets);
          }

          return jsonResponse(
            200,
            {
              ok: true,
              secrets: await listSecretMetadata(env, hints),
            },
            admin.headers
          );
        }

        if (
          parts.length === 4 &&
          parts[0] === "v1" &&
          parts[1] === "admin" &&
          parts[2] === "secrets" &&
          (request.method === "PUT" || request.method === "DELETE")
        ) {
          const binding = decodeURIComponent(parts[3]);

          if (request.method === "PUT") {
            const payload = parseJson<Record<string, unknown> | null>(await request.text(), null);
            const value = payload && typeof payload.value === "string" ? payload.value : "";
            if (value.trim().length === 0) {
              return jsonResponse(400, { error: "invalid_secret_value" }, admin.headers);
            }

            const record = await putVaultSecret(env, {
              binding,
              value,
              updatedBy: admin.session.username,
            });

            return jsonResponse(
              200,
              {
                ok: true,
                secret: {
                  binding,
                  updatedAt: record.updatedAt,
                },
              },
              admin.headers
            );
          }

          await deleteVaultSecret(env, binding);
          return jsonResponse(200, { ok: true, binding }, admin.headers);
        }

        if (request.method === "POST" && url.pathname === "/v1/admin/runtime/rotate") {
          const runtime = await getRuntimeRecord(env);
          const nextRuntimeKeyId = `rk_${randomHex(8)}`;
          const nextRuntimeKeySecret = randomHex(24);
          const nextRuntimeKeyHash = await sha256Hex(nextRuntimeKeySecret);
          const nextRuntimeHmacSecret = randomHex(32);

          await putVaultSecret(env, {
            binding: runtime.keySecretBinding,
            value: nextRuntimeKeySecret,
            updatedBy: admin.session.username,
          });
          await putVaultSecret(env, {
            binding: runtime.hmacSecretBinding,
            value: nextRuntimeHmacSecret,
            updatedBy: admin.session.username,
          });

          const kv = env.PINCER_CONFIG_KV;
          if (!kv) {
            return jsonResponse(500, { error: "missing_kv_binding" }, admin.headers);
          }

          const nextRuntime = {
            id: nextRuntimeKeyId,
            keyHash: nextRuntimeKeyHash,
            hmacSecretBinding: runtime.hmacSecretBinding,
            keySecretBinding: runtime.keySecretBinding,
            skewSeconds: runtime.skewSeconds || 60,
            updatedAt: new Date().toISOString(),
          };

          await kv.put("runtime:active", JSON.stringify(nextRuntime));

          return jsonResponse(
            200,
            {
              ok: true,
              runtime: {
                id: nextRuntime.id,
                updatedAt: nextRuntime.updatedAt,
              },
            },
            admin.headers
          );
        }

        if (request.method === "POST" && url.pathname === "/v1/admin/pairing/generate") {
          const runtime = await getRuntimeRecord(env);
          const runtimeKeySecret = await resolveSecretValue(env, runtime.keySecretBinding);
          const runtimeHmacSecret = await resolveSecretValue(env, runtime.hmacSecretBinding);

          if (!runtimeKeySecret || !runtimeHmacSecret) {
            return jsonResponse(
              500,
              {
                error: "missing_runtime_pairing_secrets",
              },
              admin.headers
            );
          }

          const kv = env.PINCER_CONFIG_KV;
          if (!kv) {
            return jsonResponse(500, { error: "missing_kv_binding" }, admin.headers);
          }

          const code = createPairingCode();
          const workerUrl = `${url.protocol}//${url.host}`;
          const runtimeKey = `${runtime.id}.${runtimeKeySecret}`;

          await kv.put(
            pairingKvKey(code),
            JSON.stringify({
              workerUrl,
              runtimeKey,
              hmacSecret: runtimeHmacSecret,
            }),
            {
              expirationTtl: PAIRING_TTL_SECONDS,
            }
          );

          return jsonResponse(
            200,
            {
              ok: true,
              code,
              expiresInSeconds: PAIRING_TTL_SECONDS,
            },
            admin.headers
          );
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/adapters/proposals") {
          const proposals = await listAdapterProposals(env);
          return jsonResponse(200, {
            ok: true,
            proposals,
          }, admin.headers);
        }

        if (
          request.method === "GET" &&
          parts.length === 5 &&
          parts[2] === "adapters" &&
          parts[3] === "proposals"
        ) {
          const proposalId = parts[4];
          const result = await getProposalManifestSummary(env, proposalId);
          if (result.ok === false) {
            return jsonResponse(result.error.status, {
              error: result.error.error,
            }, admin.headers);
          }

          return jsonResponse(200, {
            ok: true,
            proposal: result.data,
          }, admin.headers);
        }

        if (
          request.method === "POST" &&
          parts.length === 6 &&
          parts[2] === "adapters" &&
          parts[3] === "proposals" &&
          parts[5] === "reject"
        ) {
          const proposalId = parts[4];
          const payload = parseJson<Record<string, unknown> | null>(await request.text(), null);
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            return jsonResponse(400, { error: "invalid_payload" }, admin.headers);
          }

          const reasonRaw = typeof payload.reason === "string" ? payload.reason.trim() : "";
          if (reasonRaw.length > 500) {
            return jsonResponse(400, {
              error: "invalid_reason",
              details: ["reason must be 500 characters or fewer"],
            }, admin.headers);
          }

          const result = await rejectAdapterProposal(
            env,
            proposalId,
            reasonRaw.length > 0 ? reasonRaw : undefined
          );
          if (result.ok === false) {
            return jsonResponse(result.error.status, {
              error: result.error.error,
              details: result.error.details,
            }, admin.headers);
          }

          return jsonResponse(200, {
            ok: true,
            result: result.data,
          }, admin.headers);
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/audit") {
          const since = url.searchParams.get("since") || undefined;
          const limitRaw = url.searchParams.get("limit");
          const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
          let sinceIso: string | undefined = undefined;

          if (since) {
            const parsedSince = Date.parse(since);
            if (!Number.isFinite(parsedSince)) {
              return jsonResponse(400, {
                error: "invalid_since",
                details: ["since must be an ISO-8601 timestamp"],
              }, admin.headers);
            }
            sinceIso = new Date(parsedSince).toISOString();
          }

          if (limitRaw && (!Number.isInteger(limit) || limit <= 0)) {
            return jsonResponse(400, {
              error: "invalid_limit",
              details: ["limit must be a positive integer"],
            }, admin.headers);
          }

          const events = await listProposalAuditEvents(env, { since: sinceIso, limit });
          return jsonResponse(200, {
            ok: true,
            events,
          }, admin.headers);
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/adapters") {
          const adapters = await listActiveAdapters(env);
          return jsonResponse(200, {
            ok: true,
            adapters,
          }, admin.headers);
        }

        if (request.method === "POST" && url.pathname === "/v1/admin/adapters/apply") {
          const payload = parseJson<Record<string, unknown> | null>(await request.text(), null);
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            return jsonResponse(400, { error: "invalid_payload" }, admin.headers);
          }

          const result = await applyAdapterManifest(env, {
            proposalId: typeof payload.proposalId === "string" ? payload.proposalId : undefined,
            manifestRaw: payload.manifest,
          });

          if (result.ok === false) {
            return jsonResponse(result.error.status, {
              error: result.error.error,
              details: result.error.details,
              missingSecrets: result.error.missingSecrets,
            }, admin.headers);
          }

          return jsonResponse(200, {
            ok: true,
            result: result.data.result,
            manifest: {
              id: result.data.manifest.id,
              revision: result.data.manifest.revision,
              actionNames: Object.keys(result.data.manifest.actions).sort(),
              requiredSecrets: result.data.manifest.requiredSecrets,
            },
          }, admin.headers);
        }

        if (
          request.method === "POST" &&
          parts.length === 5 &&
          parts[2] === "adapters" &&
          parts[4] === "disable"
        ) {
          const adapterId = parts[3];
          const result = await disableAdapter(env, adapterId);
          if (result.ok === false) {
            return jsonResponse(result.error.status, {
              error: result.error.error,
            }, admin.headers);
          }

          return jsonResponse(200, {
            ok: true,
            adapter: result.data,
          }, admin.headers);
        }

        if (
          request.method === "POST" &&
          parts.length === 5 &&
          parts[2] === "adapters" &&
          parts[4] === "enable"
        ) {
          const adapterId = parts[3];
          const result = await enableAdapter(env, adapterId);
          if (result.ok === false) {
            return jsonResponse(result.error.status, {
              error: result.error.error,
            }, admin.headers);
          }

          return jsonResponse(200, {
            ok: true,
            adapter: result.data,
          }, admin.headers);
        }

        return jsonResponse(404, { error: "not_found" }, admin.headers);
      }

      if (
        request.method === "POST" &&
        parts.length === 4 &&
        parts[0] === "v1" &&
        parts[1] === "adapter"
      ) {
        const adapter = parts[2];
        const action = parts[3];

        return proxyAdapterRequest({ request, env, adapter, action, fetchImpl });
      }

      return jsonResponse(404, { error: "not_found" });
    },
  };
}

const app = createApp();

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return app.fetch(request, env);
  },
};
