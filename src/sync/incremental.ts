/**
 * Incremental IMAP sync — runs via cron trigger or sync_now tool.
 *
 * For each folder: fetch new UIDs since last sync, store metadata in D1,
 * attachments in R2, generate embeddings via Workers AI, upsert into Vectorize.
 */

import { withImap, type ImapConfig } from "../imap/client.js";
import {
  extractHeader,
  extractTextBody,
  listAttachments,
  decodeMimeWord,
} from "../imap/parser.js";
import type { Env } from "../types.js";

const BATCH_SIZE = 50;
const EMBED_BATCH = 100;
const MAX_BODY_CHARS = 2000; // Truncate for embedding (bge-base has 512 token limit)

interface SyncResult {
  folder: string;
  newMessages: number;
  lastUid: number;
  errors: string[];
}

export async function runIncrementalSync(
  env: Env,
  options: { folders?: string[]; full?: boolean } = {}
): Promise<SyncResult[]> {
  const cfg: ImapConfig = {
    host: env.IMAP_HOST,
    port: parseInt(env.IMAP_PORT || "993"),
    user: env.IMAP_USER,
    pass: env.IMAP_PASS,
  };

  const results: SyncResult[] = [];

  // Determine folders to sync
  let folders = options.folders;
  if (!folders || folders.length === 0) {
    const entries = await withImap(cfg, (c) => c.list());
    folders = entries.map((e) => e.path);
  }

  for (const folder of folders) {
    try {
      const result = await syncFolder(env, cfg, folder, options.full || false);
      results.push(result);
    } catch (err: any) {
      results.push({
        folder,
        newMessages: 0,
        lastUid: 0,
        errors: [err.message || String(err)],
      });
    }
  }

  return results;
}

async function syncFolder(
  env: Env,
  cfg: ImapConfig,
  folder: string,
  full: boolean
): Promise<SyncResult> {
  const errors: string[] = [];

  // Get stored state
  const stateRow = await env.DB.prepare(
    "SELECT last_uid, uidvalidity FROM folder_state WHERE folder = ?"
  )
    .bind(folder)
    .first<{ last_uid: number; uidvalidity: number }>();

  let lastUid = stateRow?.last_uid || 0;
  const storedValidity = stateRow?.uidvalidity || 0;

  const result = await withImap(cfg, async (client) => {
    const { exists, uidvalidity } = await client.select(folder);

    // UIDVALIDITY changed — drop and re-sync
    if (storedValidity > 0 && uidvalidity !== storedValidity) {
      console.log(`UIDVALIDITY changed for ${folder}: ${storedValidity} → ${uidvalidity}. Re-indexing.`);
      await env.DB.prepare("DELETE FROM emails WHERE folder = ?").bind(folder).run();
      // Vectorize doesn't support bulk delete by metadata, so we track by ID prefix
      lastUid = 0;
    }

    if (full) lastUid = 0;

    // Search for new UIDs
    const criteria = lastUid > 0 ? `UID ${lastUid + 1}:*` : "ALL";
    const uids = await client.search(criteria);
    const newUids = uids.filter((u) => u > lastUid);

    if (newUids.length === 0) {
      // Update state even if no new messages
      await updateFolderState(env, folder, lastUid, uidvalidity, exists);
      return { folder, newMessages: 0, lastUid, errors };
    }

    let maxUid = lastUid;
    const embedBatch: { id: string; text: string; metadata: Record<string, any> }[] = [];

    // Process in batches
    for (let i = 0; i < newUids.length; i += BATCH_SIZE) {
      const batch = newUids.slice(i, i + BATCH_SIZE);

      for (const uid of batch) {
        try {
          const raw = await client.fetchFull(uid);
          if (!raw) continue;

          const hdrEnd = raw.indexOf("\r\n\r\n");
          const hdr = raw.substring(0, hdrEnd > 0 ? hdrEnd : 4096);
          const msgSubject = extractHeader(hdr, "Subject");
          const msgFrom = extractHeader(hdr, "From");
          const msgTo = extractHeader(hdr, "To");
          const msgDate = extractHeader(hdr, "Date");
          const msgId = extractHeader(hdr, "Message-ID");
          const msgReplyTo = extractHeader(hdr, "In-Reply-To");
          const body = extractTextBody(raw);
          const atts = listAttachments(raw);

          const attFilenames = atts.map((a) => a.filename);
          const hasAtts = atts.length > 0;
          const snippet = body.substring(0, 300);
          const emailId = `${folder}:${uid}`;

          // Store metadata in D1
          await env.DB.prepare(
            `INSERT OR REPLACE INTO emails
             (id, folder, uid, message_id, in_reply_to, subject, sender, recipients, date_iso, has_attachments, attachment_filenames, snippet, indexed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              emailId,
              folder,
              uid,
              msgId || null,
              msgReplyTo || null,
              msgSubject,
              msgFrom,
              msgTo,
              msgDate,
              hasAtts ? 1 : 0,
              JSON.stringify(attFilenames),
              snippet,
              new Date().toISOString()
            )
            .run();

          // Store attachments in R2
          if (hasAtts) {
            await storeAttachments(env, raw, folder, uid);
          }

          // Prepare embedding document
          const embedText = [msgSubject, msgFrom, body]
            .filter(Boolean)
            .join("\n")
            .substring(0, MAX_BODY_CHARS);

          embedBatch.push({
            id: emailId,
            text: embedText,
            metadata: {
              folder,
              uid,
              date: msgDate ? new Date(msgDate).getTime() / 1000 : 0,
              sender: msgFrom,
              subject: msgSubject,
              has_attachment: hasAtts ? 1 : 0,
            },
          });

          if (uid > maxUid) maxUid = uid;

          // Flush embedding batch
          if (embedBatch.length >= EMBED_BATCH) {
            await flushEmbeddings(env, embedBatch.splice(0));
          }
        } catch (err: any) {
          errors.push(`${folder}/UID ${uid}: ${err.message}`);
        }
      }
    }

    // Flush remaining embeddings
    if (embedBatch.length > 0) {
      await flushEmbeddings(env, embedBatch);
    }

    await updateFolderState(env, folder, maxUid, uidvalidity, exists);
    return { folder, newMessages: newUids.length, lastUid: maxUid, errors };
  });

  return result;
}

async function storeAttachments(env: Env, raw: string, folder: string, uid: number): Promise<void> {
  const hdrEnd = raw.indexOf("\r\n\r\n");
  const headers = raw.substring(0, hdrEnd > 0 ? hdrEnd : 0);
  const body = raw.substring(hdrEnd + 4);
  const ct = extractHeader(headers, "Content-Type").toLowerCase();

  const boundaryMatch = ct.match(/boundary="?([^";\s]+)"?/);
  if (!boundaryMatch) return;
  const boundary = boundaryMatch[1];
  const parts = body.split(`--${boundary}`);

  for (const part of parts) {
    const pSplit = part.indexOf("\r\n\r\n");
    if (pSplit === -1) continue;
    const pHeaders = part.substring(0, pSplit);
    const pBody = part.substring(pSplit + 4);

    const cd = extractHeader(pHeaders, "Content-Disposition");
    if (!cd.toLowerCase().includes("attachment") && !cd.toLowerCase().includes("inline")) continue;

    const fnMatch = cd.match(/filename="?([^";\r\n]+)"?/i);
    if (!fnMatch) continue;
    const filename = decodeMimeWord(fnMatch[1].trim());

    const cte = extractHeader(pHeaders, "Content-Transfer-Encoding").toLowerCase();
    let content: Uint8Array;
    if (cte === "base64") {
      const b64 = pBody.replace(/\s/g, "").replace(/--\s*$/, "");
      try {
        const binary = atob(b64);
        content = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) content[i] = binary.charCodeAt(i);
      } catch {
        continue;
      }
    } else {
      content = new TextEncoder().encode(pBody);
    }

    const key = `attachments/${folder}/${uid}/${filename}`;
    await env.R2.put(key, content);
  }
}

async function flushEmbeddings(
  env: Env,
  batch: { id: string; text: string; metadata: Record<string, any> }[]
): Promise<void> {
  if (batch.length === 0) return;

  // Generate embeddings via Workers AI
  const texts = batch.map((b) => b.text);
  const response = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: texts,
  });

  const embeddings = (response as any).data as number[][];
  if (!embeddings || embeddings.length !== batch.length) {
    console.error("Embedding count mismatch:", embeddings?.length, "vs", batch.length);
    return;
  }

  // Upsert into Vectorize
  const vectors = batch.map((b, i) => ({
    id: b.id,
    values: embeddings[i],
    metadata: b.metadata,
  }));

  await env.VECTORIZE.upsert(vectors);
}

async function updateFolderState(
  env: Env,
  folder: string,
  lastUid: number,
  uidvalidity: number,
  messageCount: number
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO folder_state (folder, last_uid, uidvalidity, last_sync_at, message_count)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(folder, lastUid, uidvalidity, new Date().toISOString(), messageCount)
    .run();
}
