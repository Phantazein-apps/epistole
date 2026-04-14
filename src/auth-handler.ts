/**
 * OAuth authorization handler.
 *
 * Single-user password auth — the user enters the password they set
 * during setup. No external identity provider needed.
 *
 * Flow:
 *   1. Claude.ai redirects to GET /authorize
 *   2. We show a login form
 *   3. User submits password → POST /authorize
 *   4. If correct, we call completeAuthorization() which redirects back to Claude
 */

import { Hono } from "hono";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./types.js";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

const app = new Hono<{ Bindings: Bindings }>();

// ── Login page ─────────────────────────────────────────────────────────

app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!oauthReqInfo.clientId) {
    return c.text("Invalid OAuth request", 400);
  }

  // Store OAuth request info in a short-lived state token
  const stateId = crypto.randomUUID();
  // Store in KV with 10 minute expiry
  await c.env.OAUTH_KV.put(
    `oauth:state:${stateId}`,
    JSON.stringify(oauthReqInfo),
    { expirationTtl: 600 }
  );

  return c.html(loginPage(stateId, null));
});

// ── Login form submission ──────────────────────────────────────────────

app.post("/authorize", async (c) => {
  const body = await c.req.parseBody();
  const password = body.password as string;
  const stateId = body.state as string;

  // Retrieve stored OAuth request
  const stored = await c.env.OAUTH_KV.get(`oauth:state:${stateId}`);
  if (!stored) {
    return c.text("Session expired. Please try again.", 400);
  }

  const oauthReqInfo: AuthRequest = JSON.parse(stored);

  // Validate password
  if (password !== c.env.AUTH_PASSWORD) {
    return c.html(loginPage(stateId, "Incorrect password. Please try again."));
  }

  // Clean up state
  await c.env.OAUTH_KV.delete(`oauth:state:${stateId}`);

  // Complete the OAuth flow
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: c.env.EMAIL_ADDRESS || "owner",
    metadata: {
      label: c.env.FULL_NAME || "Email Account Owner",
    },
    scope: oauthReqInfo.scope,
    props: {
      email: c.env.EMAIL_ADDRESS,
      name: c.env.FULL_NAME,
    },
  });

  return c.redirect(redirectTo);
});

// ── Health check (passes through from main handler) ────────────────────

app.get("/health", (c) => c.text("ok"));

// ── Catch-all ──────────────────────────────────────────────────────────

app.all("*", (c) => c.text("Not Found", 404));

export default app;

// ── Login page HTML ────────────────────────────────────────────────────

function loginPage(stateId: string, error: string | null): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Epistole — Sign In</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 2.5rem;
      width: 100%;
      max-width: 380px;
    }
    .logo {
      text-align: center;
      font-size: 2rem;
      margin-bottom: 0.5rem;
    }
    h1 {
      text-align: center;
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 0.25rem;
    }
    .subtitle {
      text-align: center;
      color: #888;
      font-size: 0.85rem;
      margin-bottom: 2rem;
    }
    label {
      display: block;
      font-size: 0.85rem;
      color: #aaa;
      margin-bottom: 0.5rem;
    }
    input[type="password"] {
      width: 100%;
      padding: 0.75rem;
      background: #0a0a0a;
      border: 1px solid #333;
      border-radius: 8px;
      color: #e5e5e5;
      font-size: 1rem;
      outline: none;
    }
    input[type="password"]:focus {
      border-color: #666;
    }
    button {
      width: 100%;
      padding: 0.75rem;
      background: #e5e5e5;
      color: #0a0a0a;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      margin-top: 1rem;
    }
    button:hover { background: #fff; }
    .error {
      background: #2d1111;
      border: 1px solid #5c2020;
      color: #f87171;
      padding: 0.75rem;
      border-radius: 8px;
      font-size: 0.85rem;
      margin-bottom: 1rem;
    }
    .note {
      text-align: center;
      color: #666;
      font-size: 0.75rem;
      margin-top: 1.5rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">&#9993;</div>
    <h1>Epistole</h1>
    <p class="subtitle">Authorize access to your email MCP server</p>
    ${error ? `<div class="error">${error}</div>` : ""}
    <form method="POST" action="/authorize">
      <input type="hidden" name="state" value="${stateId}">
      <label for="password">Server Password</label>
      <input type="password" id="password" name="password" placeholder="Enter your password" autofocus required>
      <button type="submit">Sign In</button>
    </form>
    <p class="note">This is the password you set during Epistole setup.</p>
  </div>
</body>
</html>`;
}
