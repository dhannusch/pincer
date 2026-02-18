import { authenticateRuntimeRequest, isAdminAuthorized } from "./auth.js";
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
import { handleConnect } from "./connect.js";
import { APP_VERSION } from "./constants.js";
import { getConfigSnapshot, getDoctorChecks } from "./config.js";
import { getPathParts, jsonResponse, parseJson } from "./http.js";
import { getMetricsSnapshot } from "./metrics.js";
import { proxyAdapterRequest } from "./proxy.js";
import type { WorkerEnv } from "./types.js";

function unauthorizedAdminResponse(): Response {
  return jsonResponse(401, { error: "unauthorized_admin" });
}

export function createApp({ fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {}) {
  return {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
      const url = new URL(request.url);
      const parts = getPathParts(url.pathname);

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

      if (request.method === "GET" && url.pathname === "/v1/admin/doctor") {
        if (!isAdminAuthorized(request, env)) {
          return unauthorizedAdminResponse();
        }

        const checks = await getDoctorChecks(env);
        const ok = checks.every((check) => check.ok);

        return jsonResponse(ok ? 200 : 500, {
          ok,
          generatedAt: new Date().toISOString(),
          checks,
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/metrics") {
        if (!isAdminAuthorized(request, env)) {
          return unauthorizedAdminResponse();
        }

        return jsonResponse(200, {
          ok: true,
          generatedAt: new Date().toISOString(),
          metrics: getMetricsSnapshot(),
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/adapters/proposals") {
        if (!isAdminAuthorized(request, env)) {
          return unauthorizedAdminResponse();
        }

        const proposals = await listAdapterProposals(env);
        return jsonResponse(200, {
          ok: true,
          proposals,
        });
      }

      if (
        request.method === "GET" &&
        parts.length === 5 &&
        parts[0] === "v1" &&
        parts[1] === "admin" &&
        parts[2] === "adapters" &&
        parts[3] === "proposals"
      ) {
        if (!isAdminAuthorized(request, env)) {
          return unauthorizedAdminResponse();
        }

        const proposalId = parts[4];
        const result = await getProposalManifestSummary(env, proposalId);
        if (result.ok === false) {
          return jsonResponse(result.error.status, {
            error: result.error.error,
          });
        }

        return jsonResponse(200, {
          ok: true,
          proposal: result.data,
        });
      }

      if (
        request.method === "POST" &&
        parts.length === 6 &&
        parts[0] === "v1" &&
        parts[1] === "admin" &&
        parts[2] === "adapters" &&
        parts[3] === "proposals" &&
        parts[5] === "reject"
      ) {
        if (!isAdminAuthorized(request, env)) {
          return unauthorizedAdminResponse();
        }

        const proposalId = parts[4];
        const payload = parseJson<Record<string, unknown> | null>(await request.text(), null);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return jsonResponse(400, { error: "invalid_payload" });
        }

        const reasonRaw = typeof payload.reason === "string" ? payload.reason.trim() : "";
        if (reasonRaw.length > 500) {
          return jsonResponse(400, {
            error: "invalid_reason",
            details: ["reason must be 500 characters or fewer"],
          });
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
          });
        }

        return jsonResponse(200, {
          ok: true,
          result: result.data,
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/audit") {
        if (!isAdminAuthorized(request, env)) {
          return unauthorizedAdminResponse();
        }

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
            });
          }
          sinceIso = new Date(parsedSince).toISOString();
        }

        if (limitRaw && (!Number.isInteger(limit) || limit <= 0)) {
          return jsonResponse(400, {
            error: "invalid_limit",
            details: ["limit must be a positive integer"],
          });
        }

        const events = await listProposalAuditEvents(env, { since: sinceIso, limit });
        return jsonResponse(200, {
          ok: true,
          events,
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/adapters") {
        if (!isAdminAuthorized(request, env)) {
          return unauthorizedAdminResponse();
        }

        const adapters = await listActiveAdapters(env);
        return jsonResponse(200, {
          ok: true,
          adapters,
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/adapters/apply") {
        if (!isAdminAuthorized(request, env)) {
          return unauthorizedAdminResponse();
        }

        const payload = parseJson<Record<string, unknown> | null>(await request.text(), null);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return jsonResponse(400, { error: "invalid_payload" });
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
          });
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
        });
      }

      if (
        request.method === "POST" &&
        parts.length === 5 &&
        parts[0] === "v1" &&
        parts[1] === "admin" &&
        parts[2] === "adapters" &&
        parts[4] === "disable"
      ) {
        if (!isAdminAuthorized(request, env)) {
          return unauthorizedAdminResponse();
        }

        const adapterId = parts[3];
        const result = await disableAdapter(env, adapterId);
        if (result.ok === false) {
          return jsonResponse(result.error.status, {
            error: result.error.error,
          });
        }

        return jsonResponse(200, {
          ok: true,
          adapter: result.data,
        });
      }

      if (
        request.method === "POST" &&
        parts.length === 5 &&
        parts[0] === "v1" &&
        parts[1] === "admin" &&
        parts[2] === "adapters" &&
        parts[4] === "enable"
      ) {
        if (!isAdminAuthorized(request, env)) {
          return unauthorizedAdminResponse();
        }

        const adapterId = parts[3];
        const result = await enableAdapter(env, adapterId);
        if (result.ok === false) {
          return jsonResponse(result.error.status, {
            error: result.error.error,
          });
        }

        return jsonResponse(200, {
          ok: true,
          adapter: result.data,
        });
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
