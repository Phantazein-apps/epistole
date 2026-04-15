/**
 * Incremental IMAP sync — opens a short-lived IMAP connection per folder,
 * pulls up to MAX_MESSAGES_PER_SYNC new messages, indexes into D1 +
 * Vectorize, and stores attachments in R2.
 *
 * Subsequent cron runs pick up any remaining messages.
 */

import { simpleParser } from "mailparser";
import { withImap, ImapClient, type ImapConfig } from "../imap/client.js";
import type { Env } from "../types.js";

const EMBED_BATCH = 20;
const MAX_BODY_CHARS = 2000;
// Total cap across ALL folders per invocation. Subsequent cron runs
// (every 15 min) catch up. Set conservatively to fit Worker 30s CPU.
const MAX_MESSAGES_PER_INVOCATION = 40;
// Prioritize these folders — INBOX first so user sees their main mail ASAP.
const FOLDER_PRIORITY = ["INBOX", "Sent", "Archive"];

interface SyncResult {
  folder: string;
  newMessages: number;
  lastUid: number;
  errors: string[];
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

  // If folders not specified, list them with a fresh connection
  let folders = options.folders;
  if (!folders || folders.length === 0) {
    folders = await withImap(cfg, async (c) => {
      const list = await c.list();
      return list.map((f) => f.path);
    });
  }

  // Sort folders: priority folders first, then alphabetically
  folders = folders.slice().sort((a, b) => {
    const aPri = FOLDER_PRIORITY.indexOf(a);
    const bPri = FOLDER_PRIORITY.indexOf(b);
    if (aPri !== -1 && bPri !== -1) return aPri - bPri;
    if (aPri !== -1) return -1;
    if (bPri !== -1) return 1;
    return a.localeCompare(b);
  });

  // Track remaining budget across folders so we don't blow the CPU limit
  let budget = MAX_MESSAGES_PER_INVOCATION;

  for (const folder of folders) {
    if (budget <= 0) {
      // Not enough budget for another folder this invocation;
      // cron will pick up the rest next time
      results.push({
        folder,
        newMessages: 0,
        lastUid: 0,
        errors: ["deferred: budget exhausted, will resume next cron run"],
      });
      continue;
    }

    try {
      const result = await withImap(cfg, (client) =>
        syncFolder(env, client, folder, options.full || false, budget)
      );
      budget -= result.newMessages;
      results.push(result);
    } catch (err: any) {
      console.error(`Sync failed for ${folder}:`, err.message);
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
  client: ImapClient,
  folder: string,
  full: boolean,
  budget: number
): Promise<SyncResult> {
  const errors: string[] = [];

  const stateRow = await env.DB.prepare(
    "SELECT last_uid, uidvalidity FROM folder_state WHERE folder = ?"
  )
    .bind(folder)
    .first<{ last_uid: number; uidvalidity: number }>();

  let lastUid = stateRow?.last_uid || 0;
  const storedValidity = stateRow?.uidvalidity || 0;

  const { exists, uidvalidity } = await client.select(folder);

  if (storedValidity > 0 && uidvalidity !== storedValidity) {
    console.log(`UIDVALIDITY changed for ${folder}: ${storedValidity} → ${uidvalidity}. Re-indexing.`);
    await env.DB.prepare("DELETE FROM emails WHERE folder = ?").bind(folder).run();
    lastUid = 0;
  }

  // Get all UIDs currently in the folder via IMAP
  const allUids = await client.uidSearch("ALL");

  // Get UIDs we've already indexed for this folder from D1
  let indexedSet = new Set<number>();
  if (!full) {
    const rows = await env.DB.prepare(
      "SELECT uid FROM emails WHERE folder = ?"
    )
      .bind(folder)
      .all<{ uid: number }>();
    indexedSet = new Set(rows.results.map((r) => r.uid));
  } else {
    // Full resync — wipe existing data for this folder
    await env.DB.prepare("DELETE FROM emails WHERE folder = ?").bind(folder).run();
  }

  // Compute unindexed UIDs, newest first
  let newUids = allUids.filter((u) => !indexedSet.has(u)).sort((a, b) => b - a);

  if (newUids.length === 0) {
    await updateFolderState(env, folder, Math.max(lastUid, ...allUids, 0), uidvalidity, exists);
    return { folder, newMessages: 0, lastUid, errors };
  }

  const totalPending = newUids.length;
  const cap = Math.min(budget, totalPending);
  if (newUids.length > cap) {
    newUids = newUids.slice(0, cap);
    console.log(`${folder}: processing ${cap} of ${totalPending} pending messages`);
  }

  let maxUid = lastUid;
  const embedBatch: { id: string; text: string; metadata: Record<string, any> }[] = [];

  for (const uid of newUids) {
    try {
      const raw = await client.uidFetchBody(uid);
      const parsed = await simpleParser(Buffer.from(raw));

      const subj = parsed.subject || "";
      const from = addrStr(parsed.from);
      const to = addrStr(parsed.to);
      const body = parsed.text || "";
      const msgId = parsed.messageId || "";
      const replyTo = parsed.inReplyTo || "";
      const date = parsed.date?.toISOString() || "";

      const atts = parsed.attachments || [];
      const attFilenames = atts
        .filter((a: any) => a.filename)
        .map((a: any) => a.filename as string);
      const hasAtts = attFilenames.length > 0;
      const snippet = body.substring(0, 300);
      const emailId = `${folder}:${uid}`;

      await env.DB.prepare(
        `INSERT OR REPLACE INTO emails
         (id, folder, uid, message_id, in_reply_to, subject, sender, recipients, date_iso, has_attachments, attachment_filenames, snippet, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          emailId, folder, uid, msgId || null, replyTo || null,
          subj, from, to, date,
          hasAtts ? 1 : 0, JSON.stringify(attFilenames),
          snippet, new Date().toISOString()
        )
        .run();

      // Save attachments to R2
      if (hasAtts) {
        for (const att of atts) {
          if (!att.filename || !att.content) continue;
          const key = `attachments/${folder}/${uid}/${att.filename}`;
          try {
            await env.R2.put(key, att.content);
          } catch (r2err: any) {
            console.warn(`R2 put failed for ${key}:`, r2err.message);
          }
        }
      }

      const embedText = [subj, from, body]
        .filter(Boolean)
        .join("\n")
        .substring(0, MAX_BODY_CHARS);

      embedBatch.push({
        id: emailId,
        text: embedText,
        metadata: {
          folder, uid,
          date: parsed.date ? parsed.date.getTime() / 1000 : 0,
          sender: from, subject: subj,
          has_attachment: hasAtts ? 1 : 0,
        },
      });

      if (uid > maxUid) maxUid = uid;

      if (embedBatch.length >= EMBED_BATCH) {
        await flushEmbeddings(env, embedBatch.splice(0));
      }
    } catch (err: any) {
      errors.push(`UID ${uid}: ${err.message}`);
      console.error(`Failed UID ${uid} in ${folder}:`, err.message);
    }
  }

  if (embedBatch.length > 0) {
    await flushEmbeddings(env, embedBatch);
  }

  await updateFolderState(env, folder, maxUid, uidvalidity, exists);
  return { folder, newMessages: newUids.length, lastUid: maxUid, errors };
}

async function flushEmbeddings(
  env: Env,
  batch: { id: string; text: string; metadata: Record<string, any> }[]
): Promise<void> {
  if (batch.length === 0) return;

  try {
    const texts = batch.map((b) => b.text);
    const response = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: texts });
    const embeddings = (response as any).data as number[][];

    if (!embeddings || embeddings.length !== batch.length) {
      console.error(`Embedding count mismatch: ${embeddings?.length} vs ${batch.length}`);
      return;
    }

    const vectors = batch.map((b, i) => ({
      id: b.id,
      values: embeddings[i],
      metadata: b.metadata,
    }));

    await env.VECTORIZE.upsert(vectors);
  } catch (err: any) {
    console.error("flushEmbeddings failed:", err.message);
  }
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
