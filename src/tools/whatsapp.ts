/**
 * WhatsApp MCP tools — READ-ONLY, BETA.
 *
 * These tools let Claude search the WhatsApp history that Hermeneia mirrors
 * to Epistole via /api/wa/push. Hermeneia remains the canonical WhatsApp MCP
 * for sends, media downloads, and anything that requires the live whatsmeow
 * session; this Worker never reaches out to WhatsApp.
 *
 * All tools share an optional `account` parameter. When omitted and only one
 * account has mirrored recently, that one is used.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../types.js";

const tag = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj) }] });

const BETA_SUFFIX = " (beta — requires Hermeneia mirroring to Epistole)";
const STALE_MS = 3 * 60_000;

async function accountIsLive(
  env: Env,
  accountId: string
): Promise<{ live: boolean; last_seen_at: string | null }> {
  const row = await env.DB.prepare(`SELECT last_seen_at FROM wa_accounts WHERE id = ?`)
    .bind(accountId)
    .first<{ last_seen_at: string | null }>();
  if (!row?.last_seen_at) return { live: false, last_seen_at: null };
  const ageMs = Date.now() - new Date(row.last_seen_at).getTime();
  return { live: ageMs <= STALE_MS, last_seen_at: row.last_seen_at };
}

async function resolveAccount(env: Env, requested?: string): Promise<string> {
  if (requested) {
    const row = await env.DB.prepare("SELECT id FROM wa_accounts WHERE id = ?")
      .bind(requested)
      .first<{ id: string }>();
    if (!row) throw new Error(`Unknown WhatsApp account: ${requested}`);
    return requested;
  }
  const rows = await env.DB.prepare(
    `SELECT id FROM wa_accounts
     WHERE last_seen_at IS NOT NULL
     ORDER BY last_seen_at DESC`
  ).all<{ id: string }>();
  const live: string[] = [];
  for (const r of rows.results) {
    const s = await accountIsLive(env, r.id);
    if (s.live) live.push(r.id);
  }
  if (live.length === 1) return live[0];
  if (live.length === 0) {
    throw new Error(
      "No WhatsApp account has mirrored recently. Start Hermeneia's pusher or specify account explicitly."
    );
  }
  throw new Error(
    `Multiple live WhatsApp accounts (${live.join(", ")}). Specify account explicitly.`
  );
}

// ── Tool registrations ─────────────────────────────────────────────────

export function registerWhatsAppTools(server: McpServer, env: Env) {
  // ── wa_accounts_status ──────────────────────────────────────────────
  server.tool(
    "wa_accounts_status",
    "List all WhatsApp accounts that Hermeneia has mirrored, with liveness (whether a heartbeat was received recently)." + BETA_SUFFIX,
    {},
    async () => {
      const rows = await env.DB.prepare(
        `SELECT id, label, phone, connected_at, last_seen_at FROM wa_accounts ORDER BY id`
      ).all<any>();
      const out = [];
      for (const r of rows.results) {
        const s = await accountIsLive(env, r.id);
        out.push({ ...r, live: s.live });
      }
      return tag({ accounts: out });
    }
  );

  // ── wa_list_chats ───────────────────────────────────────────────────
  server.tool(
    "wa_list_chats",
    "List WhatsApp chats from the mirrored history. Filters by name/jid substring, unread, archived state. Sorted by last_message_time (newest first) by default." + BETA_SUFFIX,
    {
      account: z.string().optional(),
      query: z.string().optional(),
      unread_only: z.boolean().default(false),
      include_archived: z.boolean().default(false),
      sort_by: z.enum(["last_active", "name"]).default("last_active"),
      limit: z.number().int().min(1).max(500).default(50),
      page: z.number().int().min(0).default(0),
    },
    async ({ account, query, unread_only, include_archived, sort_by, limit, page }) => {
      const acct = await resolveAccount(env, account);
      const where: string[] = ["account_id = ?"];
      const binds: any[] = [acct];
      if (query) {
        where.push("(name LIKE ? OR jid LIKE ?)");
        const like = `%${query}%`;
        binds.push(like, like);
      }
      if (unread_only) where.push("unread_count > 0");
      if (!include_archived) where.push("(archived IS NULL OR archived = 0)");
      const order = sort_by === "name"
        ? "name COLLATE NOCASE ASC"
        : "COALESCE(last_message_time, '') DESC";
      const sql = `SELECT jid, name, last_message_time, unread_count, archived, parent_group_jid
                   FROM wa_chats
                   WHERE ${where.join(" AND ")}
                   ORDER BY ${order}
                   LIMIT ? OFFSET ?`;
      binds.push(limit, page * limit);
      const rows = await env.DB.prepare(sql).bind(...binds).all<any>();
      return tag({ account: acct, total: rows.results.length, chats: rows.results });
    }
  );

  // ── wa_list_messages ────────────────────────────────────────────────
  server.tool(
    "wa_list_messages",
    "List WhatsApp messages from the mirrored history, optionally scoped to a chat, sender, date range, or content query. Newest first by default." + BETA_SUFFIX,
    {
      account: z.string().optional(),
      chat_jid: z.string().optional(),
      query: z.string().optional(),
      sender_phone_number: z.string().optional().describe("Substring match on sender JID"),
      after: z.string().optional().describe("ISO date — only messages on/after"),
      before: z.string().optional().describe("ISO date — only messages on/before"),
      sort_by: z.enum(["newest", "oldest"]).default("newest"),
      limit: z.number().int().min(1).max(500).default(50),
      page: z.number().int().min(0).default(0),
    },
    async ({ account, chat_jid, query, sender_phone_number, after, before, sort_by, limit, page }) => {
      const acct = await resolveAccount(env, account);
      const where: string[] = ["m.account_id = ?"];
      const binds: any[] = [acct];
      if (chat_jid) { where.push("m.chat_jid = ?"); binds.push(chat_jid); }
      if (query) { where.push("m.content LIKE ?"); binds.push(`%${query}%`); }
      if (sender_phone_number) { where.push("m.sender LIKE ?"); binds.push(`%${sender_phone_number}%`); }
      if (after) { where.push("m.timestamp >= ?"); binds.push(after); }
      if (before) { where.push("m.timestamp <= ?"); binds.push(before); }
      const order = sort_by === "oldest" ? "ASC" : "DESC";
      const sql = `SELECT m.id, m.chat_jid, m.sender, m.content, m.timestamp, m.is_from_me,
                          m.media_type, m.filename,
                          c.name AS chat_name
                   FROM wa_messages m
                   LEFT JOIN wa_chats c ON c.jid = m.chat_jid AND c.account_id = m.account_id
                   WHERE ${where.join(" AND ")}
                   ORDER BY m.timestamp ${order}
                   LIMIT ? OFFSET ?`;
      binds.push(limit, page * limit);
      const rows = await env.DB.prepare(sql).bind(...binds).all<any>();
      return tag({ account: acct, total: rows.results.length, messages: rows.results });
    }
  );

  // ── wa_get_chat ─────────────────────────────────────────────────────
  server.tool(
    "wa_get_chat",
    "Get a WhatsApp chat by JID (from mirrored history), including a handful of most recent messages." + BETA_SUFFIX,
    {
      chat_jid: z.string(),
      account: z.string().optional(),
      message_preview_limit: z.number().int().min(0).max(100).default(10),
    },
    async ({ chat_jid, account, message_preview_limit }) => {
      const acct = await resolveAccount(env, account);
      const chat = await env.DB.prepare(
        `SELECT jid, name, last_message_time, unread_count, archived, parent_group_jid, is_parent_group
         FROM wa_chats WHERE jid = ? AND account_id = ?`
      ).bind(chat_jid, acct).first<any>();
      if (!chat) return tag({ error: "chat not found" });

      const messages = await env.DB.prepare(
        `SELECT id, sender, content, timestamp, is_from_me, media_type, filename
         FROM wa_messages
         WHERE chat_jid = ? AND account_id = ?
         ORDER BY timestamp DESC
         LIMIT ?`
      ).bind(chat_jid, acct, message_preview_limit).all<any>();

      return tag({ account: acct, chat, recent_messages: messages.results });
    }
  );

  // ── wa_get_contact ──────────────────────────────────────────────────
  server.tool(
    "wa_get_contact",
    "Get a WhatsApp contact by jid, phone number, LID, or name from the mirrored history." + BETA_SUFFIX,
    {
      identifier: z.string().describe("jid, phone_jid, lid, id, or name fragment"),
      account: z.string().optional(),
    },
    async ({ identifier, account }) => {
      const acct = await resolveAccount(env, account);
      const like = `%${identifier}%`;
      const row = await env.DB.prepare(
        `SELECT id, lid, phone_jid, name, notify, verified_name
         FROM wa_contacts
         WHERE account_id = ?
           AND (id = ? OR lid = ? OR phone_jid = ?
                OR id LIKE ? OR phone_jid LIKE ? OR name LIKE ? OR notify LIKE ?)
         ORDER BY
           CASE WHEN id = ? OR phone_jid = ? OR lid = ? THEN 0 ELSE 1 END
         LIMIT 1`
      )
        .bind(acct, identifier, identifier, identifier, like, like, like, like, identifier, identifier, identifier)
        .first<any>();
      return tag({ account: acct, contact: row || null });
    }
  );

  // ── wa_search_contacts ──────────────────────────────────────────────
  server.tool(
    "wa_search_contacts",
    "Search WhatsApp contacts by name, phone, or jid in the mirrored history. Returns up to 50 matches." + BETA_SUFFIX,
    {
      query: z.string(),
      account: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    },
    async ({ query, account, limit }) => {
      const acct = await resolveAccount(env, account);
      const like = `%${query}%`;
      const rows = await env.DB.prepare(
        `SELECT id, lid, phone_jid, name, notify, verified_name
         FROM wa_contacts
         WHERE account_id = ?
           AND (name LIKE ? OR notify LIKE ? OR verified_name LIKE ?
                OR id LIKE ? OR phone_jid LIKE ?)
         LIMIT ?`
      )
        .bind(acct, like, like, like, like, like, limit)
        .all<any>();
      return tag({ account: acct, total: rows.results.length, contacts: rows.results });
    }
  );

  // ── wa_get_contact_chats ────────────────────────────────────────────
  server.tool(
    "wa_get_contact_chats",
    "List chats a given contact participates in (direct or groups), from mirrored history." + BETA_SUFFIX,
    {
      jid: z.string().describe("Contact JID"),
      account: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    },
    async ({ jid, account, limit }) => {
      const acct = await resolveAccount(env, account);
      // Direct chat (jid itself) + chats where they've posted a message
      const direct = await env.DB.prepare(
        `SELECT jid, name, last_message_time, unread_count
         FROM wa_chats WHERE jid = ? AND account_id = ?`
      ).bind(jid, acct).first<any>();

      const groups = await env.DB.prepare(
        `SELECT DISTINCT c.jid, c.name, c.last_message_time, c.unread_count
         FROM wa_chats c
         JOIN wa_messages m ON m.chat_jid = c.jid AND m.account_id = c.account_id
         WHERE m.account_id = ? AND m.sender = ? AND c.jid != ?
         ORDER BY c.last_message_time DESC
         LIMIT ?`
      ).bind(acct, jid, jid, limit).all<any>();

      return tag({
        account: acct,
        direct_chat: direct || null,
        group_chats: groups.results,
      });
    }
  );

  // ── wa_get_last_interaction ─────────────────────────────────────────
  server.tool(
    "wa_get_last_interaction",
    "Get the most recent message exchanged with a given contact or group (in either direction), from mirrored history." + BETA_SUFFIX,
    {
      jid: z.string(),
      account: z.string().optional(),
    },
    async ({ jid, account }) => {
      const acct = await resolveAccount(env, account);
      const row = await env.DB.prepare(
        `SELECT id, chat_jid, sender, content, timestamp, is_from_me, media_type
         FROM wa_messages
         WHERE account_id = ? AND (sender = ? OR chat_jid = ?)
         ORDER BY timestamp DESC
         LIMIT 1`
      ).bind(acct, jid, jid).first<any>();
      return tag({ account: acct, message: row || null });
    }
  );

  // ── wa_get_message_context ──────────────────────────────────────────
  server.tool(
    "wa_get_message_context",
    "Fetch a message plus N messages before and after it in the same chat (useful for quoting context), from mirrored history." + BETA_SUFFIX,
    {
      message_id: z.string(),
      before: z.number().int().min(0).max(50).default(5),
      after: z.number().int().min(0).max(50).default(5),
      account: z.string().optional(),
    },
    async ({ message_id, before, after, account }) => {
      const acct = await resolveAccount(env, account);
      const target = await env.DB.prepare(
        `SELECT id, chat_jid, sender, content, timestamp, is_from_me, media_type
         FROM wa_messages
         WHERE account_id = ? AND id = ?
         LIMIT 1`
      ).bind(acct, message_id).first<any>();
      if (!target) return tag({ error: "message not found" });

      const beforeRows = await env.DB.prepare(
        `SELECT id, sender, content, timestamp, is_from_me, media_type
         FROM wa_messages
         WHERE account_id = ? AND chat_jid = ? AND timestamp < ?
         ORDER BY timestamp DESC LIMIT ?`
      ).bind(acct, target.chat_jid, target.timestamp, before).all<any>();

      const afterRows = await env.DB.prepare(
        `SELECT id, sender, content, timestamp, is_from_me, media_type
         FROM wa_messages
         WHERE account_id = ? AND chat_jid = ? AND timestamp > ?
         ORDER BY timestamp ASC LIMIT ?`
      ).bind(acct, target.chat_jid, target.timestamp, after).all<any>();

      return tag({
        account: acct,
        message: target,
        before: beforeRows.results.reverse(),
        after: afterRows.results,
      });
    }
  );

  // Send, media download, and other write/live-session operations live in
  // Hermeneia (the local WhatsApp MCP). This Worker only mirrors read state.
}
