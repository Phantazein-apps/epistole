/**
 * OAuth authorization handler — magic code via email.
 *
 * To authorize access, the user must prove they can read the inbox
 * that Epistole is connected to. No password stored anywhere.
 *
 * Flow:
 *   1. Claude redirects to GET /authorize
 *   2. We show a form asking for the email address
 *   3. User submits → we send a 6-digit code via SMTP to that address
 *   4. User enters the code → POST /authorize/verify
 *   5. If correct, we call completeAuthorization() → redirect back to Claude
 */

import { Hono } from "hono";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { connect } from "cloudflare:sockets";
import type { Env } from "./types.js";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

const app = new Hono<{ Bindings: Bindings }>();

const CODE_TTL = 300; // 5 minutes
const CODE_LENGTH = 6;

// ── Step 1: Show email form ────────────────────────────────────────────

app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!oauthReqInfo.clientId) {
    return c.text("Invalid OAuth request", 400);
  }

  const stateId = crypto.randomUUID();
  await c.env.OAUTH_KV.put(
    `oauth:state:${stateId}`,
    JSON.stringify(oauthReqInfo),
    { expirationTtl: CODE_TTL + 60 }
  );

  return c.html(emailPage(stateId, null));
});

// ── Step 2: Send verification code ─────────────────────────────────────

app.post("/authorize", async (c) => {
  const body = await c.req.parseBody();
  const email = (body.email as string || "").trim().toLowerCase();
  const stateId = body.state as string;

  // Verify the email matches the configured account
  if (email !== c.env.EMAIL_ADDRESS.toLowerCase()) {
    return c.html(emailPage(stateId, "This email doesn't match the account connected to this server."));
  }

  // Check OAuth state is valid
  const stored = await c.env.OAUTH_KV.get(`oauth:state:${stateId}`);
  if (!stored) {
    return c.text("Session expired. Please try again.", 400);
  }

  // Generate a 6-digit code
  const code = generateCode();

  // Store code in KV
  await c.env.OAUTH_KV.put(
    `oauth:code:${stateId}`,
    code,
    { expirationTtl: CODE_TTL }
  );

  // Send the code via SMTP
  try {
    await sendVerificationEmail(c.env, email, code);
  } catch (err: any) {
    return c.html(emailPage(stateId, `Failed to send verification email: ${err.message}`));
  }

  return c.html(codePage(stateId, email, null));
});

// ── Step 3: Verify code ────────────────────────────────────────────────

app.post("/authorize/verify", async (c) => {
  const body = await c.req.parseBody();
  const enteredCode = (body.code as string || "").trim();
  const stateId = body.state as string;
  const email = body.email as string;

  // Retrieve stored OAuth request
  const stored = await c.env.OAUTH_KV.get(`oauth:state:${stateId}`);
  if (!stored) {
    return c.text("Session expired. Please start over.", 400);
  }

  // Retrieve stored code
  const correctCode = await c.env.OAUTH_KV.get(`oauth:code:${stateId}`);
  if (!correctCode) {
    return c.html(codePage(stateId, email, "Code expired. Go back and request a new one."));
  }

  if (enteredCode !== correctCode) {
    return c.html(codePage(stateId, email, "Incorrect code. Check your email and try again."));
  }

  // Code is correct — clean up
  await c.env.OAUTH_KV.delete(`oauth:code:${stateId}`);
  await c.env.OAUTH_KV.delete(`oauth:state:${stateId}`);

  const oauthReqInfo: AuthRequest = JSON.parse(stored);

  // Complete the OAuth flow
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: email,
    metadata: {
      label: c.env.FULL_NAME || email,
    },
    scope: oauthReqInfo.scope,
    props: {
      email,
      name: c.env.FULL_NAME || "",
    },
  });

  return c.redirect(redirectTo);
});

// ── Health check ───────────────────────────────────────────────────────

app.get("/health", (c) => c.text("ok"));

// ── Catch-all ──────────────────────────────────────────────────────────

app.all("*", (c) => c.text("Not Found", 404));

export default app;

// ── Helpers ────────────────────────────────────────────────────────────

function generateCode(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return String(array[0] % 1000000).padStart(CODE_LENGTH, "0");
}

async function sendVerificationEmail(env: Env, to: string, code: string): Promise<void> {
  const port = parseInt(env.SMTP_PORT || "465");
  const useTls = port === 465;

  const socket = connect(
    { hostname: env.SMTP_HOST, port },
    { secureTransport: useTls ? "on" : "off", allowHalfOpen: false }
  );

  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  async function readResp(): Promise<string> {
    let buf = "";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.match(/^\d{3} /m)) return buf;
      if (buf.includes("\r\n")) return buf;
    }
    return buf;
  }

  async function send(data: string): Promise<string> {
    await writer.write(encoder.encode(data + "\r\n"));
    return readResp();
  }

  try {
    await readResp(); // greeting
    await send("EHLO epistole");
    await send("AUTH LOGIN");
    await send(btoa(env.SMTP_USER));
    const authResp = await send(btoa(env.SMTP_PASS));
    if (!authResp.startsWith("235")) {
      throw new Error("SMTP auth failed");
    }

    await send(`MAIL FROM:<${env.EMAIL_ADDRESS}>`);
    await send(`RCPT TO:<${to}>`);
    await send("DATA");

    const msgId = `<${crypto.randomUUID()}@epistole>`;
    const msg = [
      `From: Epistole <${env.EMAIL_ADDRESS}>`,
      `To: ${to}`,
      `Subject: Your Epistole verification code: ${code}`,
      `Message-ID: ${msgId}`,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `Your verification code is: ${code}`,
      ``,
      `Enter this code to authorize Claude to access your email.`,
      `This code expires in 5 minutes.`,
      ``,
      `If you didn't request this, you can ignore this email.`,
    ].join("\r\n");

    const resp = await send(msg + "\r\n.");
    if (!resp.startsWith("250")) {
      throw new Error("SMTP send failed");
    }
    await send("QUIT");
  } finally {
    try {
      reader.releaseLock();
      writer.releaseLock();
      socket.close();
    } catch {}
  }
}

// ── Page templates ─────────────────────────────────────────────────────

const STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0a0a0a; color: #e5e5e5;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
  }
  .card {
    background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px;
    padding: 2.5rem; width: 100%; max-width: 400px;
  }
  .logo { text-align: center; font-size: 2rem; margin-bottom: 0.5rem; }
  h1 { text-align: center; font-size: 1.25rem; font-weight: 600; margin-bottom: 0.25rem; }
  .subtitle { text-align: center; color: #888; font-size: 0.85rem; margin-bottom: 2rem; }
  label { display: block; font-size: 0.85rem; color: #aaa; margin-bottom: 0.5rem; }
  input[type="email"], input[type="text"] {
    width: 100%; padding: 0.75rem; background: #0a0a0a; border: 1px solid #333;
    border-radius: 8px; color: #e5e5e5; font-size: 1rem; outline: none;
  }
  input:focus { border-color: #666; }
  .code-input { font-size: 1.5rem; text-align: center; letter-spacing: 0.5rem; font-family: monospace; }
  button {
    width: 100%; padding: 0.75rem; background: #e5e5e5; color: #0a0a0a;
    border: none; border-radius: 8px; font-size: 1rem; font-weight: 600;
    cursor: pointer; margin-top: 1rem;
  }
  button:hover { background: #fff; }
  .error {
    background: #2d1111; border: 1px solid #5c2020; color: #f87171;
    padding: 0.75rem; border-radius: 8px; font-size: 0.85rem; margin-bottom: 1rem;
  }
  .note { text-align: center; color: #666; font-size: 0.75rem; margin-top: 1.5rem; }
  .sent { text-align: center; color: #4ade80; font-size: 0.85rem; margin-bottom: 1.5rem; }
`;

function emailPage(stateId: string, error: string | null): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Epistole — Verify</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="card">
    <div class="logo">&#9993;</div>
    <h1>Epistole</h1>
    <p class="subtitle">Verify you own this email account</p>
    ${error ? `<div class="error">${error}</div>` : ""}
    <form method="POST" action="/authorize">
      <input type="hidden" name="state" value="${stateId}">
      <label for="email">Email address</label>
      <input type="email" id="email" name="email" placeholder="you@example.com" autofocus required>
      <button type="submit">Send verification code</button>
    </form>
    <p class="note">We'll send a 6-digit code to verify you can read this inbox.</p>
  </div>
</body>
</html>`;
}

function codePage(stateId: string, email: string, error: string | null): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Epistole — Enter Code</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="card">
    <div class="logo">&#9993;</div>
    <h1>Check your email</h1>
    <p class="sent">Code sent to ${email}</p>
    ${error ? `<div class="error">${error}</div>` : ""}
    <form method="POST" action="/authorize/verify">
      <input type="hidden" name="state" value="${stateId}">
      <input type="hidden" name="email" value="${email}">
      <label for="code">Verification code</label>
      <input type="text" id="code" name="code" class="code-input" maxlength="6" pattern="[0-9]{6}" placeholder="000000" autofocus required autocomplete="one-time-code" inputmode="numeric">
      <button type="submit">Verify</button>
    </form>
    <p class="note">Code expires in 5 minutes.</p>
  </div>
</body>
</html>`;
}
