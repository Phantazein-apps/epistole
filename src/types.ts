export interface Env {
  // Cloudflare bindings
  DB: D1Database;
  R2: R2Bucket;
  VECTORIZE: VectorizeIndex;
  AI: Ai;

  // Secrets
  IMAP_HOST: string;
  IMAP_PORT: string;
  IMAP_USER: string;
  IMAP_PASS: string;
  SMTP_HOST: string;
  SMTP_PORT: string;
  SMTP_USER: string;
  SMTP_PASS: string;
  EMAIL_ADDRESS: string;
  FULL_NAME: string;
  MCP_TOKEN: string;
}

export interface EmailMeta {
  id: string;
  folder: string;
  uid: number;
  messageId: string | null;
  inReplyTo: string | null;
  subject: string;
  sender: string;
  recipients: string;
  dateIso: string;
  hasAttachments: boolean;
  attachmentFilenames: string[];
  snippet: string;
}

export interface FolderState {
  folder: string;
  lastUid: number;
  uidvalidity: number;
  lastSyncAt: string | null;
  messageCount: number;
}

export interface MessageSummary {
  uid: number;
  date: string | null;
  from: string;
  to: string;
  subject: string;
  flags: string[];
  messageId: string;
}

export interface FullMessage {
  uid: number;
  folder: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  date: string | null;
  from: string;
  to: string;
  cc: string;
  subject: string;
  text: string | null;
  html: string | null;
  attachments: { filename: string; contentType: string; size: number }[];
}
