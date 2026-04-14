/**
 * Minimal IMAP client for Cloudflare Workers.
 *
 * Uses the `connect()` TCP socket API from `cloudflare:sockets`.
 * Supports IMAP4rev1 over implicit TLS (port 993).
 *
 * Not a general-purpose IMAP library — only implements the commands
 * needed by Epistole's tools: LOGIN, LIST, SELECT, UID SEARCH,
 * UID FETCH, UID STORE, UID COPY, EXPUNGE, LOGOUT.
 */

import { connect } from "cloudflare:sockets";
import {
  parseSearch,
  parseList,
  parseExists,
  parseUidValidity,
  parseFlags,
  parseUid,
  extractHeader,
  extractTextBody,
  extractHtmlBody,
  listAttachments,
  decodeMimeWord,
  type ListEntry,
} from "./parser.js";

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export class ImapClient {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private socket: Socket | null = null;
  private tagCounter = 0;
  private buffer = "";
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  constructor(private config: ImapConfig) {}

  /** Connect and login. */
  async connect(): Promise<void> {
    this.socket = connect(
      { hostname: this.config.host, port: this.config.port },
      { secureTransport: "on", allowHalfOpen: false }
    );
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();

    // Read greeting
    await this.readUntilTagged("*");

    // Login
    await this.command(`LOGIN "${this.escapeQuoted(this.config.user)}" "${this.escapeQuoted(this.config.pass)}"`);
  }

  /** Logout and close. */
  async disconnect(): Promise<void> {
    try {
      await this.command("LOGOUT");
    } catch {
      // ignore
    }
    try {
      this.reader?.releaseLock();
      this.writer?.releaseLock();
      this.socket?.close();
    } catch {
      // ignore
    }
  }

  /** LIST all folders. */
  async list(): Promise<ListEntry[]> {
    const lines = await this.command('LIST "" "*"');
    const entries: ListEntry[] = [];
    for (const line of lines) {
      const parsed = parseList(line);
      if (parsed) entries.push(parsed);
    }
    return entries;
  }

  /** SELECT a folder.  Returns { exists, uidvalidity }. */
  async select(folder: string): Promise<{ exists: number; uidvalidity: number }> {
    const lines = await this.command(`SELECT "${this.escapeQuoted(folder)}"`);
    let exists = 0;
    let uidvalidity = 0;
    for (const line of lines) {
      const e = parseExists(line);
      if (e !== null) exists = e;
      const uv = parseUidValidity(line);
      if (uv !== null) uidvalidity = uv;
    }
    return { exists, uidvalidity };
  }

  /** UID SEARCH. Returns array of UIDs. */
  async search(criteria: string): Promise<number[]> {
    const lines = await this.command(`UID SEARCH ${criteria}`);
    for (const line of lines) {
      const uids = parseSearch(line);
      if (uids.length > 0) return uids;
    }
    return [];
  }

  /** UID FETCH headers + flags for a set of UIDs. */
  async fetchHeaders(uids: number[]): Promise<
    { uid: number; flags: string[]; date: string; from: string; to: string; subject: string; messageId: string }[]
  > {
    if (uids.length === 0) return [];
    const uidSet = uids.join(",");
    const lines = await this.command(
      `UID FETCH ${uidSet} (UID FLAGS BODY.PEEK[HEADER.FIELDS (DATE FROM TO SUBJECT MESSAGE-ID)])`
    );

    return this.parseFetchHeaderResults(lines);
  }

  /** UID FETCH full message body for a single UID. */
  async fetchFull(uid: number): Promise<string> {
    const lines = await this.command(`UID FETCH ${uid} (BODY.PEEK[])`);
    // The body is between the opening { and the closing )
    return this.extractLiteralBody(lines);
  }

  /** UID STORE — add or remove flags. */
  async store(uid: number, flags: string, add: boolean): Promise<void> {
    const op = add ? "+FLAGS" : "-FLAGS";
    await this.command(`UID STORE ${uid} ${op} (${flags})`);
  }

  /** UID COPY — copy a message to another folder. */
  async copy(uid: number, destination: string): Promise<void> {
    await this.command(`UID COPY ${uid} "${this.escapeQuoted(destination)}"`);
  }

  /** EXPUNGE — permanently remove flagged messages. */
  async expunge(): Promise<void> {
    await this.command("EXPUNGE");
  }

  // ── private helpers ──────────────────────────────────────────────────

  private nextTag(): string {
    return `A${++this.tagCounter}`;
  }

  private escapeQuoted(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  private async send(data: string): Promise<void> {
    if (!this.writer) throw new Error("Not connected");
    await this.writer.write(this.encoder.encode(data + "\r\n"));
  }

  private async command(cmd: string): Promise<string[]> {
    const tag = this.nextTag();
    await this.send(`${tag} ${cmd}`);
    return this.readUntilTagged(tag);
  }

  private async readUntilTagged(tag: string): Promise<string[]> {
    const lines: string[] = [];
    const tagPrefix = tag === "*" ? "* OK" : `${tag} `;
    const timeout = 30_000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      // Try to extract complete lines from buffer
      while (true) {
        // Check for literal {N}
        const literalMatch = this.buffer.match(/\{(\d+)\}\r?\n/);
        if (literalMatch && this.buffer.indexOf(literalMatch[0]) < this.buffer.indexOf("\r\n")) {
          const literalStart = this.buffer.indexOf(literalMatch[0]) + literalMatch[0].length;
          const literalLen = parseInt(literalMatch[1]);
          if (this.buffer.length >= literalStart + literalLen) {
            // We have the full literal
            const beforeLiteral = this.buffer.substring(0, this.buffer.indexOf(literalMatch[0]));
            const literalData = this.buffer.substring(literalStart, literalStart + literalLen);
            this.buffer = this.buffer.substring(literalStart + literalLen);
            lines.push(beforeLiteral + literalData);
            continue;
          }
          // Need more data for the literal
          break;
        }

        const nlIdx = this.buffer.indexOf("\r\n");
        if (nlIdx === -1) break;

        const line = this.buffer.substring(0, nlIdx);
        this.buffer = this.buffer.substring(nlIdx + 2);
        lines.push(line);

        // Check if this is the tagged response
        if (tag === "*" && line.startsWith("* OK")) return lines;
        if (tag !== "*" && line.startsWith(tagPrefix)) {
          if (line.includes("NO") || line.includes("BAD")) {
            throw new Error(`IMAP error: ${line}`);
          }
          return lines;
        }
      }

      // Read more data
      if (!this.reader) throw new Error("Not connected");
      const { value, done } = await this.reader.read();
      if (done) throw new Error("Connection closed");
      this.buffer += this.decoder.decode(value, { stream: true });
    }

    throw new Error(`IMAP timeout waiting for tag ${tag}`);
  }

  private parseFetchHeaderResults(
    lines: string[]
  ): { uid: number; flags: string[]; date: string; from: string; to: string; subject: string; messageId: string }[] {
    const results: { uid: number; flags: string[]; date: string; from: string; to: string; subject: string; messageId: string }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes("FETCH")) continue;

      const uid = parseUid(line);
      const flags = parseFlags(line);
      if (!uid) continue;

      // Headers may be in the same line (after literal) or the next line
      const headerText = lines[i + 1] && !lines[i + 1].includes("FETCH") ? lines[i + 1] : line;

      results.push({
        uid,
        flags,
        date: extractHeader(headerText, "Date"),
        from: extractHeader(headerText, "From"),
        to: extractHeader(headerText, "To"),
        subject: extractHeader(headerText, "Subject"),
        messageId: extractHeader(headerText, "Message-ID"),
      });
    }
    return results;
  }

  private extractLiteralBody(lines: string[]): string {
    // Find the line with the literal size indicator, then the body follows
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("FETCH") && lines[i + 1]) {
        // The body content is typically the next entry
        return lines[i + 1] || "";
      }
    }
    // Fallback: join everything after the first FETCH line
    const fetchIdx = lines.findIndex((l) => l.includes("FETCH"));
    if (fetchIdx >= 0 && fetchIdx + 1 < lines.length) {
      return lines.slice(fetchIdx + 1, -1).join("\r\n");
    }
    return "";
  }
}

/** Convenience: connect, run a function, disconnect. */
export async function withImap<T>(config: ImapConfig, fn: (client: ImapClient) => Promise<T>): Promise<T> {
  const client = new ImapClient(config);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}
