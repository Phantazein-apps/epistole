/**
 * Live IMAP/SMTP tools — connect per request, no local state.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ImapClient, withImap, type ImapConfig } from "../imap/client.js";
import {
  extractHeader,
  extractTextBody,
  extractHtmlBody,
  listAttachments,
  decodeMimeWord,
} from "../imap/parser.js";
import { sendEmail, type SmtpConfig, type EmailMessage } from "../smtp/client.js";
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

export function registerLiveTools(server: McpServer, env: Env) {
  // ── list_folders ─────────────────────────────────────────────────────
  server.tool(
    "list_folders",
    "List all available mailbox folders/labels.",
    {},
    async () => {
      const entries = await withImap(imapConfig(env), (c) => c.list());
      const folders = entries.map((e) => ({
        path: e.path,
        name: e.path.split(e.delimiter).pop() || e.path,
        delimiter: e.delimiter,
        flags: e.flags,
        specialUse: e.flags.find((f) =>
          ["Sent", "Drafts", "Junk", "Trash", "Archive", "All"].includes(f)
        )
          ? `\\${e.flags.find((f) => ["Sent", "Drafts", "Junk", "Trash", "Archive", "All"].includes(f))}`
          : null,
      }));
      return { content: [{ type: "text", text: JSON.stringify(folders) }] };
    }
  );

  // ── read_inbox ───────────────────────────────────────────────────────
  server.tool(
    "read_inbox",
    "List recent messages from a mailbox folder. Returns message summaries (uid, date, from, to, subject, flags).",
    {
      folder: z.string().default("INBOX").describe("Mailbox folder to read"),
      limit: z.number().default(20).describe("Maximum messages to return (max 100)"),
    },
    async ({ folder, limit }) => {
      limit = Math.min(Math.max(1, limit), 100);
      const result = await withImap(imapConfig(env), async (c) => {
        const { exists } = await c.select(folder);
        if (exists === 0) return { folder, total: 0, messages: [] };

        const allUids = await c.search("ALL");
        const subset = allUids.slice(-limit);
        const messages = await c.fetchHeaders(subset);
        messages.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

        return {
          folder,
          total: allUids.length,
          messages: messages.slice(0, limit),
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  // ── search_messages ──────────────────────────────────────────────────
  server.tool(
    "search_messages",
    "Search messages using IMAP search criteria. Supports from, to, subject, body, date ranges, and flags.",
    {
      folder: z.string().default("INBOX"),
      from: z.string().optional().describe("Sender address or name"),
      to: z.string().optional().describe("Recipient address or name"),
      subject: z.string().optional().describe("Subject line"),
      body: z.string().optional().describe("Body text"),
      since: z.string().optional().describe("Messages since date (YYYY-MM-DD)"),
      before: z.string().optional().describe("Messages before date (YYYY-MM-DD)"),
      unseen: z.boolean().default(false).describe("Only unread messages"),
      limit: z.number().default(20).describe("Max results"),
    },
    async ({ folder, from, to, subject, body, since, before, unseen, limit }) => {
      limit = Math.min(Math.max(1, limit), 100);
      const parts: string[] = [];
      if (from) parts.push(`FROM "${from}"`);
      if (to) parts.push(`TO "${to}"`);
      if (subject) parts.push(`SUBJECT "${subject}"`);
      if (body) parts.push(`BODY "${body}"`);
      if (since) parts.push(`SINCE ${since}`);
      if (before) parts.push(`BEFORE ${before}`);
      if (unseen) parts.push("UNSEEN");
      if (parts.length === 0) parts.push("ALL");

      const result = await withImap(imapConfig(env), async (c) => {
        await c.select(folder);
        const uids = await c.search(parts.join(" "));
        const subset = uids.slice(-limit);
        const messages = await c.fetchHeaders(subset);
        messages.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

        return {
          folder,
          total: uids.length,
          showing: messages.length,
          messages,
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  // ── get_message ──────────────────────────────────────────────────────
  server.tool(
    "get_message",
    "Get the full content of a specific message by UID, including plain text body, HTML body, and attachment list.",
    {
      uid: z.number().describe("Message UID"),
      folder: z.string().default("INBOX"),
    },
    async ({ uid, folder }) => {
      const result = await withImap(imapConfig(env), async (c) => {
        await c.select(folder);
        const raw = await c.fetchFull(uid);
        const headers = raw.substring(0, raw.indexOf("\r\n\r\n") || 4096);

        return {
          uid,
          folder,
          messageId: extractHeader(headers, "Message-ID") || null,
          inReplyTo: extractHeader(headers, "In-Reply-To") || null,
          references: extractHeader(headers, "References") || null,
          date: extractHeader(headers, "Date") || null,
          from: extractHeader(headers, "From"),
          to: extractHeader(headers, "To"),
          cc: extractHeader(headers, "Cc"),
          subject: extractHeader(headers, "Subject"),
          text: extractTextBody(raw) || null,
          html: extractHtmlBody(raw) || null,
          attachments: listAttachments(raw),
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  // ── send_message ─────────────────────────────────────────────────────
  server.tool(
    "send_message",
    "Compose and send a new email message.",
    {
      to: z.string().describe("Recipient email(s), comma-separated"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Plain text body"),
      cc: z.string().optional(),
      bcc: z.string().optional(),
    },
    async ({ to, subject, body, cc, bcc }) => {
      const msgId = await sendEmail(smtpConfig(env), {
        from: `${env.FULL_NAME} <${env.EMAIL_ADDRESS}>`,
        to,
        subject,
        body,
        cc,
        bcc,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              messageId: msgId,
              accepted: to.split(",").map((a) => a.trim()),
              rejected: [],
            }),
          },
        ],
      };
    }
  );

  // ── reply_to_message ─────────────────────────────────────────────────
  server.tool(
    "reply_to_message",
    "Reply to an existing email. Fetches the original for proper threading headers and quoted text.",
    {
      uid: z.number().describe("UID of message to reply to"),
      body: z.string().describe("Reply text"),
      folder: z.string().default("INBOX"),
      reply_all: z.boolean().default(false),
    },
    async ({ uid, body, folder, reply_all }) => {
      // Fetch original
      const original = await withImap(imapConfig(env), async (c) => {
        await c.select(folder);
        const raw = await c.fetchFull(uid);
        const hdr = raw.substring(0, raw.indexOf("\r\n\r\n") || 4096);
        return {
          from: extractHeader(hdr, "From"),
          to: extractHeader(hdr, "To"),
          cc: extractHeader(hdr, "Cc"),
          subject: extractHeader(hdr, "Subject"),
          messageId: extractHeader(hdr, "Message-ID"),
          references: extractHeader(hdr, "References"),
          date: extractHeader(hdr, "Date"),
          text: extractTextBody(raw),
        };
      });

      const reSubject = original.subject.startsWith("Re:")
        ? original.subject
        : `Re: ${original.subject}`;

      let refs = original.references || "";
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

      const quoted = original.text
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
      const fullBody = `${body}\n\nOn ${original.date}, ${original.from} wrote:\n${quoted}`;

      const msgId = await sendEmail(smtpConfig(env), {
        from: `${env.FULL_NAME} <${env.EMAIL_ADDRESS}>`,
        to: original.from,
        subject: reSubject,
        body: fullBody,
        cc,
        inReplyTo: original.messageId,
        references: refs,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              messageId: msgId,
              accepted: [original.from],
              rejected: [],
            }),
          },
        ],
      };
    }
  );

  // ── mark_read ────────────────────────────────────────────────────────
  server.tool(
    "mark_read",
    "Mark a message as read (add \\Seen flag).",
    {
      uid: z.number().describe("Message UID"),
      folder: z.string().default("INBOX"),
    },
    async ({ uid, folder }) => {
      await withImap(imapConfig(env), async (c) => {
        await c.select(folder);
        await c.store(uid, "\\Seen", true);
      });
      return {
        content: [
          { type: "text", text: JSON.stringify({ success: true, uid, folder, action: "marked_read" }) },
        ],
      };
    }
  );

  // ── mark_unread ──────────────────────────────────────────────────────
  server.tool(
    "mark_unread",
    "Mark a message as unread (remove \\Seen flag).",
    {
      uid: z.number().describe("Message UID"),
      folder: z.string().default("INBOX"),
    },
    async ({ uid, folder }) => {
      await withImap(imapConfig(env), async (c) => {
        await c.select(folder);
        await c.store(uid, "\\Seen", false);
      });
      return {
        content: [
          { type: "text", text: JSON.stringify({ success: true, uid, folder, action: "marked_unread" }) },
        ],
      };
    }
  );

  // ── move_message ─────────────────────────────────────────────────────
  server.tool(
    "move_message",
    "Move a message to a different folder.",
    {
      uid: z.number().describe("Message UID"),
      destination: z.string().describe("Destination folder"),
      folder: z.string().default("INBOX"),
    },
    async ({ uid, destination, folder }) => {
      await withImap(imapConfig(env), async (c) => {
        await c.select(folder);
        await c.copy(uid, destination);
        await c.store(uid, "\\Deleted", true);
        await c.expunge();
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, uid, from: folder, to: destination, action: "moved" }),
          },
        ],
      };
    }
  );
}
