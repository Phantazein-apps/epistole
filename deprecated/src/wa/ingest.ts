/**
 * Persist WhatsApp events pushed from the local bridge into D1 and enqueue
 * for Vectorize embedding.
 *
 * The bridge POSTs batches to /api/wa/push with shape:
 *   { account_id, messages?: [...], chats?: [...], contacts?: [...] }
 *
 * We upsert every row (INSERT OR REPLACE) so the bridge is free to re-send
 * on reconnect without creating duplicates.
 */

import type { Env } from "../types.js";
import { embedWaMessages, makeVectorId, type WaEmbedInput } from "./embed.js";

export interface WaMessagePush {
  id: string;
  chat_jid: string;
  sender?: string | null;
  content?: string | null;
  timestamp?: string | null;         // ISO-8601 preferred
  is_from_me?: boolean | number;
  media_type?: string | null;
  media_info?: unknown | null;       // passed through as JSON (for future use)
  filename?: string | null;
  chat_name?: string | null;         // optional, used only for embedding text
}

export interface WaChatPush {
  jid: string;
  name?: string | null;
  last_message_time?: string | null;
  unread_count?: number | null;
  archived?: boolean | number | null;
  parent_group_jid?: string | null;
  is_parent_group?: boolean | number | null;
}

export interface WaContactPush {
  id: string;
  lid?: string | null;
  phone_jid?: string | null;
  name?: string | null;
  notify?: string | null;
  verified_name?: string | null;
}

export interface WaPushBody {
  account_id: string;
  account_label?: string | null;
  phone?: string | null;
  messages?: WaMessagePush[];
  chats?: WaChatPush[];
  contacts?: WaContactPush[];
}

export interface WaIngestResult {
  messages_written: number;
  chats_written: number;
  contacts_written: number;
  embedded: number;
}

const MAX_EMBED_TEXT = 2000;

export async function ingestWaPush(env: Env, body: WaPushBody): Promise<WaIngestResult> {
  const accountId = body.account_id;
  if (!accountId) throw new Error("account_id required");

  // Upsert account row (touch last_seen_at)
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO wa_accounts (id, label, phone, connected_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       label = COALESCE(excluded.label, wa_accounts.label),
       phone = COALESCE(excluded.phone, wa_accounts.phone),
       last_seen_at = excluded.last_seen_at`
  )
    .bind(accountId, body.account_label ?? null, body.phone ?? null, nowIso, nowIso)
    .run();

  const result: WaIngestResult = {
    messages_written: 0,
    chats_written: 0,
    contacts_written: 0,
    embedded: 0,
  };

  // Chats
  if (body.chats?.length) {
    const stmt = env.DB.prepare(
      `INSERT INTO wa_chats (jid, account_id, name, last_message_time, unread_count, archived, parent_group_jid, is_parent_group)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(jid, account_id) DO UPDATE SET
         name              = COALESCE(excluded.name, wa_chats.name),
         last_message_time = COALESCE(excluded.last_message_time, wa_chats.last_message_time),
         unread_count      = COALESCE(excluded.unread_count, wa_chats.unread_count),
         archived          = COALESCE(excluded.archived, wa_chats.archived),
         parent_group_jid  = COALESCE(excluded.parent_group_jid, wa_chats.parent_group_jid),
         is_parent_group   = COALESCE(excluded.is_parent_group, wa_chats.is_parent_group)`
    );
    const batch = body.chats.map((c) =>
      stmt.bind(
        c.jid,
        accountId,
        c.name ?? null,
        c.last_message_time ?? null,
        toInt(c.unread_count),
        toBool(c.archived),
        c.parent_group_jid ?? null,
        toBool(c.is_parent_group),
      )
    );
    await env.DB.batch(batch);
    result.chats_written = body.chats.length;
  }

  // Contacts
  if (body.contacts?.length) {
    const stmt = env.DB.prepare(
      `INSERT INTO wa_contacts (id, account_id, lid, phone_jid, name, notify, verified_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id, account_id) DO UPDATE SET
         lid           = COALESCE(excluded.lid, wa_contacts.lid),
         phone_jid     = COALESCE(excluded.phone_jid, wa_contacts.phone_jid),
         name          = COALESCE(excluded.name, wa_contacts.name),
         notify        = COALESCE(excluded.notify, wa_contacts.notify),
         verified_name = COALESCE(excluded.verified_name, wa_contacts.verified_name)`
    );
    const batch = body.contacts.map((c) =>
      stmt.bind(
        c.id,
        accountId,
        c.lid ?? null,
        c.phone_jid ?? null,
        c.name ?? null,
        c.notify ?? null,
        c.verified_name ?? null,
      )
    );
    await env.DB.batch(batch);
    result.contacts_written = body.contacts.length;
  }

  // Messages + embedding
  if (body.messages?.length) {
    const embedInputs: WaEmbedInput[] = [];
    const stmt = env.DB.prepare(
      `INSERT INTO wa_messages
         (id, chat_jid, account_id, sender, content, timestamp, is_from_me, media_type, media_info, filename, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id, chat_jid, account_id) DO UPDATE SET
         sender     = COALESCE(excluded.sender, wa_messages.sender),
         content    = COALESCE(excluded.content, wa_messages.content),
         timestamp  = COALESCE(excluded.timestamp, wa_messages.timestamp),
         is_from_me = COALESCE(excluded.is_from_me, wa_messages.is_from_me),
         media_type = COALESCE(excluded.media_type, wa_messages.media_type),
         media_info = COALESCE(excluded.media_info, wa_messages.media_info),
         filename   = COALESCE(excluded.filename, wa_messages.filename)`
    );

    const batch = body.messages.map((m) => {
      const mediaInfoJson = m.media_info == null ? null : JSON.stringify(m.media_info);
      return stmt.bind(
        m.id,
        m.chat_jid,
        accountId,
        m.sender ?? null,
        m.content ?? null,
        m.timestamp ?? null,
        toBool(m.is_from_me),
        m.media_type ?? null,
        mediaInfoJson,
        m.filename ?? null,
        nowIso,
      );
    });
    await env.DB.batch(batch);
    result.messages_written = body.messages.length;

    // Build embedding inputs for messages with indexable content
    for (const m of body.messages) {
      const text = (m.content || "").trim();
      if (!text && !m.media_type) continue; // nothing to embed
      const embedText = [m.chat_name || "", m.sender || "", text]
        .filter(Boolean)
        .join("\n")
        .slice(0, MAX_EMBED_TEXT);
      if (!embedText) continue;

      const ts = m.timestamp ? Math.floor(new Date(m.timestamp).getTime() / 1000) : 0;
      embedInputs.push({
        id: makeVectorId(accountId, m.chat_jid, m.id),
        text: embedText,
        metadata: {
          channel: "whatsapp",
          account_id: accountId,
          chat_jid: m.chat_jid,
          sender: m.sender || "",
          timestamp: ts,
          is_from_me: toBool(m.is_from_me) as 0 | 1,
          ...(m.media_type ? { media_type: m.media_type } : {}),
        },
      });
    }

    if (embedInputs.length > 0) {
      await embedWaMessages(env, embedInputs);
      result.embedded = embedInputs.length;
    }
  }

  return result;
}

function toBool(v: boolean | number | null | undefined): number {
  if (v === true || v === 1) return 1;
  return 0;
}

function toInt(v: number | null | undefined): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return 0;
}
