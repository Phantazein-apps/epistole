/**
 * Live IMAP/SMTP tools — open a fresh imapflow connection per request.
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
    return addr.value.map((a: any) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
  }
  return String(addr);
}

export function registerLiveTools(server: McpServer, env: Env) {
  // ── list_folders ─────────────────────────────────────────────────────
  server.tool(
    "list_folders",
    "List all available mailbox folders/labels.",
    {},
    async () => {
      const folders = await withImap(imapConfig(env), async (c) => {
        const list = await c.list();
        return list.map((f: any) => ({
          path: f.path,
          name: f.name,
          delimiter: f.delimiter,
          flags: [...(f.flags ?? [])],
          specialUse: f.specialUse || null,
        }));
      });
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
        const lock = await c.getMailboxLock(folder);
        try {
          const status = await c.status(folder, { messages: true });
          const total = (status.messages as number) || 0;
          if (total === 0) return { folder, total: 0, messages: [] };

          const start = Math.max(1, total - limit + 1);
          const range = `${start}:*`;
          const messages: any[] = [];

          for await (const msg of c.fetch(range, { envelope: true, flags: true, uid: true })) {
            messages.push({
              uid: msg.uid,
              date: msg.envelope?.date?.toISOString() ?? null,
              from: addrStr(msg.envelope?.from?.[0]
                ? { value: msg.envelope.from } : null),
              to: addrStr(msg.envelope?.to?.[0]
                ? { value: msg.envelope.to } : null),
              subject: msg.envelope?.subject ?? "(no subject)",
              flags: [...(msg.flags ?? [])],
              messageId: msg.envelope?.messageId ?? null,
            });
          }
          messages.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
          return { folder, total, messages: messages.slice(0, limit) };
        } finally {
          lock.release();
        }
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
      const result = await withImap(imapConfig(env), async (c) => {
        const lock = await c.getMailboxLock(folder);
        try {
          const query: any = {};
          if (from) query.from = from;
          if (to) query.to = to;
          if (subject) query.subject = subject;
          if (body) query.body = body;
          if (since) query.since = new Date(since);
          if (before) query.before = new Date(before);
          if (unseen) query.seen = false;

          const uids = await c.search(query, { uid: true });
          if (!uids || !uids.length) return { folder, total: 0, showing: 0, messages: [] };

          const subset = uids.slice(-limit);
          const messages: any[] = [];
          for await (const msg of c.fetch(subset.join(","),
            { envelope: true, flags: true, uid: true }, { uid: true })) {
            messages.push({
              uid: msg.uid,
              date: msg.envelope?.date?.toISOString() ?? null,
              from: addrStr(msg.envelope?.from?.[0]
                ? { value: msg.envelope.from } : null),
              to: addrStr(msg.envelope?.to?.[0]
                ? { value: msg.envelope.to } : null),
              subject: msg.envelope?.subject ?? "(no subject)",
              flags: [...(msg.flags ?? [])],
              messageId: msg.envelope?.messageId ?? null,
            });
          }
          messages.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
          return { folder, total: uids.length, showing: messages.length, messages };
        } finally {
          lock.release();
        }
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  // ── get_message ──────────────────────────────────────────────────────
  server.tool(
    "get_message",
    "Get the full content of a specific message by UID.",
    {
      uid: z.number(),
      folder: z.string().default("INBOX"),
    },
    async ({ uid, folder }) => {
      const result = await withImap(imapConfig(env), async (c) => {
        const lock = await c.getMailboxLock(folder);
        try {
          const raw = await c.download(String(uid), undefined, { uid: true });
          if (!raw || !raw.content) throw new Error(`Message UID ${uid} not found`);

          const chunks: Buffer[] = [];
          for await (const chunk of raw.content as any) {
            chunks.push(chunk as Buffer);
          }
          const buffer = Buffer.concat(chunks as any);
          const parsed = await simpleParser(buffer);

          return {
            uid,
            folder,
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
              filename: a.filename,
              contentType: a.contentType,
              size: a.size,
            })),
          };
        } finally {
          lock.release();
        }
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  // ── send_message ─────────────────────────────────────────────────────
  server.tool(
    "send_message",
    "Compose and send a new email.",
    {
      to: z.string().describe("Recipient email(s), comma-separated"),
      subject: z.string(),
      body: z.string().describe("Plain text body"),
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
        const lock = await c.getMailboxLock(folder);
        try {
          const raw = await c.download(String(uid), undefined, { uid: true });
          if (!raw?.content) throw new Error(`Message UID ${uid} not found`);
          const chunks: Buffer[] = [];
          for await (const chunk of raw.content as any) chunks.push(chunk as Buffer);
          const parsed = await simpleParser(Buffer.concat(chunks as any));
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
        } finally { lock.release(); }
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
        const filtered = extras.split(",").map((a) => a.trim())
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
        const lock = await c.getMailboxLock(folder);
        try { await c.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }); }
        finally { lock.release(); }
      });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, uid, folder, action: "marked_read" }) }] };
    }
  );

  server.tool("mark_unread", "Mark a message as unread (remove \\Seen flag).",
    { uid: z.number(), folder: z.string().default("INBOX") },
    async ({ uid, folder }) => {
      await withImap(imapConfig(env), async (c) => {
        const lock = await c.getMailboxLock(folder);
        try { await c.messageFlagsRemove(String(uid), ["\\Seen"], { uid: true }); }
        finally { lock.release(); }
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
        const lock = await c.getMailboxLock(folder);
        try { await c.messageMove(String(uid), destination, { uid: true }); }
        finally { lock.release(); }
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
