/**
 * Live IMAP/SMTP tools — open a fresh IMAP connection per request.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { simpleParser } from "mailparser";
import { withImap, type ImapConfig } from "../imap/client.js";
import { sendEmail, type SmtpConfig } from "../smtp/client.js";
import type { Env } from "../types.js";

function imapConfig(env: Env): ImapConfig {
  return {
    host: env.IMAP_HOST,
    port: parseInt(env.IMAP_PORT || "993"),
    user: env.IMAP_USER,
    pass: env.IMAP_PASS,
  };
}

function smtpConfig(env: Env): SmtpConfig {
  return {
    host: env.SMTP_HOST,
    port: parseInt(env.SMTP_PORT || "465"),
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
  };
}

function addrStr(addr: any): string {
  if (!addr) return "";
  if (addr.text) return addr.text;
  if (Array.isArray(addr?.value)) {
    return addr.value
      .map((a: any) => (a.name ? `${a.name} <${a.address}>` : a.address))
      .join(", ");
  }
  return String(addr);
}

function buildSearchCriteria(params: {
  from?: string; to?: string; subject?: string; body?: string;
  since?: string; before?: string; unseen?: boolean;
}): string {
  const parts: string[] = [];
  if (params.from) parts.push(`FROM "${params.from.replace(/"/g, '\\"')}"`);
  if (params.to) parts.push(`TO "${params.to.replace(/"/g, '\\"')}"`);
  if (params.subject) parts.push(`SUBJECT "${params.subject.replace(/"/g, '\\"')}"`);
  if (params.body) parts.push(`BODY "${params.body.replace(/"/g, '\\"')}"`);
  if (params.since) parts.push(`SINCE ${formatImapDate(params.since)}`);
  if (params.before) parts.push(`BEFORE ${formatImapDate(params.before)}`);
  if (params.unseen) parts.push("UNSEEN");
  if (parts.length === 0) parts.push("ALL");
  return parts.join(" ");
}

function formatImapDate(yyyymmdd: string): string {
  // IMAP expects "DD-Mon-YYYY" (e.g. 14-Apr-2026)
  const [y, m, d] = yyyymmdd.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d}-${months[parseInt(m) - 1]}-${y}`;
}

export function registerLiveTools(server: McpServer, env: Env) {
  // ── list_folders ─────────────────────────────────────────────────────
  server.tool(
    "list_folders",
    `List all available mailbox folders/labels via live IMAP.

This is commonly the first tool called after a user connects Epistole. If this is their first time connecting (they haven't used Epistole tools before in this conversation), suggest they call sync_now to build the search index — semantic_search won't work until sync has run at least once.`,
    {},
    async () => {
      const folders = await withImap(imapConfig(env), (c) => c.list());
      return { content: [{ type: "text", text: JSON.stringify(folders) }] };
    }
  );

  // ── read_inbox ───────────────────────────────────────────────────────
  server.tool(
    "read_inbox",
    "List recent messages from a mailbox folder.",
    {
      folder: z.string().default("INBOX"),
      limit: z.number().default(20).describe("Max messages (1-100)"),
    },
    async ({ folder, limit }) => {
      limit = Math.min(Math.max(1, limit), 100);
      const result = await withImap(imapConfig(env), async (c) => {
        const { exists } = await c.select(folder);
        if (exists === 0) return { folder, total: 0, messages: [] };

        // Take most recent `limit` UIDs via sequence range trick
        const allUids = await c.uidSearch("ALL");
        const subset = allUids.slice(-limit);
        const messages = await c.uidFetchHeaders(subset);
        messages.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        return { folder, total: allUids.length, messages };
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  // ── search_messages ──────────────────────────────────────────────────
  server.tool(
    "search_messages",
    "Search messages using IMAP search criteria.",
    {
      folder: z.string().default("INBOX"),
      from: z.string().optional(),
      to: z.string().optional(),
      subject: z.string().optional(),
      body: z.string().optional(),
      since: z.string().optional().describe("YYYY-MM-DD"),
      before: z.string().optional().describe("YYYY-MM-DD"),
      unseen: z.boolean().default(false),
      limit: z.number().default(20),
    },
    async ({ folder, from, to, subject, body, since, before, unseen, limit }) => {
      limit = Math.min(Math.max(1, limit), 100);
      const criteria = buildSearchCriteria({ from, to, subject, body, since, before, unseen });
      const result = await withImap(imapConfig(env), async (c) => {
        await c.select(folder);
        const uids = await c.uidSearch(criteria);
        if (uids.length === 0) return { folder, total: 0, showing: 0, messages: [] };
        const subset = uids.slice(-limit);
        const messages = await c.uidFetchHeaders(subset);
        messages.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        return { folder, total: uids.length, showing: messages.length, messages };
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  // ── get_message ──────────────────────────────────────────────────────
  server.tool(
    "get_message",
    "Get the content of a specific message by UID. Returns headers, text body (first 20KB), and attachment metadata. For large messages with attachments, the body is truncated to avoid timeouts.",
    { uid: z.number(), folder: z.string().default("INBOX") },
    async ({ uid, folder }) => {
      const result = await withImap(imapConfig(env), async (c) => {
        await c.select(folder);
        // Use lightweight fetch (headers + 20KB body) to avoid crashing
        // on large messages. Full body available via get_attachments.
        const raw = await c.uidFetchIndexable(uid, 50_000);
        const parsed = await simpleParser(Buffer.from(raw));
        return {
          uid, folder,
          messageId: parsed.messageId || null,
          inReplyTo: parsed.inReplyTo || null,
          references: parsed.references || null,
          date: parsed.date?.toISOString() || null,
          from: addrStr(parsed.from),
          to: addrStr(parsed.to),
          cc: addrStr(parsed.cc),
          subject: parsed.subject || "(no subject)",
          text: parsed.text || null,
          html: typeof parsed.html === "string" ? parsed.html : null,
          attachments: (parsed.attachments || []).map((a: any) => ({
            filename: a.filename, contentType: a.contentType, size: a.size,
          })),
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  // ── send_message ─────────────────────────────────────────────────────
  server.tool(
    "send_message",
    "Compose and send a new email.",
    {
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      cc: z.string().optional(),
      bcc: z.string().optional(),
    },
    async ({ to, subject, body, cc, bcc }) => {
      const msgId = await sendEmail(smtpConfig(env), {
        from: `${env.FULL_NAME} <${env.EMAIL_ADDRESS}>`,
        to, subject, body, cc, bcc,
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true, messageId: msgId,
            accepted: to.split(",").map((a) => a.trim()), rejected: [],
          }),
        }],
      };
    }
  );

  // ── reply_to_message ─────────────────────────────────────────────────
  server.tool(
    "reply_to_message",
    "Reply to an existing message.",
    {
      uid: z.number(),
      body: z.string(),
      folder: z.string().default("INBOX"),
      reply_all: z.boolean().default(false),
    },
    async ({ uid, body, folder, reply_all }) => {
      const original = await withImap(imapConfig(env), async (c) => {
        await c.select(folder);
        const raw = await c.uidFetchBody(uid);
        const parsed = await simpleParser(Buffer.from(raw));
        return {
          from: addrStr(parsed.from),
          to: addrStr(parsed.to),
          cc: addrStr(parsed.cc),
          subject: parsed.subject || "(no subject)",
          messageId: parsed.messageId || "",
          references: Array.isArray(parsed.references)
            ? parsed.references.join(" ")
            : (parsed.references as string) || "",
          date: parsed.date?.toISOString() || "",
          text: parsed.text || "",
        };
      });

      const reSubject = original.subject.startsWith("Re:")
        ? original.subject : `Re: ${original.subject}`;
      let refs = original.references;
      if (original.messageId && !refs.includes(original.messageId)) {
        refs = `${refs} ${original.messageId}`.trim();
      }
      let cc: string | undefined;
      if (reply_all) {
        const extras = [original.to, original.cc].filter(Boolean).join(", ");
        const filtered = extras
          .split(",")
          .map((a) => a.trim())
          .filter((a) => !a.toLowerCase().includes(env.EMAIL_ADDRESS.toLowerCase()));
        cc = filtered.length ? filtered.join(", ") : undefined;
      }
      const quoted = original.text.split("\n").map((l) => `> ${l}`).join("\n");
      const fullBody = `${body}\n\nOn ${original.date}, ${original.from} wrote:\n${quoted}`;

      const msgId = await sendEmail(smtpConfig(env), {
        from: `${env.FULL_NAME} <${env.EMAIL_ADDRESS}>`,
        to: original.from, subject: reSubject, body: fullBody, cc,
        inReplyTo: original.messageId, references: refs,
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true, messageId: msgId,
            accepted: [original.from], rejected: [],
          }),
        }],
      };
    }
  );

  // ── mark_read / mark_unread ─────────────────────────────────────────
  server.tool("mark_read", "Mark a message as read (add \\Seen flag).",
    { uid: z.number(), folder: z.string().default("INBOX") },
    async ({ uid, folder }) => {
      await withImap(imapConfig(env), async (c) => {
        await c.select(folder);
        await c.uidStore(uid, "\\Seen", true);
      });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, uid, folder, action: "marked_read" }) }] };
    }
  );

  server.tool("mark_unread", "Mark a message as unread (remove \\Seen flag).",
    { uid: z.number(), folder: z.string().default("INBOX") },
    async ({ uid, folder }) => {
      await withImap(imapConfig(env), async (c) => {
        await c.select(folder);
        await c.uidStore(uid, "\\Seen", false);
      });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, uid, folder, action: "marked_unread" }) }] };
    }
  );

  // ── move_message ─────────────────────────────────────────────────────
  server.tool("move_message", "Move a message to a different folder.",
    {
      uid: z.number(),
      destination: z.string(),
      folder: z.string().default("INBOX"),
    },
    async ({ uid, destination, folder }) => {
      await withImap(imapConfig(env), async (c) => {
        await c.select(folder);
        await c.uidCopy(uid, destination);
        await c.uidStore(uid, "\\Deleted", true);
        await c.expunge();
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, uid, from: folder, to: destination, action: "moved" }),
        }],
      };
    }
  );
}
