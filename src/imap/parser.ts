/**
 * Minimal IMAP response parser.
 *
 * Handles the subset of IMAP responses we need:
 * - Tagged OK/NO/BAD responses
 * - FETCH responses (envelope fields, body, flags)
 * - LIST responses
 * - SEARCH responses
 * - SELECT responses (UIDVALIDITY, EXISTS)
 */

export interface FetchResult {
  uid: number;
  flags: string[];
  headers: Record<string, string>;
  bodyText: string;
  bodyHtml: string;
  rawHeaders: string;
  attachments: { filename: string; contentType: string; size: number }[];
}

export interface ListEntry {
  flags: string[];
  delimiter: string;
  path: string;
}

/** Parse a SEARCH response line into an array of UIDs. */
export function parseSearch(line: string): number[] {
  // "* SEARCH 1 2 3 4"
  const match = line.match(/^\* SEARCH(.*)$/i);
  if (!match) return [];
  return match[1]
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .map(Number)
    .filter((n) => !isNaN(n));
}

/** Parse a LIST response line. */
export function parseList(line: string): ListEntry | null {
  // * LIST (\HasNoChildren) "/" "INBOX"
  const match = line.match(
    /^\* (?:LIST|LSUB)\s+\(([^)]*)\)\s+"([^"]*|NIL)"\s+"?([^"]*)"?$/i
  );
  if (!match) return null;
  const flags = match[1]
    .split(/\s+/)
    .filter((f) => f.length > 0)
    .map((f) => f.replace(/^\\/, ""));
  return {
    flags,
    delimiter: match[2] === "NIL" ? "/" : match[2],
    path: match[3],
  };
}

/** Parse EXISTS count from SELECT response. */
export function parseExists(line: string): number | null {
  const match = line.match(/^\*\s+(\d+)\s+EXISTS$/i);
  return match ? parseInt(match[1]) : null;
}

/** Parse UIDVALIDITY from SELECT/STATUS response. */
export function parseUidValidity(line: string): number | null {
  const match = line.match(/UIDVALIDITY\s+(\d+)/i);
  return match ? parseInt(match[1]) : null;
}

/** Parse FLAGS from a FETCH response fragment. */
export function parseFlags(data: string): string[] {
  const match = data.match(/FLAGS\s*\(([^)]*)\)/i);
  if (!match) return [];
  return match[1]
    .split(/\s+/)
    .filter((f) => f.length > 0)
    .map((f) => f.replace(/^\\/, ""));
}

/** Parse UID from a FETCH response fragment. */
export function parseUid(data: string): number {
  const match = data.match(/UID\s+(\d+)/i);
  return match ? parseInt(match[1]) : 0;
}

/** Decode a MIME encoded-word (=?charset?encoding?text?=). */
export function decodeMimeWord(raw: string): string {
  return raw.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_match, _charset, encoding, text) => {
      if (encoding.toUpperCase() === "B") {
        try {
          return atob(text);
        } catch {
          return text;
        }
      }
      // Q encoding
      return text
        .replace(/_/g, " ")
        .replace(/=([0-9A-Fa-f]{2})/g, (_: string, hex: string) =>
          String.fromCharCode(parseInt(hex, 16))
        );
    }
  );
}

/** Extract a header value from raw headers text. */
export function extractHeader(headers: string, name: string): string {
  // Unfold continued lines
  const unfolded = headers.replace(/\r?\n[ \t]+/g, " ");
  const re = new RegExp(`^${name}:\\s*(.*)$`, "im");
  const match = unfolded.match(re);
  return match ? decodeMimeWord(match[1].trim()) : "";
}

/**
 * Parse the text body out of a raw RFC-822 message.
 * Simple approach: find the first text/plain part.
 */
export function extractTextBody(raw: string): string {
  // Split headers from body
  const splitIdx = raw.indexOf("\r\n\r\n");
  if (splitIdx === -1) return "";
  const headers = raw.substring(0, splitIdx);
  const body = raw.substring(splitIdx + 4);

  const ct = extractHeader(headers, "Content-Type").toLowerCase();

  // Simple non-multipart text
  if (!ct || ct.startsWith("text/plain")) {
    return decodeTransferEncoding(body, extractHeader(headers, "Content-Transfer-Encoding"));
  }

  // Multipart — find first text/plain boundary
  const boundaryMatch = ct.match(/boundary="?([^";\s]+)"?/);
  if (!boundaryMatch) return "";
  const boundary = boundaryMatch[1];

  const parts = body.split(`--${boundary}`);
  for (const part of parts) {
    const partSplit = part.indexOf("\r\n\r\n");
    if (partSplit === -1) continue;
    const partHeaders = part.substring(0, partSplit);
    const partBody = part.substring(partSplit + 4);
    const partCt = extractHeader(partHeaders, "Content-Type").toLowerCase();
    if (partCt.startsWith("text/plain") || (!partCt && !partHeaders.match(/Content-Disposition.*attachment/i))) {
      const cte = extractHeader(partHeaders, "Content-Transfer-Encoding");
      return decodeTransferEncoding(partBody.replace(/--\s*$/, "").trim(), cte);
    }
  }
  return "";
}

/** Extract text/html body from a raw message. */
export function extractHtmlBody(raw: string): string {
  const splitIdx = raw.indexOf("\r\n\r\n");
  if (splitIdx === -1) return "";
  const headers = raw.substring(0, splitIdx);
  const body = raw.substring(splitIdx + 4);

  const ct = extractHeader(headers, "Content-Type").toLowerCase();
  if (ct.startsWith("text/html")) {
    return decodeTransferEncoding(body, extractHeader(headers, "Content-Transfer-Encoding"));
  }

  const boundaryMatch = ct.match(/boundary="?([^";\s]+)"?/);
  if (!boundaryMatch) return "";
  const boundary = boundaryMatch[1];

  const parts = body.split(`--${boundary}`);
  for (const part of parts) {
    const partSplit = part.indexOf("\r\n\r\n");
    if (partSplit === -1) continue;
    const partHeaders = part.substring(0, partSplit);
    const partBody = part.substring(partSplit + 4);
    const partCt = extractHeader(partHeaders, "Content-Type").toLowerCase();
    if (partCt.startsWith("text/html")) {
      const cte = extractHeader(partHeaders, "Content-Transfer-Encoding");
      return decodeTransferEncoding(partBody.replace(/--\s*$/, "").trim(), cte);
    }
  }
  return "";
}

/** List attachments from a raw MIME message. */
export function listAttachments(raw: string): { filename: string; contentType: string; size: number }[] {
  const splitIdx = raw.indexOf("\r\n\r\n");
  if (splitIdx === -1) return [];
  const headers = raw.substring(0, splitIdx);
  const body = raw.substring(splitIdx + 4);
  const ct = extractHeader(headers, "Content-Type").toLowerCase();

  const boundaryMatch = ct.match(/boundary="?([^";\s]+)"?/);
  if (!boundaryMatch) return [];
  const boundary = boundaryMatch[1];

  const atts: { filename: string; contentType: string; size: number }[] = [];
  const parts = body.split(`--${boundary}`);
  for (const part of parts) {
    const partSplit = part.indexOf("\r\n\r\n");
    if (partSplit === -1) continue;
    const partHeaders = part.substring(0, partSplit);
    const partBody = part.substring(partSplit + 4);

    const cd = extractHeader(partHeaders, "Content-Disposition");
    if (!cd.toLowerCase().includes("attachment") && !cd.toLowerCase().includes("inline")) continue;

    let filename = "";
    const fnMatch = cd.match(/filename="?([^";\r\n]+)"?/i);
    if (fnMatch) filename = decodeMimeWord(fnMatch[1].trim());
    if (!filename) continue;

    const partCt = extractHeader(partHeaders, "Content-Type");
    atts.push({
      filename,
      contentType: partCt.split(";")[0].trim() || "application/octet-stream",
      size: partBody.trim().length, // approximate (base64 encoded)
    });
  }
  return atts;
}

function decodeTransferEncoding(text: string, encoding: string): string {
  const enc = (encoding || "").toLowerCase().trim();
  if (enc === "base64") {
    try {
      return atob(text.replace(/\s/g, ""));
    } catch {
      return text;
    }
  }
  if (enc === "quoted-printable") {
    return text
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return text;
}
