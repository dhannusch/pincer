export type AdminApiCredentials = {
  workerUrl: string;
  username: string;
  password: string;
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractCookie(setCookieHeader: string): string {
  const first = (setCookieHeader || "").split(",")[0] || "";
  return first.split(";")[0].trim();
}

export class AdminApiClient {
  private readonly workerUrl: string;
  private readonly username: string;
  private readonly password: string;

  private cookie = "";
  private csrfToken = "";

  constructor(input: AdminApiCredentials) {
    this.workerUrl = input.workerUrl.replace(/\/$/, "");
    this.username = input.username;
    this.password = input.password;
  }

  async login(): Promise<void> {
    const response = await fetch(`${this.workerUrl}/v1/admin/session/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        username: this.username,
        password: this.password,
      }),
    });

    const text = await response.text();
    const payload = parseJson(text);

    if (!response.ok) {
      throw new Error(`Login failed (${response.status}): ${JSON.stringify(payload)}`);
    }

    const setCookie = response.headers.get("set-cookie") || "";
    this.cookie = extractCookie(setCookie);

    if (!payload || typeof payload !== "object" || typeof (payload as { csrfToken?: unknown }).csrfToken !== "string") {
      throw new Error("Login response is missing csrfToken");
    }

    this.csrfToken = (payload as { csrfToken: string }).csrfToken;
  }

  private async ensureSession(): Promise<void> {
    if (!this.cookie || !this.csrfToken) {
      await this.login();
    }
  }

  private async requestInternal(
    method: "GET" | "POST" | "PUT" | "DELETE",
    pathName: string,
    payload?: unknown
  ): Promise<unknown> {
    await this.ensureSession();

    const headers: Record<string, string> = {
      cookie: this.cookie,
      "content-type": "application/json",
    };

    const isMutating = method !== "GET";
    if (isMutating) {
      headers["x-pincer-csrf"] = this.csrfToken;
    }

    const response = await fetch(`${this.workerUrl}${pathName}`, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(payload || {}),
    });

    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const nextCookie = extractCookie(setCookie);
      if (nextCookie.length > 0) {
        this.cookie = nextCookie;
      }
    }

    const text = await response.text();
    const parsed = parseJson(text);

    if (!response.ok) {
      if (response.status === 401) {
        this.cookie = "";
        this.csrfToken = "";
      }
      throw new Error(`Request failed (${response.status}): ${JSON.stringify(parsed)}`);
    }

    if (parsed && typeof parsed === "object" && typeof (parsed as { csrfToken?: unknown }).csrfToken === "string") {
      this.csrfToken = (parsed as { csrfToken: string }).csrfToken;
    }

    return parsed;
  }

  async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    pathName: string,
    payload?: unknown
  ): Promise<unknown> {
    try {
      return await this.requestInternal(method, pathName, payload);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("(401)")) {
        throw error;
      }

      await this.login();
      return this.requestInternal(method, pathName, payload);
    }
  }
}
