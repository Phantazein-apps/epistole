/**
 * Minimal IMAP4rev1 client for Cloudflare Workers.
 *
 * Uses `cloudflare:sockets` `connect()` directly — no Node.js net/tls polyfill.
 * Handles only the commands Epistole needs:
 *   LOGIN, LOGOUT, LIST, SELECT, UID SEARCH, UID FETCH, UID STORE,
 *   UID COPY, EXPUNGE.
 *
 * IMAP responses are read as raw bytes and scanned line-by-line, with
 * proper handling of literal strings ({N}\r\n<N bytes>).
 */

import { connect } from "cloudflare:sockets";

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export interface FetchedHeaders {
  uid: number;
  flags: string[];
  date: string;
  from: string;
  to: string;
  subject: string;
  messageId: string;
  inReplyTo: string;
}

export interface ListEntry {
  flags: string[];
  delimiter: string;
  path: string;
  name: string;
  specialUse: string | null;
}

const CRLF = new Uint8Array([0x0d, 0x0a]);
const TIMEOUT_MS = 25_000;

/** IMAP client. Open one per operation; don't reuse across requests. */
export class ImapClient {
  private socket: Socket | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private buf = new Uint8Array(0);
  private tagCounter = 0;
  private dec = new TextDecoder("latin1");
  private enc = new TextEncoder();

  constructor(private config: ImapConfig) {}

  // ── connection ─────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.socket = connect(
      { hostname: this.config.host, port: this.config.port },
      { secureTransport: "on", allowHalfOpen: false }
    );
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();

    // Read server greeting — must start with "* OK"
    const greeting = await this.readLine();
    const greetText = greeting?.type === "text" ? greeting.text : "";
    if (!greetText.startsWith("* OK")) {
      throw new Error(`IMAP greeting not received (got: ${greetText.slice(0, 100)})`);
    }

    // LOGIN
    const user = this.escape(this.config.user);
    const pass = this.escape(this.config.pass);
    const resp = await this.command(`LOGIN "${user}" "${pass}"`);
    if (!resp.ok) throw new Error(`LOGIN failed: ${resp.status}`);
  }

  async disconnect(): Promise<void> {
    try {
      await this.sendRaw(`A${++this.tagCounter} LOGOUT\r\n`);
    } catch {
      /* ignore */
    }
    try { this.reader?.releaseLock(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { this.socket?.close(); } catch {}
    this.socket = null;
    this.reader = null;
    this.writer = null;
  }

  // ── operations ─────────────────────────────────────────────────────

  async list(): Promise<ListEntry[]> {
    const resp = await this.command('LIST "" "*"');
    if (!resp.ok) throw new Error(`LIST failed: ${resp.status}`);

    const entries: ListEntry[] = [];
    for (const item of resp.items) {
      if (item.type !== "text") continue;
      const line = item.text;
      // * LIST (\HasNoChildren) "/" "INBOX"
      const m = line.match(/^\* LIST\s+\(([^)]*)\)\s+(?:"([^"]*)"|NIL)\s+(?:"(.+)"|([^\s]+))\s*$/);
      if (!m) continue;
      const flagStr = m[1] || "";
      const delimiter = m[2] || "/";
      const path = (m[3] ?? m[4] ?? "").trim();
      const flags = flagStr
        .split(/\s+/)
        .filter((f) => f.length > 0)
        .map((f) => f.replace(/^\\/, ""));
      const specialFlag = flags.find((f) =>
        ["Sent", "Drafts", "Junk", "Trash", "Archive", "All"].includes(f)
      );
      entries.push({
        flags,
        delimiter,
        path,
        name: path.split(delimiter).pop() || path,
        specialUse: specialFlag ? `\\${specialFlag}` : null,
      });
    }
    return entries;
  }

  async select(folder: string): Promise<{ exists: number; uidvalidity: number }> {
    const resp = await this.command(`SELECT "${this.escape(folder)}"`);
    if (!resp.ok) throw new Error(`SELECT ${folder} failed: ${resp.status}`);

    let exists = 0;
    let uidvalidity = 0;
    for (const item of resp.items) {
      if (item.type !== "text") continue;
      const existsM = item.text.match(/^\*\s+(\d+)\s+EXISTS/i);
      if (existsM) exists = parseInt(existsM[1]);
      const uvM = item.text.match(/UIDVALIDITY\s+(\d+)/i);
      if (uvM) uidvalidity = parseInt(uvM[1]);
    }
    return { exists, uidvalidity };
  }

  async uidSearch(criteria: string): Promise<number[]> {
    const resp = await this.command(`UID SEARCH ${criteria}`);
    if (!resp.ok) throw new Error(`UID SEARCH failed: ${resp.status}`);

    for (const item of resp.items) {
      if (item.type !== "text") continue;
      const m = item.text.match(/^\* SEARCH\s*(.*)$/i);
      if (!m) continue;
      return m[1]
        .trim()
        .split(/\s+/)
        .filter((s) => s.length > 0)
        .map((s) => parseInt(s))
        .filter((n) => !isNaN(n));
    }
    return [];
  }

  /** Fetch envelope headers for a list of UIDs. */
  async uidFetchHeaders(uids: number[]): Promise<FetchedHeaders[]> {
    if (uids.length === 0) return [];
    const uidSet = this.compactRange(uids);
    const resp = await this.command(
      `UID FETCH ${uidSet} (UID FLAGS BODY.PEEK[HEADER.FIELDS (DATE FROM TO SUBJECT MESSAGE-ID IN-REPLY-TO)])`
    );
    if (!resp.ok) throw new Error(`UID FETCH failed: ${resp.status}`);

    const results: FetchedHeaders[] = [];
    for (let i = 0; i < resp.items.length; i++) {
      const item = resp.items[i];
      if (item.type !== "text") continue;
      if (!item.text.startsWith("* ") || !item.text.includes("FETCH")) continue;

      // The FETCH envelope (starting from "* N FETCH (") may span multiple items:
      //   text line: "* 1 FETCH (UID 123 FLAGS (\Seen) BODY[HEADER.FIELDS (...)] {456}"
      //   literal: <456 bytes of headers>
      //   text line: " )"
      // Concatenate the non-text items as headers, and look for UID/FLAGS in text.
      const metaText = item.text;
      const uidM = metaText.match(/UID\s+(\d+)/i);
      const flagsM = metaText.match(/FLAGS\s*\(([^)]*)\)/i);
      if (!uidM) continue;
      const uid = parseInt(uidM[1]);
      const flags = (flagsM?.[1] || "")
        .split(/\s+/)
        .filter((f) => f.length > 0)
        .map((f) => f.replace(/^\\/, ""));

      // The next literal item is the header bytes
      let headerBytes: Uint8Array | null = null;
      for (let j = i + 1; j < resp.items.length; j++) {
        const nxt = resp.items[j];
        if (nxt.type === "literal") {
          headerBytes = nxt.data;
          break;
        }
        if (nxt.type === "text" && nxt.text.startsWith("* ")) break;
      }

      const headers = headerBytes ? this.dec.decode(headerBytes) : "";
      results.push({
        uid,
        flags,
        date: extractHeader(headers, "Date"),
        from: decodeMimeWord(extractHeader(headers, "From")),
        to: decodeMimeWord(extractHeader(headers, "To")),
        subject: decodeMimeWord(extractHeader(headers, "Subject")),
        messageId: extractHeader(headers, "Message-ID"),
        inReplyTo: extractHeader(headers, "In-Reply-To"),
      });
    }
    return results;
  }

  /** Fetch full raw RFC 822 body for a single UID.  Use for get_message tool. */
  async uidFetchBody(uid: number): Promise<Uint8Array> {
    const resp = await this.command(`UID FETCH ${uid} (BODY.PEEK[])`);
    if (!resp.ok) throw new Error(`UID FETCH body ${uid} failed: ${resp.status}`);

    for (let i = 0; i < resp.items.length; i++) {
      const item = resp.items[i];
      if (item.type !== "text") continue;
      if (!item.text.includes("FETCH")) continue;

      for (let j = i + 1; j < resp.items.length; j++) {
        const nxt = resp.items[j];
        if (nxt.type === "literal") return nxt.data;
        if (nxt.type === "text" && nxt.text.startsWith("* ")) break;
      }
    }
    throw new Error(`No body data returned for UID ${uid}`);
  }

  /**
   * Fetch just headers + first N bytes of text body for a single UID.
   * Used for indexing: we don't need attachments or huge bodies to
   * generate embeddings, and this keeps per-message CPU low.
   *
   * Returns concatenated header + text body bytes.  Good enough to
   * pass through mailparser for clean text extraction.
   */
  async uidFetchIndexable(uid: number, maxBodyBytes = 20000): Promise<Uint8Array> {
    // HEADER: always small; TEXT<0.N>: first N bytes of body
    const resp = await this.command(
      `UID FETCH ${uid} (BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.${maxBodyBytes}>)`
    );
    if (!resp.ok) throw new Error(`UID FETCH indexable ${uid} failed: ${resp.status}`);

    const literals: Uint8Array[] = [];
    for (const item of resp.items) {
      if (item.type === "literal") literals.push(item.data);
    }
    if (literals.length === 0) throw new Error(`No body data returned for UID ${uid}`);

    // Concatenate header + text body with blank line between (RFC 822)
    const separator = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);
    let total = 0;
    for (const l of literals) total += l.length;
    total += separator.length * Math.max(0, literals.length - 1);

    const out = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < literals.length; i++) {
      out.set(literals[i], offset);
      offset += literals[i].length;
      if (i < literals.length - 1) {
        out.set(separator, offset);
        offset += separator.length;
      }
    }
    return out;
  }

  async uidStore(uid: number, flag: string, add: boolean): Promise<void> {
    const op = add ? "+FLAGS" : "-FLAGS";
    const resp = await this.command(`UID STORE ${uid} ${op} (${flag})`);
    if (!resp.ok) throw new Error(`UID STORE failed: ${resp.status}`);
  }

  async uidCopy(uid: number, destination: string): Promise<void> {
    const resp = await this.command(`UID COPY ${uid} "${this.escape(destination)}"`);
    if (!resp.ok) throw new Error(`UID COPY failed: ${resp.status}`);
  }

  async expunge(): Promise<void> {
    const resp = await this.command("EXPUNGE");
    if (!resp.ok) throw new Error(`EXPUNGE failed: ${resp.status}`);
  }

  // ── command loop ───────────────────────────────────────────────────

  private async command(cmd: string): Promise<ImapResponse> {
    if (!this.writer) throw new Error("Not connected");
    const tag = `A${++this.tagCounter}`;
    await this.sendRaw(`${tag} ${cmd}\r\n`);
    return this.readUntilTagged(tag);
  }

  private async sendRaw(s: string): Promise<void> {
    if (!this.writer) throw new Error("Not connected");
    await this.writer.write(this.enc.encode(s));
  }

  /**
   * Reads response items until we see the tagged response for `tag`.
   * Each item is either a text line or a literal (binary) block.
   */
  private async readUntilTagged(tag: string): Promise<ImapResponse> {
    const items: ResponseItem[] = [];
    const deadline = Date.now() + TIMEOUT_MS;

    while (Date.now() < deadline) {
      const line = await this.readLine(deadline);
      if (!line) throw new Error("IMAP connection closed unexpectedly");

      if (line.type === "text") {
        items.push({ type: "text", text: line.text });

        // Check for tagged response
        if (line.text.startsWith(`${tag} `)) {
          const rest = line.text.substring(tag.length + 1);
          const statusMatch = rest.match(/^(OK|NO|BAD)\b/);
          const ok = statusMatch?.[1] === "OK";
          return { ok, status: rest, items };
        }
      } else {
        items.push(line);
      }
    }
    throw new Error(`IMAP timeout waiting for tag ${tag}`);
  }

  /**
   * Read one "line" — a text line ending in CRLF, plus any literal
   * following a `{N}` marker at the end of the line.  Returns the text
   * portion and any literal data as separate items via callback.
   *
   * Simplified: returns the text line.  If the line ends with `{N}`,
   * additionally reads N bytes and emits a literal item BEFORE returning
   * the continuation of the line.
   */
  private pendingLiteral: Uint8Array | null = null;

  private async readLine(
    deadline = Date.now() + TIMEOUT_MS
  ): Promise<ResponseItem | null> {
    // If we have a pending literal, return it first
    if (this.pendingLiteral) {
      const lit = this.pendingLiteral;
      this.pendingLiteral = null;
      return { type: "literal", data: lit };
    }

    // Find CRLF in buffer, reading more as needed
    while (true) {
      const crlfIdx = findCRLF(this.buf);
      if (crlfIdx >= 0) {
        const lineBytes = this.buf.subarray(0, crlfIdx);
        this.buf = this.buf.subarray(crlfIdx + 2);
        const text = this.dec.decode(lineBytes);

        // Check for literal marker at end of line: {N}
        const litMatch = text.match(/\{(\d+)\}$/);
        if (litMatch) {
          const n = parseInt(litMatch[1]);
          // Read N bytes from buffer (fetching more as needed)
          while (this.buf.length < n) {
            const ok = await this.readMore(deadline);
            if (!ok) throw new Error("Connection closed while reading literal");
          }
          const lit = this.buf.subarray(0, n);
          this.buf = this.buf.subarray(n);
          // Store the literal to return on the NEXT readLine call, and
          // return the text portion now (so parsers see them in order).
          this.pendingLiteral = new Uint8Array(lit);
        }

        return { type: "text", text };
      }

      const ok = await this.readMore(deadline);
      if (!ok) return null;
    }
  }

  /** Read more bytes from the socket into the buffer. Returns false on EOF. */
  private async readMore(deadline: number): Promise<boolean> {
    if (!this.reader) return false;
    if (Date.now() > deadline) throw new Error("IMAP read timeout");

    const timeoutMs = Math.max(1, deadline - Date.now());
    const timeoutPromise = new Promise<{ value: undefined; done: true }>((_, rej) =>
      setTimeout(() => rej(new Error("IMAP read timeout")), timeoutMs)
    );

    const { value, done } = (await Promise.race([
      this.reader.read(),
      timeoutPromise,
    ])) as ReadableStreamReadResult<Uint8Array>;

    if (done || !value) return false;

    // Append
    const merged = new Uint8Array(this.buf.length + value.length);
    merged.set(this.buf, 0);
    merged.set(value, this.buf.length);
    this.buf = merged;
    return true;
  }

  private escape(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  /** Collapse a sorted list of UIDs into comma-separated ranges (e.g. 1:5,10,12:14). */
  private compactRange(uids: number[]): string {
    if (uids.length === 0) return "";
    const sorted = [...uids].sort((a, b) => a - b);
    const parts: string[] = [];
    let start = sorted[0];
    let prev = start;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === prev + 1) {
        prev = sorted[i];
      } else {
        parts.push(start === prev ? `${start}` : `${start}:${prev}`);
        start = prev = sorted[i];
      }
    }
    parts.push(start === prev ? `${start}` : `${start}:${prev}`);
    return parts.join(",");
  }
}

// ── types ──────────────────────────────────────────────────────────────

type ResponseItem =
  | { type: "text"; text: string }
  | { type: "literal"; data: Uint8Array };

interface ImapResponse {
  ok: boolean;
  status: string;
  items: ResponseItem[];
}

// ── helpers ────────────────────────────────────────────────────────────

function findCRLF(buf: Uint8Array): number {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
  }
  return -1;
}

function extractHeader(headers: string, name: string): string {
  // Unfold continued lines (RFC 822: continuation starts with whitespace)
  const unfolded = headers.replace(/\r?\n[ \t]+/g, " ");
  const re = new RegExp(`^${name}:\\s*(.*)$`, "im");
  const m = unfolded.match(re);
  return m ? m[1].trim() : "";
}

function decodeMimeWord(raw: string): string {
  if (!raw) return "";
  return raw.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_m, _charset, encoding, text) => {
      if (encoding.toUpperCase() === "B") {
        try {
          return atob(text);
        } catch {
          return text;
        }
      }
      return text
        .replace(/_/g, " ")
        .replace(/=([0-9A-Fa-f]{2})/g, (_: string, hex: string) =>
          String.fromCharCode(parseInt(hex, 16))
        );
    }
  );
}

// ── convenience wrapper ───────────────────────────────────────────────

export async function withImap<T>(
  config: ImapConfig,
  fn: (client: ImapClient) => Promise<T>
): Promise<T> {
  const client = new ImapClient(config);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}
