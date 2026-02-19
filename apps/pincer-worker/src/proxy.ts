import { validateInputWithSchema } from "@pincerclaw/shared-types";

import { authenticateRuntimeRequest } from "./auth.js";
import { getAdapterAction } from "./adapters/index.js";
import { jsonResponse, parseJson } from "./http.js";
import { classifyStatus, emitAnalyticsMetric } from "./metrics.js";
import { enforceRateLimit } from "./rate-limit.js";
import type { ProxyMetric, WorkerEnv } from "./types.js";
import { resolveSecretValue } from "./vault.js";

function coerceInputPayload(parsedBody: unknown): Record<string, unknown> | null {
  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
    return null;
  }

  if (!("input" in parsedBody)) {
    return null;
  }

  const input = (parsedBody as { input?: unknown }).input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  if (input === null || input === undefined) {
    return {};
  }

  return null;
}

async function buildUpstreamRequest(
  adapterBaseUrl: string,
  actionSpec: {
    method: "GET" | "POST";
    path: string;
    requestMode: "query" | "json";
    auth: {
      placement: "header" | "query";
      name: string;
      secretBinding: string;
      prefix?: string;
    };
  },
  input: Record<string, unknown>,
  env: WorkerEnv
): Promise<{ url: URL; requestInit: RequestInit }> {
  const url = new URL(actionSpec.path, adapterBaseUrl);
  const headers = new Headers();

  const authSecret = await resolveSecretValue(env, actionSpec.auth.secretBinding);
  if (!authSecret) {
    throw new Error(`missing secret binding '${actionSpec.auth.secretBinding}'`);
  }

  if (actionSpec.auth.placement === "header") {
    const prefix = actionSpec.auth.prefix || "";
    headers.set(actionSpec.auth.name, `${prefix}${authSecret}`);
  } else {
    url.searchParams.set(actionSpec.auth.name, authSecret);
  }

  let body: string | undefined;
  if (actionSpec.requestMode === "json") {
    body = JSON.stringify(input || {});
    headers.set("content-type", "application/json");
  } else {
    for (const [key, value] of Object.entries(input || {})) {
      if (value === undefined || value === null) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }

  return {
    url,
    requestInit: {
      method: actionSpec.method,
      headers,
      body,
    },
  };
}

function deniedMetric(adapter: string, action: string): ProxyMetric {
  return {
    adapter,
    action,
    outcome: "denied",
    statusClass: "4xx",
    denyReason: "unknown",
    latencyMs: 0,
  };
}

function actionNotAllowedResponse(reason = "action_not_allowed"): Response {
  return jsonResponse(403, { error: reason });
}

export async function proxyAdapterRequest({
  request,
  env,
  adapter,
  action,
  fetchImpl,
}: {
  request: Request;
  env: WorkerEnv;
  adapter: string;
  action: string;
  fetchImpl: typeof fetch;
}): Promise<Response> {
  const startedAt = Date.now();
  let metric = deniedMetric(adapter, action);

  try {
    const rawBody = await request.text();
    const path = `/v1/adapter/${adapter}/${action}`;

    const auth = await authenticateRuntimeRequest(request, env, rawBody, path);
    if (auth.ok === false) {
      metric = {
        ...metric,
        outcome: "denied",
        statusClass: classifyStatus(auth.status),
        denyReason: auth.reason,
      };
      return jsonResponse(auth.status, { error: auth.reason });
    }

    const actionRef = await getAdapterAction(env, adapter, action);
    if (!actionRef) {
      metric = {
        ...metric,
        outcome: "denied",
        denyReason: "action_not_allowed",
      };
      return actionNotAllowedResponse();
    }

    const parsedBody = parseJson<unknown>(rawBody, null);
    const input = coerceInputPayload(parsedBody);
    if (!input) {
      metric = {
        ...metric,
        outcome: "denied",
        statusClass: "4xx",
        denyReason: "invalid_input_payload",
      };
      return jsonResponse(400, {
        error: "invalid_input_payload",
        message: 'Expected body shape {"input": {...}}',
      });
    }

    const validationErrors = validateInputWithSchema(input, actionRef.action.inputSchema);
    if (validationErrors.length > 0) {
      metric = {
        ...metric,
        outcome: "denied",
        statusClass: "4xx",
        denyReason: "invalid_input",
      };
      return jsonResponse(400, {
        error: "invalid_input",
        details: validationErrors,
      });
    }

    const limits = actionRef.action.limits;

    const maxBodyBytes = Math.floor(limits.maxBodyKb * 1024);
    if (rawBody.length > maxBodyBytes) {
      metric = {
        ...metric,
        outcome: "denied",
        statusClass: "4xx",
        denyReason: "body_too_large",
      };
      return jsonResponse(413, { error: "body_too_large" });
    }

    const rateLimit = enforceRateLimit(auth.keyId, adapter, action, limits.ratePerMinute, startedAt);
    if (rateLimit.ok === false) {
      metric = {
        ...metric,
        outcome: "denied",
        statusClass: "4xx",
        denyReason: rateLimit.reason,
      };
      return jsonResponse(429, { error: rateLimit.reason });
    }

    const { url, requestInit } = await buildUpstreamRequest(
      actionRef.adapter.baseUrl,
      actionRef.action,
      input,
      env
    );

    if (url.protocol !== "https:" || !actionRef.adapter.allowedHosts.includes(url.host.toLowerCase())) {
      metric = {
        ...metric,
        outcome: "denied",
        statusClass: "4xx",
        denyReason: "host_not_allowed",
      };
      return jsonResponse(403, { error: "host_not_allowed" });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetchImpl(url.toString(), {
        ...requestInit,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!upstreamResponse.ok) {
      metric = {
        ...metric,
        outcome: "error",
        statusClass: classifyStatus(upstreamResponse.status),
        denyReason: "upstream_error",
      };
      return jsonResponse(502, {
        error: "upstream_error",
        upstreamStatus: upstreamResponse.status,
      });
    }

    const contentType = upstreamResponse.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = await upstreamResponse.json();
      metric = {
        ...metric,
        outcome: "allowed",
        statusClass: "2xx",
        denyReason: "",
      };
      return jsonResponse(200, {
        ok: true,
        adapter,
        action,
        data: payload,
      });
    }

    const text = await upstreamResponse.text();
    metric = {
      ...metric,
      outcome: "allowed",
      statusClass: "2xx",
      denyReason: "",
    };

    return jsonResponse(200, {
      ok: true,
      adapter,
      action,
      data: text,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected_error";
    metric = {
      ...metric,
      outcome: "error",
      statusClass: "5xx",
      denyReason: "internal_error",
    };

    return jsonResponse(500, {
      error: "internal_error",
      message: message.replace(/secret/gi, "[redacted]"),
    });
  } finally {
    metric.latencyMs = Date.now() - startedAt;
    await emitAnalyticsMetric(env, metric);
  }
}
