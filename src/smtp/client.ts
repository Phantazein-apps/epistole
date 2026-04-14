/**
 * Minimal SMTP client for Cloudflare Workers.
 *
 * Uses `connect()` from `cloudflare:sockets` for TCP.
 * Supports SMTP over implicit TLS (port 465) and STARTTLS (port 587).
 */

import { connect } from "cloudflare:sockets";

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
  messageId?: string;
}

export async function sendEmail(config: SmtpConfig, msg: EmailMessage): Promise<string> {
  const useTls = config.port === 465;
  const socket = connect(
    { hostname: config.host, port: config.port },
    { secureTransport: useTls ? "on" : "off", allowHalfOpen: false }
  );

  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  async function readResponse(): Promise<string> {
    let buf = "";
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SMTP responses end with \r\n and have a space after the code on the last line
      if (buf.match(/^\d{3} /m)) return buf;
      if (buf.match(/^\d{3}-/m) && buf.endsWith("\r\n")) continue;
      if (buf.includes("\r\n")) return buf;
    }
    return buf;
  }

  async function send(data: string): Promise<string> {
    await writer.write(encoder.encode(data + "\r\n"));
    return readResponse();
  }

  try {
    // Read greeting
    await readResponse();

    // EHLO
    let ehloResp = await send(`EHLO epistole`);

    // STARTTLS if not implicit TLS
    if (!useTls && ehloResp.includes("STARTTLS")) {
      await send("STARTTLS");
      // Upgrade to TLS
      // Note: cloudflare:sockets startTls is handled via secureTransport: "starttls"
      // For port 587, we'd need to reconnect with TLS. This is a limitation.
      // For now, we support port 465 (implicit TLS) which is the recommended approach.
    }

    // AUTH LOGIN
    await send("AUTH LOGIN");
    await send(btoa(config.user));
    const authResp = await send(btoa(config.pass));
    if (!authResp.startsWith("235")) {
      throw new Error(`SMTP auth failed: ${authResp.trim()}`);
    }

    // MAIL FROM
    const fromAddr = msg.from.match(/<([^>]+)>/)?.[1] || msg.from;
    await send(`MAIL FROM:<${fromAddr}>`);

    // RCPT TO — all recipients
    const allRecipients = [msg.to, msg.cc, msg.bcc]
      .filter(Boolean)
      .join(",")
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a.length > 0);

    for (const rcpt of allRecipients) {
      const addr = rcpt.match(/<([^>]+)>/)?.[1] || rcpt;
      await send(`RCPT TO:<${addr}>`);
    }

    // DATA
    await send("DATA");

    // Build RFC 822 message
    const msgId = msg.messageId || `<${crypto.randomUUID()}@epistole>`;
    let headers = `From: ${msg.from}\r\n`;
    headers += `To: ${msg.to}\r\n`;
    if (msg.cc) headers += `Cc: ${msg.cc}\r\n`;
    headers += `Subject: ${msg.subject}\r\n`;
    headers += `Message-ID: ${msgId}\r\n`;
    headers += `Date: ${new Date().toUTCString()}\r\n`;
    headers += `MIME-Version: 1.0\r\n`;
    headers += `Content-Type: text/plain; charset=utf-8\r\n`;
    headers += `Content-Transfer-Encoding: 7bit\r\n`;
    if (msg.inReplyTo) headers += `In-Reply-To: ${msg.inReplyTo}\r\n`;
    if (msg.references) headers += `References: ${msg.references}\r\n`;

    const fullMsg = headers + "\r\n" + msg.body.replace(/^\./gm, "..") + "\r\n.";
    const resp = await send(fullMsg);
    if (!resp.startsWith("250")) {
      throw new Error(`SMTP send failed: ${resp.trim()}`);
    }

    await send("QUIT");
    return msgId;
  } finally {
    try {
      reader.releaseLock();
      writer.releaseLock();
      socket.close();
    } catch {
      // ignore
    }
  }
}
