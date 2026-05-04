/**
 * /api/wa/* — endpoints the local WhatsApp bridge (Hermeneia) mirrors into.
 *
 * Beta / experimental. Hermeneia remains the canonical WhatsApp MCP — this
 * Worker only accepts a read-only mirror of history so semantic_search can
 * span both channels. No command queue, no sends through here.
 *
 * Auth: `Authorization: Bearer <WA_BRIDGE_TOKEN>`. Shared secret between the
 * laptop and the Worker, separate from the user-facing OAuth flow.
 */

import { Hono } from "hono";
import type { Env } from "../types.js";
import { ingestWaPush, type WaPushBody } from "./ingest.js";

type Bindings = Env;

const wa = new Hono<{ Bindings: Bindings }>();

// ── Bearer auth middleware ──────────────────────────────────────────────

wa.use("/*", async (c, next) => {
  const expected = c.env.WA_BRIDGE_TOKEN;
  if (!expected) {
    return c.json({ error: "WhatsApp mirror not configured on this Worker" }, 503);
  }
  const header = c.req.header("authorization") || c.req.header("Authorization");
  const token = header?.replace(/^Bearer\s+/i, "").trim();
  if (!token || !timingSafeEqual(token, expected)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

// ── Push: bridge → Worker message/chat/contact events ──────────────────

wa.post("/push", async (c) => {
  let body: WaPushBody;
  try {
    body = (await c.req.json()) as WaPushBody;
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }
  if (!body || typeof body.account_id !== "string" || !body.account_id) {
    return c.json({ error: "account_id required" }, 400);
  }
  try {
    const result = await ingestWaPush(c.env, body);
    return c.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("wa push failed:", err?.message || err);
    return c.json({ error: err?.message || "ingest failed" }, 500);
  }
});

// ── Heartbeat: keep last_seen_at fresh (liveness signal only) ──────────

wa.post("/heartbeat", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    account_id?: string;
    label?: string | null;
    phone?: string | null;
  };
  if (!body?.account_id) return c.json({ error: "account_id required" }, 400);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO wa_accounts (id, label, phone, connected_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       label        = COALESCE(excluded.label, wa_accounts.label),
       phone        = COALESCE(excluded.phone, wa_accounts.phone),
       last_seen_at = excluded.last_seen_at`
  )
    .bind(body.account_id, body.label ?? null, body.phone ?? null, now, now)
    .run();
  return c.json({ ok: true, now });
});

// ── Helpers ─────────────────────────────────────────────────────────────

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default wa;
