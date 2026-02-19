export function renderAdminPage(input: { needsBootstrap: boolean }): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Pincer Admin</title>
    <style>
      :root {
        --bg: #f4f1ea;
        --card: #fffdf8;
        --ink: #18150f;
        --muted: #6c665b;
        --accent: #1d7f56;
        --accent-ink: #ffffff;
        --warn: #9a3a10;
        --border: #ddd3c0;
      }
      body { margin: 0; font-family: "IBM Plex Sans", "Segoe UI", sans-serif; background: radial-gradient(circle at 10% 0%, #fff5df, #f4f1ea 50%); color: var(--ink); }
      main { max-width: 980px; margin: 0 auto; padding: 24px 16px 40px; }
      h1 { margin: 0 0 4px; font-size: 1.8rem; }
      .sub { color: var(--muted); margin: 0 0 20px; }
      section { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 14px; margin: 14px 0; box-shadow: 0 8px 24px rgba(40, 31, 13, 0.06); }
      label { display: block; font-size: 0.85rem; color: var(--muted); margin-bottom: 4px; }
      input, textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 8px; padding: 9px; margin-bottom: 8px; background: #fff; }
      button { border: 0; border-radius: 8px; padding: 9px 12px; background: var(--accent); color: var(--accent-ink); cursor: pointer; font-weight: 600; }
      button.secondary { background: #d6d2c8; color: #1d1b16; }
      .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .hidden { display: none; }
      pre { background: #1f1c17; color: #f5f2e7; border-radius: 8px; padding: 10px; overflow: auto; }
      #status { color: var(--warn); margin: 0 0 10px; }
      @media (max-width: 760px) { .row { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <h1>Pincer Admin</h1>
      <p class="sub">UI-first control plane</p>
      <p id="status"></p>

      <section id="bootstrap-card" class="${input.needsBootstrap ? "" : "hidden"}">
        <h2>Bootstrap</h2>
        <label>Bootstrap Token</label>
        <input id="bootstrap-token" type="password" autocomplete="off" />
        <label>Admin Username</label>
        <input id="bootstrap-username" value="admin" autocomplete="off" />
        <label>Admin Password</label>
        <input id="bootstrap-password" type="password" autocomplete="off" />
        <button id="bootstrap-submit">Create Admin</button>
      </section>

      <section id="login-card" class="${input.needsBootstrap ? "hidden" : ""}">
        <h2>Login</h2>
        <label>Username</label>
        <input id="login-username" value="admin" autocomplete="off" />
        <label>Password</label>
        <input id="login-password" type="password" autocomplete="off" />
        <button id="login-submit">Sign in</button>
      </section>

      <section id="dashboard" class="hidden">
        <h2>Dashboard</h2>
        <div class="row">
          <button id="refresh-doctor" class="secondary">Doctor</button>
          <button id="refresh-metrics" class="secondary">Metrics</button>
          <button id="refresh-audit" class="secondary">Audit</button>
          <button id="refresh-proposals" class="secondary">Proposals</button>
          <button id="refresh-adapters" class="secondary">Adapters</button>
          <button id="refresh-secrets" class="secondary">Secrets</button>
        </div>

        <section>
          <h3>Mutations</h3>
          <div class="row">
            <div>
              <label>Set Secret Binding</label>
              <input id="secret-binding" placeholder="YOUTUBE_API_KEY" />
              <label>Secret Value</label>
              <input id="secret-value" type="password" />
              <button id="secret-set">Set Secret</button>
            </div>
            <div>
              <label>Delete Secret Binding</label>
              <input id="secret-delete-binding" placeholder="YOUTUBE_API_KEY" />
              <button id="secret-delete" class="secondary">Delete Secret</button>
            </div>
            <div>
              <button id="runtime-rotate">Rotate Runtime Credentials</button>
            </div>
            <div>
              <button id="pairing-generate">Generate Pairing Code</button>
            </div>
          </div>
        </section>

        <pre id="output">{}</pre>
        <button id="logout" class="secondary">Logout</button>
      </section>
    </main>

    <script>
      const state = { csrfToken: "" };
      const statusEl = document.getElementById("status");
      const outputEl = document.getElementById("output");
      const dashboardEl = document.getElementById("dashboard");
      const loginEl = document.getElementById("login-card");
      const bootstrapEl = document.getElementById("bootstrap-card");

      function showStatus(message, isError = false) {
        statusEl.textContent = message;
        statusEl.style.color = isError ? "#9a3a10" : "#1d7f56";
      }

      function showOutput(payload) {
        outputEl.textContent = JSON.stringify(payload, null, 2);
      }

      async function api(path, options = {}) {
        const method = options.method || "GET";
        const headers = { "content-type": "application/json", ...(options.headers || {}) };
        if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && state.csrfToken) {
          headers["x-pincer-csrf"] = state.csrfToken;
        }

        const response = await fetch(path, {
          method,
          headers,
          body: options.body ? JSON.stringify(options.body) : undefined,
        });

        const text = await response.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }

        if (!response.ok) {
          throw new Error(JSON.stringify(parsed));
        }

        return parsed;
      }

      async function refreshSession() {
        try {
          const me = await api("/v1/admin/session/me");
          state.csrfToken = me.csrfToken || "";
          dashboardEl.classList.remove("hidden");
          loginEl.classList.add("hidden");
          bootstrapEl.classList.add("hidden");
          showStatus("Signed in as " + me.username);
          return true;
        } catch {
          dashboardEl.classList.add("hidden");
          if (!bootstrapEl.classList.contains("hidden")) {
            return false;
          }
          loginEl.classList.remove("hidden");
          showStatus("Sign in required", true);
          return false;
        }
      }

      document.getElementById("bootstrap-submit")?.addEventListener("click", async () => {
        try {
          const payload = await api("/v1/admin/bootstrap", {
            method: "POST",
            body: {
              token: document.getElementById("bootstrap-token").value,
              username: document.getElementById("bootstrap-username").value,
              password: document.getElementById("bootstrap-password").value,
            },
          });
          showOutput(payload);
          bootstrapEl.classList.add("hidden");
          loginEl.classList.remove("hidden");
          showStatus("Bootstrap complete. Sign in now.");
        } catch (error) {
          showStatus(String(error), true);
        }
      });

      document.getElementById("login-submit")?.addEventListener("click", async () => {
        try {
          const payload = await api("/v1/admin/session/login", {
            method: "POST",
            body: {
              username: document.getElementById("login-username").value,
              password: document.getElementById("login-password").value,
            },
          });
          state.csrfToken = payload.csrfToken || "";
          showOutput(payload);
          await refreshSession();
        } catch (error) {
          showStatus(String(error), true);
        }
      });

      document.getElementById("logout")?.addEventListener("click", async () => {
        try {
          await api("/v1/admin/session/logout", { method: "POST", body: {} });
          state.csrfToken = "";
          dashboardEl.classList.add("hidden");
          loginEl.classList.remove("hidden");
          showStatus("Logged out.");
        } catch (error) {
          showStatus(String(error), true);
        }
      });

      document.getElementById("refresh-doctor")?.addEventListener("click", async () => showOutput(await api("/v1/admin/doctor")));
      document.getElementById("refresh-metrics")?.addEventListener("click", async () => showOutput(await api("/v1/admin/metrics")));
      document.getElementById("refresh-audit")?.addEventListener("click", async () => showOutput(await api("/v1/admin/audit")));
      document.getElementById("refresh-proposals")?.addEventListener("click", async () => showOutput(await api("/v1/admin/adapters/proposals")));
      document.getElementById("refresh-adapters")?.addEventListener("click", async () => showOutput(await api("/v1/admin/adapters")));
      document.getElementById("refresh-secrets")?.addEventListener("click", async () => showOutput(await api("/v1/admin/secrets")));

      document.getElementById("secret-set")?.addEventListener("click", async () => {
        const binding = document.getElementById("secret-binding").value;
        const value = document.getElementById("secret-value").value;
        showOutput(await api("/v1/admin/secrets/" + encodeURIComponent(binding), { method: "PUT", body: { value } }));
      });

      document.getElementById("secret-delete")?.addEventListener("click", async () => {
        const binding = document.getElementById("secret-delete-binding").value;
        showOutput(await api("/v1/admin/secrets/" + encodeURIComponent(binding), { method: "DELETE", body: {} }));
      });

      document.getElementById("runtime-rotate")?.addEventListener("click", async () => {
        showOutput(await api("/v1/admin/runtime/rotate", { method: "POST", body: {} }));
      });

      document.getElementById("pairing-generate")?.addEventListener("click", async () => {
        showOutput(await api("/v1/admin/pairing/generate", { method: "POST", body: {} }));
      });

      refreshSession();
    </script>
  </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
