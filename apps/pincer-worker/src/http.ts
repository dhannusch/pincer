export function jsonResponse(
  status: number,
  payload: unknown,
  headersInit: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headersInit,
    },
  });
}

export function getPathParts(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

export function getHeader(request: Request, name: string): string {
  return request.headers.get(name) || "";
}

export function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function parseCookies(request: Request): Record<string, string> {
  const cookieHeader = request.headers.get("cookie") || "";
  const parsed: Record<string, string> = {};

  for (const pair of cookieHeader.split(";")) {
    const trimmed = pair.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key.length === 0) {
      continue;
    }
    parsed[key] = value;
  }

  return parsed;
}

export function getCookie(request: Request, name: string): string {
  return parseCookies(request)[name] || "";
}

export function createCookie(input: {
  name: string;
  value: string;
  maxAgeSeconds?: number;
  path?: string;
  sameSite?: "Lax" | "Strict" | "None";
  httpOnly?: boolean;
  secure?: boolean;
}): string {
  const parts = [`${input.name}=${input.value}`];
  parts.push(`Path=${input.path || "/"}`);

  if (typeof input.maxAgeSeconds === "number") {
    parts.push(`Max-Age=${Math.max(0, Math.floor(input.maxAgeSeconds))}`);
  }

  parts.push(`SameSite=${input.sameSite || "Lax"}`);

  if (input.httpOnly !== false) {
    parts.push("HttpOnly");
  }
  if (input.secure !== false) {
    parts.push("Secure");
  }

  return parts.join("; ");
}
