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

  // ── get_emails ───────────────────────────────────────────────────────
  server.tool(
    "get_emails",
    `Batch-fetch up to 20 messages by UID in one IMAP session. Returns headers + a body snippet (~5KB) for each. Token-efficient alternative to calling get_message 20 times when previewing or triaging a list of UIDs from read_inbox / search_messages / semantic_search. For the full message body or attachments, use get_message.`,
    {
      uids: z.array(z.number()).min(1).max(20).describe("Message UIDs (max 20)"),
      folder: z.string().default("INBOX"),
    },
    async ({ uids, folder }) => {
      const messages = await withImap(imapConfig(env), async (c) => {
        await c.select(folder);
        const out: any[] = [];
        for (const uid of uids) {
          try {
            const raw = await c.uidFetchIndexable(uid, 5_000);
            const parsed = await simpleParser(Buffer.from(raw));
            const text = parsed.text || "";
            out.push({
              uid,
              folder,
              messageId: parsed.messageId || null,
              date: parsed.date?.toISOString() || null,
              from: addrStr(parsed.from),
              to: addrStr(parsed.to),
              cc: addrStr(parsed.cc),
              subject: parsed.subject || "(no subject)",
              snippet: text.slice(0, 500).replace(/\s+/g, " ").trim(),
              attachment_count: (parsed.attachments || []).length,
            });
          } catch (err: any) {
            out.push({ uid, folder, error: err.message || "fetch failed" });
          }
        }
        return out;
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ folder, count: messages.length, messages }) }],
      };
    }
  );

  // ── save_draft ───────────────────────────────────────────────────────
  server.tool(
    "save_draft",
    `Save an email draft to the IMAP Drafts folder via APPEND. Returns the assigned UID if the server supports APPENDUID (RFC 4315). The draft can later be sent with send_draft, edited (save a new revision and delete the old), or discarded by deleting the UID.`,
    {
      to: z.string().describe("Comma-separated recipient addresses"),
      subject: z.string(),
      body: z.string(),
      cc: z.string().optional(),
      bcc: z.string().optional(),
    },
    async ({ to, subject, body, cc, bcc }) => {
      const result = await withImap(imapConfig(env), async (c) => {
        const folders = await c.list();
        const draftsFolder = findSpecialFolder(folders, "Drafts") || "Drafts";
        const { bytes, messageId } = buildRfc822({
          from: `${env.FULL_NAME} <${env.EMAIL_ADDRESS}>`,
          to, subject, body, cc, bcc,
        });
        const appended = await c.append(draftsFolder, ["\\Draft", "\\Seen"], bytes);
        return { folder: draftsFolder, uid: appended?.uid ?? null, messageId };
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, ...result, action: "saved_draft" }),
        }],
      };
    }
  );

  // ── send_draft ───────────────────────────────────────────────────────
  server.tool(
    "send_draft",
    `Send a previously saved draft. Fetches the draft from the Drafts folder, sends it via SMTP, then removes the draft from Drafts. The 'folder' arg defaults to the IMAP-advertised Drafts folder; override only if your provider uses a non-standard name.`,
    {
      uid: z.number().describe("Draft UID (from save_draft)"),
      folder: z.string().optional().describe("Drafts folder name (auto-detected if omitted)"),
    },
    async ({ uid, folder }) => {
      const result = await withImap(imapConfig(env), async (c) => {
        let draftsFolder = folder;
        if (!draftsFolder) {
          const folders = await c.list();
          draftsFolder = findSpecialFolder(folders, "Drafts") || "Drafts";
        }
        await c.select(draftsFolder);
        const raw = await c.uidFetchBody(uid);
        const parsed = await simpleParser(Buffer.from(raw));

        const to = addrStr(parsed.to);
        if (!to) throw new Error(`Draft UID ${uid} has no To: header`);

        const msgId = await sendEmail(smtpConfig(env), {
          from: `${env.FULL_NAME} <${env.EMAIL_ADDRESS}>`,
          to,
          cc: addrStr(parsed.cc) || undefined,
          bcc: addrStr(parsed.bcc) || undefined,
          subject: parsed.subject || "(no subject)",
          body: parsed.text || "",
        });

        // Remove draft from Drafts
        await c.uidStore(uid, "\\Deleted", true);
        await c.expunge();

        return { messageId: msgId, sentTo: to, draftFolder: draftsFolder, draftUid: uid };
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, ...result, action: "sent_draft" }),
        }],
      };
    }
  );

  // ── forward_message ──────────────────────────────────────────────────
  server.tool(
    "forward_message",
    `Forward an existing message to new recipients. Quotes the original headers (From, Date, Subject, To) and body inline below your message. Sets In-Reply-To and References to chain back to the original.`,
    {
      uid: z.number().describe("UID of the message to forward"),
      to: z.string().describe("Comma-separated recipient addresses"),
      body: z.string().default("").describe("Optional message to prepend before the forwarded content"),
      cc: z.string().optional(),
      bcc: z.string().optional(),
      folder: z.string().default("INBOX"),
    },
    async ({ uid, to, body, cc, bcc, folder }) => {
      const original = await withImap(imapConfig(env), async (c) => {
        await c.select(folder);
        const raw = await c.uidFetchBody(uid);
        const parsed = await simpleParser(Buffer.from(raw));
        return {
          from: addrStr(parsed.from),
          to: addrStr(parsed.to),
          subject: parsed.subject || "(no subject)",
          messageId: parsed.messageId || "",
          references: Array.isArray(parsed.references)
            ? parsed.references.join(" ")
            : (parsed.references as string) || "",
          date: parsed.date?.toISOString() || "",
          text: parsed.text || "",
        };
      });

      const fwSubject = /^Fwd?:/i.test(original.subject)
        ? original.subject
        : `Fwd: ${original.subject}`;
      const refs = [original.references, original.messageId]
        .filter(Boolean)
        .join(" ")
        .trim();
      const forwarded = [
        body,
        "",
        "---------- Forwarded message ----------",
        `From: ${original.from}`,
        `Date: ${original.date}`,
        `Subject: ${original.subject}`,
        `To: ${original.to}`,
        "",
        original.text,
      ].join("\n");

      const msgId = await sendEmail(smtpConfig(env), {
        from: `${env.FULL_NAME} <${env.EMAIL_ADDRESS}>`,
        to, cc, bcc,
        subject: fwSubject,
        body: forwarded,
        inReplyTo: original.messageId || undefined,
        references: refs || undefined,
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            messageId: msgId,
            forwarded_uid: uid,
            forwarded_from: original.from,
            accepted: to.split(",").map((a) => a.trim()),
            rejected: [],
          }),
        }],
      };
    }
  );

  // ── bulk_action ──────────────────────────────────────────────────────
  server.tool(
    "bulk_action",
    `Apply mark_read, mark_unread, delete, or move to up to 100 UIDs in a single IMAP session. Faster than calling the per-message tools in a loop because it shares one IMAP connection and collapses the UIDs into a single SEQUENCE-SET per command.`,
    {
      uids: z.array(z.number()).min(1).max(100).describe("Message UIDs (max 100)"),
      action: z.enum(["mark_read", "mark_unread", "delete", "move"]),
      folder: z.string().default("INBOX"),
      destination: z.string().optional().describe("Required when action=move"),
    },
    async ({ uids, action, folder, destination }) => {
      if (action === "move" && !destination) {
        throw new Error("bulk_action: destination is required when action=move");
      }
      const result = await withImap(imapConfig(env), async (c) => {
        await c.select(folder);
        switch (action) {
          case "mark_read":
            await c.uidStore(uids, "\\Seen", true);
            return { folder, action, count: uids.length };
          case "mark_unread":
            await c.uidStore(uids, "\\Seen", false);
            return { folder, action, count: uids.length };
          case "delete":
            await c.uidStore(uids, "\\Deleted", true);
            await c.expunge();
            return { folder, action, count: uids.length };
          case "move":
            await c.uidCopy(uids, destination!);
            await c.uidStore(uids, "\\Deleted", true);
            await c.expunge();
            return { folder, action, count: uids.length, destination };
        }
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, ...result, uids }) }],
      };
    }
  );
}

// ── helpers ────────────────────────────────────────────────────────────

interface ListEntry {
  flags: string[];
  delimiter: string;
  path: string;
  name: string;
  specialUse: string | null;
}

/**
 * Resolve a special-use folder (\Drafts, \Sent, \Trash, etc.) by walking the
 * LIST response. Falls back to a case-insensitive name match, then null.
 */
function findSpecialFolder(folders: ListEntry[], kind: string): string | null {
  const tag = `\\${kind}`;
  const bySpecialUse = folders.find((f) => f.specialUse === tag);
  if (bySpecialUse) return bySpecialUse.path;
  const byName = folders.find((f) => f.name.toLowerCase() === kind.toLowerCase());
  return byName ? byName.path : null;
}

/**
 * Build an RFC 822 message body suitable for IMAP APPEND.  Mirrors the
 * header set used by the SMTP client so drafts and sent messages match.
 */
function buildRfc822(args: {
  from: string;
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
  messageId?: string;
}): { bytes: Uint8Array; messageId: string } {
  const msgId = args.messageId || `<${crypto.randomUUID()}@epistole>`;
  const lines: string[] = [];
  lines.push(`From: ${args.from}`);
  lines.push(`To: ${args.to}`);
  if (args.cc) lines.push(`Cc: ${args.cc}`);
  if (args.bcc) lines.push(`Bcc: ${args.bcc}`);
  lines.push(`Subject: ${args.subject}`);
  lines.push(`Message-ID: ${msgId}`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push(`MIME-Version: 1.0`);
  lines.push(`Content-Type: text/plain; charset=utf-8`);
  lines.push(`Content-Transfer-Encoding: 8bit`);
  if (args.inReplyTo) lines.push(`In-Reply-To: ${args.inReplyTo}`);
  if (args.references) lines.push(`References: ${args.references}`);
  const headers = lines.join("\r\n");
  const body = args.body.replace(/\r?\n/g, "\r\n");
  const full = `${headers}\r\n\r\n${body}`;
  return { bytes: new TextEncoder().encode(full), messageId: msgId };
}
