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
import { runIncrementalSync } from "./sync/incremental.js";
import type { Env } from "./types.js";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

const app = new Hono<{ Bindings: Bindings }>();

const CODE_TTL = 300; // 5 minutes
const CODE_LENGTH = 6;
const SESSION_TTL = 600; // 10 minutes for the success page to be useful

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

  const email = c.env.EMAIL_ADDRESS || "";
  return c.html(confirmPage(stateId, email, null));
});

// ── Step 2: Send verification code ─────────────────────────────────────

app.post("/authorize", async (c) => {
  const body = await c.req.parseBody();
  const stateId = body.state as string;
  const email = c.env.EMAIL_ADDRESS.toLowerCase();

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
    return c.html(confirmPage(stateId, email, `Failed to send verification email: ${err.message}`));
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

  // Code is correct — clean up the verification artifacts
  await c.env.OAUTH_KV.delete(`oauth:code:${stateId}`);
  await c.env.OAUTH_KV.delete(`oauth:state:${stateId}`);

  const oauthReqInfo: AuthRequest = JSON.parse(stored);

  // DON'T call completeAuthorization yet — the OAuth code expires in ~60s.
  // We'll generate it when the user clicks "Return to Claude".
  // Store the verified OAuth request so we can complete it later.
  const sessionId = crypto.randomUUID();

  // Kick off a background sync immediately
  const jobId = crypto.randomUUID().substring(0, 8);
  await c.env.DB.prepare(
    "INSERT INTO sync_jobs (job_id, status, started_at, folders, full_sync) VALUES (?, 'running', ?, 'all', 0)"
  )
    .bind(jobId, new Date().toISOString())
    .run();

  // Extend request lifetime via ctx.waitUntil so the sync promise survives
  // beyond the response. Without this, Workers kills the request immediately
  // after returning HTML and the background sync gets aborted.
  c.executionCtx.waitUntil((async () => {
    try {
      const results = await runIncrementalSync(c.env);
      const totalNew = results.reduce((s, r) => s + r.newMessages, 0);
      const errors = results.flatMap((r) => r.errors);
      await c.env.DB.prepare(
        "UPDATE sync_jobs SET status = 'completed', finished_at = ?, error = ? WHERE job_id = ?"
      )
        .bind(
          new Date().toISOString(),
          errors.length > 0 ? errors.join("; ").slice(0, 500) : null,
          jobId
        )
        .run();
      console.log(`Auto-sync ${jobId} complete: ${totalNew} new messages`);
    } catch (err: any) {
      await c.env.DB.prepare(
        "UPDATE sync_jobs SET status = 'failed', finished_at = ?, error = ? WHERE job_id = ?"
      )
        .bind(new Date().toISOString(), err.message?.slice(0, 500) || "unknown", jobId)
        .run();
      console.error(`Auto-sync ${jobId} failed:`, err.message);
    }
  })());

  // Store the verified OAuth request + email so /complete can finish it
  await c.env.OAUTH_KV.put(
    `session:${sessionId}`,
    JSON.stringify({ jobId, oauthReqInfo, email, startedAt: Date.now() }),
    { expirationTtl: SESSION_TTL }
  );

  return c.html(successPage(sessionId));
});

// ── Step 4: Complete OAuth (called when user clicks "Return to Claude") ─

app.get("/authorize/complete", async (c) => {
  const sessionId = c.req.query("session");
  if (!sessionId) return c.text("Missing session", 400);

  const sessionData = await c.env.OAUTH_KV.get(`session:${sessionId}`);
  if (!sessionData) return c.text("Session expired. Please start over.", 400);

  const { oauthReqInfo, email } = JSON.parse(sessionData);

  // Generate a fresh OAuth code and redirect immediately
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

  // Don't delete the session yet — the progress page may still be polling.
  // It expires via TTL.

  return c.redirect(redirectTo);
});

// ── Sync progress endpoint (called by JS on success page) ──────────────

app.get("/sync-progress", async (c) => {
  const sessionId = c.req.query("session");
  if (!sessionId) {
    return c.json({ error: "Missing session" }, 400);
  }

  const sessionData = await c.env.OAUTH_KV.get(`session:${sessionId}`);
  if (!sessionData) {
    return c.json({ error: "Session expired" }, 404);
  }

  const { jobId } = JSON.parse(sessionData);

  const job = await c.env.DB.prepare(
    "SELECT status, started_at, finished_at, error FROM sync_jobs WHERE job_id = ?"
  )
    .bind(jobId)
    .first<{ status: string; started_at: string; finished_at: string | null; error: string | null }>();

  const indexed = await c.env.DB.prepare("SELECT COUNT(*) as cnt FROM emails").first<{ cnt: number }>();

  const folderRows = await c.env.DB.prepare(
    "SELECT folder, message_count, last_sync_at FROM folder_state ORDER BY message_count DESC"
  ).all<{ folder: string; message_count: number; last_sync_at: string | null }>();

  return c.json({
    status: job?.status || "unknown",
    started_at: job?.started_at,
    finished_at: job?.finished_at,
    error: job?.error,
    indexed_total: indexed?.cnt || 0,
    folders: folderRows.results,
  });
});

// ── Health check ───────────────────────────────────────────────────────

app.get("/health", (c) => c.text("ok"));

// ── Debug: test raw TLS socket to IMAP server ─────────────────────────

app.get("/debug/imap", async (c) => {
  const debugKey = c.req.query("key");
  if (debugKey !== "epistole-debug") {
    return c.json({ error: "Unauthorized. Add ?key=epistole-debug" }, 401);
  }

  const { ImapClient } = await import("./imap/client.js");
  const stages: any[] = [];
  const start = Date.now();
  const mark = (stage: string, detail?: any) => {
    stages.push({ stage, t: Date.now() - start, detail });
  };

  const client = new ImapClient({
    host: c.env.IMAP_HOST,
    port: parseInt(c.env.IMAP_PORT || "993"),
    user: c.env.IMAP_USER,
    pass: c.env.IMAP_PASS,
  });

  try {
    mark("connecting");
    await client.connect();
    mark("connected-and-logged-in");

    const folders = await client.list();
    mark("listed", { count: folders.length });

    const { exists, uidvalidity } = await client.select("INBOX");
    mark("selected-inbox", { exists, uidvalidity });

    // Fetch headers for most recent 3 messages
    const allUids = await client.uidSearch("ALL");
    mark("searched", { total: allUids.length });

    const recent = allUids.slice(-3);
    const headers = await client.uidFetchHeaders(recent);
    mark("fetched-headers", {
      count: headers.length,
      subjects: headers.map((h) => h.subject),
    });

    return c.json({
      success: true,
      totalMs: Date.now() - start,
      stages,
      folders: folders.map((f) => f.path),
    });
  } catch (err: any) {
    mark("error", { message: err.message });
    return c.json(
      {
        success: false,
        totalMs: Date.now() - start,
        stages,
        error: err.message,
      },
      500
    );
  } finally {
    await client.disconnect();
  }
});

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

function confirmPage(stateId: string, email: string, error: string | null): string {
  const maskedEmail = email.replace(/^(.)(.*)(@.*)$/, (_, first, middle, domain) =>
    first + middle.replace(/./g, "\u2022") + domain
  );
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
    <p class="subtitle">Claude is requesting access to your email</p>
    <p style="text-align:center; color:#ccc; font-size:0.9rem; margin-bottom:1.5rem;">
      To verify you own this inbox, we'll send a<br>one-time code to <strong>${maskedEmail}</strong>
    </p>
    ${error ? `<div class="error">${error}</div>` : ""}
    <form method="POST" action="/authorize">
      <input type="hidden" name="state" value="${stateId}">
      <button type="submit">Send verification code</button>
    </form>
    <p class="note">The code expires in 5 minutes. No password is stored.</p>
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

function successPage(sessionId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Epistole — Connected</title>
  <style>
    ${STYLES}
    .card { max-width: 460px; }
    .check {
      width: 56px; height: 56px; margin: 0 auto 1rem;
      border-radius: 50%; background: #16a34a;
      display: flex; align-items: center; justify-content: center;
      font-size: 28px; color: white; font-weight: 700;
    }
    .stat-block {
      background: #0a0a0a; border: 1px solid #2a2a2a; border-radius: 8px;
      padding: 1rem; margin: 1.5rem 0;
    }
    .stat-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 0.5rem 0;
    }
    .stat-row + .stat-row { border-top: 1px solid #1a1a1a; }
    .stat-label { color: #888; font-size: 0.85rem; }
    .stat-value { color: #e5e5e5; font-weight: 500; }
    .stat-value.running { color: #fbbf24; }
    .stat-value.complete { color: #4ade80; }
    .stat-value.failed { color: #f87171; }
    .stat-value.indexed { font-size: 1.5rem; color: #4ade80; }
    .pulse {
      display: inline-block; width: 8px; height: 8px; border-radius: 50%;
      background: #fbbf24; margin-right: 0.5rem;
      animation: pulse 1.5s ease-in-out infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    .folder-list {
      max-height: 120px; overflow-y: auto; font-size: 0.8rem;
      color: #888; margin-top: 0.5rem;
    }
    .folder-row {
      display: flex; justify-content: space-between;
      padding: 0.25rem 0;
    }
    button.secondary {
      background: transparent; color: #888; border: 1px solid #333;
      margin-top: 0.5rem;
    }
    button.secondary:hover { background: #1a1a1a; color: #ccc; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">&#10003;</div>
    <h1>You're connected!</h1>
    <p class="subtitle">Epistole is now syncing your email in the background.</p>

    <div class="stat-block">
      <div class="stat-row">
        <span class="stat-label">Sync status</span>
        <span class="stat-value" id="status">
          <span class="pulse"></span>Starting...
        </span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Messages indexed</span>
        <span class="stat-value indexed" id="indexed">0</span>
      </div>
      <div id="folder-block" style="display: none;">
        <div class="stat-row" style="border-bottom: none;">
          <span class="stat-label">Folders</span>
        </div>
        <div class="folder-list" id="folders"></div>
      </div>
    </div>

    <button onclick="returnToClaude()">Return to Claude</button>
    <button class="secondary" onclick="window.close()">Close this tab (sync continues)</button>

    <p class="note">
      The sync continues even after you close this tab — it runs on Cloudflare.
      <br>You can also close Claude Desktop; sync runs every 15 minutes automatically.
    </p>
  </div>

  <script>
    const SESSION_ID = ${JSON.stringify(sessionId)};

    function returnToClaude() {
      // Hit the /authorize/complete endpoint which generates a fresh OAuth
      // code (avoids 60-second expiry while user looks at this page) and
      // redirects back to the OAuth client.
      window.location.href = '/authorize/complete?session=' + encodeURIComponent(SESSION_ID);
    }

    async function pollProgress() {
      try {
        const resp = await fetch('/sync-progress?session=' + encodeURIComponent(SESSION_ID));
        if (!resp.ok) return;
        const data = await resp.json();

        const statusEl = document.getElementById('status');
        const indexedEl = document.getElementById('indexed');
        const folderBlock = document.getElementById('folder-block');
        const foldersEl = document.getElementById('folders');

        indexedEl.textContent = (data.indexed_total || 0).toLocaleString();

        if (data.status === 'running') {
          statusEl.innerHTML = '<span class="pulse"></span>Syncing...';
          statusEl.className = 'stat-value running';
        } else if (data.status === 'completed') {
          statusEl.textContent = '\u2713 Initial sync complete';
          statusEl.className = 'stat-value complete';
        } else if (data.status === 'failed') {
          statusEl.textContent = 'Sync error';
          statusEl.className = 'stat-value failed';
        }

        if (data.folders && data.folders.length > 0) {
          folderBlock.style.display = 'block';
          foldersEl.innerHTML = data.folders.map(f =>
            '<div class="folder-row"><span>' + escapeHtml(f.folder) + '</span><span>' + (f.message_count || 0).toLocaleString() + '</span></div>'
          ).join('');
        }

        // Stop polling once complete or failed
        if (data.status === 'completed' || data.status === 'failed') {
          return;
        }
      } catch (e) {
        // Network error, keep polling
      }
      setTimeout(pollProgress, 2000);
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }

    pollProgress();
  </script>
</body>
</html>`;
}
