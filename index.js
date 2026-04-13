import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

// ── Config from environment ────────────────────────────────────────────────

const config = {
  email: process.env.EMAIL_ADDRESS,
  name: process.env.FULL_NAME,
  imap: {
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT || "993", 10),
    secure: true,
    auth: {
      user: process.env.EMAIL_USERNAME,
      pass: process.env.EMAIL_PASSWORD,
    },
    logger: false,
  },
  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "465", 10),
    secure: true,
    auth: {
      user: process.env.EMAIL_USERNAME,
      pass: process.env.EMAIL_PASSWORD,
    },
  },
};

// ── IMAP helpers ───────────────────────────────────────────────────────────

async function withImap(fn) {
  const client = new ImapFlow(config.imap);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}

function formatAddr(addr) {
  if (!addr) return "";
  if (addr.text) return addr.text;
  if (Array.isArray(addr.value)) {
    return addr.value.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
  }
  return String(addr);
}

function summariseMessage(msg, parsed) {
  return {
    uid: msg.uid,
    seq: msg.seq,
    date: msg.envelope?.date?.toISOString() ?? parsed?.date?.toISOString() ?? null,
    from: formatAddr(msg.envelope?.from?.[0] ? { value: msg.envelope.from } : parsed?.from),
    to: formatAddr(msg.envelope?.to?.[0] ? { value: msg.envelope.to } : parsed?.to),
    subject: msg.envelope?.subject ?? parsed?.subject ?? "(no subject)",
    flags: [...(msg.flags ?? [])],
    messageId: msg.envelope?.messageId ?? parsed?.messageId ?? null,
  };
}

// ── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "read_inbox",
    description:
      "List recent messages from a mailbox folder. Returns message summaries (uid, date, from, to, subject, flags).",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: 'Mailbox folder to read (default: "INBOX")',
          default: "INBOX",
        },
        limit: {
          type: "number",
          description: "Maximum number of messages to return (default: 20, max: 100)",
          default: 20,
        },
      },
    },
  },
  {
    name: "search_messages",
    description:
      "Search messages using IMAP search criteria. Supports searching by from, to, subject, body text, date ranges, and flags.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: 'Folder to search (default: "INBOX")', default: "INBOX" },
        from: { type: "string", description: "Search by sender address or name" },
        to: { type: "string", description: "Search by recipient address or name" },
        subject: { type: "string", description: "Search by subject line" },
        body: { type: "string", description: "Search by body text" },
        since: { type: "string", description: "Messages since date (YYYY-MM-DD)" },
        before: { type: "string", description: "Messages before date (YYYY-MM-DD)" },
        unseen: { type: "boolean", description: "Only unseen/unread messages" },
        limit: { type: "number", description: "Max results (default: 20, max: 100)", default: 20 },
      },
    },
  },
  {
    name: "get_message",
    description:
      "Get the full content of a specific message by UID, including plain text body, HTML body, and attachment list.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: 'Folder containing the message (default: "INBOX")', default: "INBOX" },
        uid: { type: "number", description: "Message UID (from read_inbox or search_messages)" },
      },
      required: ["uid"],
    },
  },
  {
    name: "send_message",
    description: "Compose and send a new email message.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address(es), comma-separated" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Plain text email body" },
        cc: { type: "string", description: "CC recipients, comma-separated" },
        bcc: { type: "string", description: "BCC recipients, comma-separated" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "reply_to_message",
    description:
      "Reply to an existing email message. Fetches the original to set In-Reply-To, References, and quoted text.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: 'Folder of the original message (default: "INBOX")', default: "INBOX" },
        uid: { type: "number", description: "UID of the message to reply to" },
        body: { type: "string", description: "Plain text reply body" },
        reply_all: {
          type: "boolean",
          description: "Reply to all recipients (default: false)",
          default: false,
        },
      },
      required: ["uid", "body"],
    },
  },
  {
    name: "list_folders",
    description: "List all available mailbox folders/labels.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mark_read",
    description: "Mark a message as read (add \\Seen flag).",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: 'Folder (default: "INBOX")', default: "INBOX" },
        uid: { type: "number", description: "Message UID" },
      },
      required: ["uid"],
    },
  },
  {
    name: "mark_unread",
    description: "Mark a message as unread (remove \\Seen flag).",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: 'Folder (default: "INBOX")', default: "INBOX" },
        uid: { type: "number", description: "Message UID" },
      },
      required: ["uid"],
    },
  },
  {
    name: "move_message",
    description: "Move a message to a different folder.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: 'Source folder (default: "INBOX")', default: "INBOX" },
        uid: { type: "number", description: "Message UID" },
        destination: { type: "string", description: "Destination folder path" },
      },
      required: ["uid", "destination"],
    },
  },
];

// ── Tool handlers ──────────────────────────────────────────────────────────

async function handleReadInbox({ folder = "INBOX", limit = 20 }) {
  limit = Math.min(Math.max(1, limit), 100);
  return withImap(async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const status = await client.status(folder, { messages: true });
      const total = status.messages || 0;
      if (total === 0) return { folder, total: 0, messages: [] };

      const start = Math.max(1, total - limit + 1);
      const range = `${start}:*`;
      const messages = [];

      for await (const msg of client.fetch(range, { envelope: true, flags: true, uid: true })) {
        messages.push(summariseMessage(msg, null));
      }

      messages.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      return { folder, total, messages: messages.slice(0, limit) };
    } finally {
      lock.release();
    }
  });
}

async function handleSearchMessages(params) {
  const { folder = "INBOX", from, to, subject, body, since, before, unseen, limit = 20 } = params;
  const effectiveLimit = Math.min(Math.max(1, limit), 100);

  return withImap(async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const query = {};
      if (from) query.from = from;
      if (to) query.to = to;
      if (subject) query.subject = subject;
      if (body) query.body = body;
      if (since) query.since = new Date(since);
      if (before) query.before = new Date(before);
      if (unseen) query.seen = false;

      const uids = await client.search(query, { uid: true });
      if (!uids.length) return { folder, total: 0, messages: [] };

      const subset = uids.slice(-effectiveLimit);
      const uidRange = subset.join(",");
      const messages = [];

      for await (const msg of client.fetch(uidRange, { envelope: true, flags: true, uid: true }, { uid: true })) {
        messages.push(summariseMessage(msg, null));
      }

      messages.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      return { folder, total: uids.length, showing: messages.length, messages };
    } finally {
      lock.release();
    }
  });
}

async function handleGetMessage({ folder = "INBOX", uid }) {
  return withImap(async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const raw = await client.download(String(uid), undefined, { uid: true });
      if (!raw || !raw.content) throw new Error(`Message UID ${uid} not found in ${folder}`);

      const chunks = [];
      for await (const chunk of raw.content) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      const parsed = await simpleParser(buffer);

      const attachments = (parsed.attachments || []).map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
      }));

      return {
        uid,
        folder,
        messageId: parsed.messageId || null,
        inReplyTo: parsed.inReplyTo || null,
        references: parsed.references || null,
        date: parsed.date?.toISOString() || null,
        from: formatAddr(parsed.from),
        to: formatAddr(parsed.to),
        cc: formatAddr(parsed.cc),
        subject: parsed.subject || "(no subject)",
        text: parsed.text || null,
        html: parsed.html || null,
        attachments,
      };
    } finally {
      lock.release();
    }
  });
}

async function handleSendMessage({ to, subject, body, cc, bcc }) {
  const transporter = nodemailer.createTransport(config.smtp);
  const envelope = {
    from: `${config.name} <${config.email}>`,
    to,
    subject,
    text: body,
  };
  if (cc) envelope.cc = cc;
  if (bcc) envelope.bcc = bcc;

  const info = await transporter.sendMail(envelope);
  return { success: true, messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

async function handleReplyToMessage({ folder = "INBOX", uid, body, reply_all = false }) {
  // Fetch original message
  const original = await handleGetMessage({ folder, uid });

  const reSubject = original.subject.startsWith("Re:") ? original.subject : `Re: ${original.subject}`;
  const references = [];
  if (original.references) {
    if (Array.isArray(original.references)) references.push(...original.references);
    else references.push(original.references);
  }
  if (original.messageId) references.push(original.messageId);

  // Determine recipients
  let replyTo = original.from;
  let cc;
  if (reply_all) {
    // Include original To and CC, excluding ourselves
    const allRecipients = [original.to, original.cc].filter(Boolean).join(", ");
    const filtered = allRecipients
      .split(",")
      .map((s) => s.trim())
      .filter((s) => !s.toLowerCase().includes(config.email.toLowerCase()));
    cc = filtered.length ? filtered.join(", ") : undefined;
  }

  // Build quoted text
  const quotedLines = (original.text || "")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  const fullBody = `${body}\n\nOn ${original.date}, ${original.from} wrote:\n${quotedLines}`;

  const transporter = nodemailer.createTransport(config.smtp);
  const mail = {
    from: `${config.name} <${config.email}>`,
    to: replyTo,
    subject: reSubject,
    text: fullBody,
    inReplyTo: original.messageId,
    references: references.join(" "),
  };
  if (cc) mail.cc = cc;

  const info = await transporter.sendMail(mail);
  return { success: true, messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

async function handleListFolders() {
  return withImap(async (client) => {
    const folders = await client.list();
    return folders.map((f) => ({
      path: f.path,
      name: f.name,
      delimiter: f.delimiter,
      flags: [...(f.flags || [])],
      specialUse: f.specialUse || null,
    }));
  });
}

async function handleMarkRead({ folder = "INBOX", uid }) {
  return withImap(async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      return { success: true, uid, folder, action: "marked_read" };
    } finally {
      lock.release();
    }
  });
}

async function handleMarkUnread({ folder = "INBOX", uid }) {
  return withImap(async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageFlagsRemove(String(uid), ["\\Seen"], { uid: true });
      return { success: true, uid, folder, action: "marked_unread" };
    } finally {
      lock.release();
    }
  });
}

async function handleMoveMessage({ folder = "INBOX", uid, destination }) {
  return withImap(async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageMove(String(uid), destination, { uid: true });
      return { success: true, uid, from: folder, to: destination, action: "moved" };
    } finally {
      lock.release();
    }
  });
}

// ── Dispatch ───────────────────────────────────────────────────────────────

const handlers = {
  read_inbox: handleReadInbox,
  search_messages: handleSearchMessages,
  get_message: handleGetMessage,
  send_message: handleSendMessage,
  reply_to_message: handleReplyToMessage,
  list_folders: handleListFolders,
  mark_read: handleMarkRead,
  mark_unread: handleMarkUnread,
  move_message: handleMoveMessage,
};

// ── MCP Server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: "epistole", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = handlers[name];
  if (!handler) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    const result = await handler(args || {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
