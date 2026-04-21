/**
 * Semantic search tools — use D1, Vectorize, R2, Workers AI.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runIncrementalSync } from "../sync/incremental.js";
import type { Env } from "../types.js";

export function registerSearchTools(server: McpServer, env: Env) {
  // ── semantic_search ──────────────────────────────────────────────────
  server.tool(
    "semantic_search",
    `Search emails and WhatsApp messages by meaning using local vector search. One unified index spans both channels.

Requires prior sync via sync_now (for email) and/or an active WhatsApp bridge (for WhatsApp). If this returns zero results and currently_indexed=0, the user has not yet run sync_now. Tell them to do so.

For finding emails when you know specific terms/dates, prefer search_messages (IMAP-level search). Use semantic_search for concept-based queries like "messages about the contract renewal" or "discussions about Q4 revenue".`,
    {
      query: z.string().describe("Natural language search query"),
      channel: z.enum(["email", "whatsapp", "all"]).default("all").describe("Which channel(s) to search"),
      folders: z.string().optional().describe("Comma-separated email folder names (email channel only)"),
      wa_account: z.string().optional().describe("Restrict to a single WhatsApp account (whatsapp channel only)"),
      wa_chat_jid: z.string().optional().describe("Restrict to a single WhatsApp chat (whatsapp channel only)"),
      date_from: z.string().optional().describe("ISO date (YYYY-MM-DD) — only messages on or after"),
      date_to: z.string().optional().describe("ISO date (YYYY-MM-DD) — only messages on or before"),
      sender: z.string().optional().describe("Filter by sender address or name (email) / jid substring (whatsapp)"),
      has_attachment: z.boolean().optional().describe("Email only: filter to messages with/without attachments"),
      limit: z.number().default(10).describe("Maximum results"),
    },
    async ({ query, channel, folders, wa_account, wa_chat_jid, date_from, date_to, sender, has_attachment, limit }) => {
      // Backlog guard only applies when email is in scope.
      const indexedRow = await env.DB.prepare("SELECT COUNT(*) as cnt FROM emails").first<{ cnt: number }>();
      const currentlyIndexed = indexedRow?.cnt || 0;
      const folderStateRows = await env.DB.prepare(
        "SELECT SUM(message_count) as total FROM folder_state"
      ).first<{ total: number }>();
      const totalOnServer = folderStateRows?.total || 0;

      if (channel !== "whatsapp" && totalOnServer > 0 && currentlyIndexed < totalOnServer * 0.9) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "index_incomplete",
              currently_indexed: currentlyIndexed,
              total_on_server: totalOnServer,
              percent_indexed: Math.round((currentlyIndexed / totalOnServer) * 100),
              message: `The email search index has only ${currentlyIndexed} of ~${totalOnServer} messages indexed (${Math.round((currentlyIndexed / totalOnServer) * 100)}%). Results would be unreliable. Use the search_messages tool instead — it searches the live mailbox directly via IMAP. The index catches up automatically every 15 minutes. (To search WhatsApp only, pass channel="whatsapp".)`,
            }),
          }],
        };
      }

      // Generate query embedding
      const embResponse = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
        text: [query],
      });
      const queryVector = (embResponse as any).data?.[0] as number[];
      if (!queryVector) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Failed to generate query embedding" }) }] };
      }

      // Build Vectorize metadata filter
      const filter: Record<string, any> = {};
      if (channel === "email") filter.channel = "email";
      if (channel === "whatsapp") filter.channel = "whatsapp";
      // For channel "all" we intentionally omit the channel filter so we
      // also return legacy email vectors that pre-date the channel tag.
      if (channel !== "whatsapp" && folders) {
        const folderList = folders.split(",").map((f) => f.trim());
        filter.folder = folderList.length === 1 ? folderList[0] : { $in: folderList };
      }
      if (channel !== "email" && wa_account) filter.account_id = wa_account;
      if (channel !== "email" && wa_chat_jid) filter.chat_jid = wa_chat_jid;
      if (date_from) {
        filter.date = { ...filter.date, $gte: new Date(date_from).getTime() / 1000 };
      }
      if (date_to) {
        filter.date = { ...filter.date, $lte: new Date(date_to).getTime() / 1000 };
      }
      if (has_attachment === true && channel !== "whatsapp") filter.has_attachment = 1;
      if (has_attachment === false && channel !== "whatsapp") filter.has_attachment = 0;
      // `sender` handled as post-filter below — Vectorize has no substring op.

      // Query Vectorize
      const vectorResults = await env.VECTORIZE.query(queryVector, {
        topK: limit,
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        returnMetadata: "all",
      });

      // Enrich from D1 (email rows and WhatsApp rows, depending on vector id prefix)
      const messages: any[] = [];
      for (const match of vectorResults.matches) {
        const isWa = typeof match.id === "string" && match.id.startsWith("wa:");
        if (isWa) {
          // wa:{account}:{chat_jid}:{message_id}
          const rest = (match.id as string).slice(3);
          const firstColon = rest.indexOf(":");
          const lastColon = rest.lastIndexOf(":");
          if (firstColon < 0 || lastColon <= firstColon) continue;
          const accountId = rest.slice(0, firstColon);
          const chatJid = rest.slice(firstColon + 1, lastColon);
          const messageId = rest.slice(lastColon + 1);

          const row = await env.DB.prepare(
            `SELECT m.id, m.chat_jid, m.account_id, m.sender, m.content, m.timestamp,
                    m.is_from_me, m.media_type, c.name AS chat_name
             FROM wa_messages m
             LEFT JOIN wa_chats c ON c.jid = m.chat_jid AND c.account_id = m.account_id
             WHERE m.account_id = ? AND m.chat_jid = ? AND m.id = ?`
          ).bind(accountId, chatJid, messageId).first<any>();
          if (!row) continue;
          if (sender && !(row.sender as string || "").toLowerCase().includes(sender.toLowerCase())) continue;

          messages.push({
            channel: "whatsapp",
            account: row.account_id,
            chat_jid: row.chat_jid,
            chat_name: row.chat_name,
            message_id: row.id,
            sender: row.sender,
            date: row.timestamp,
            is_from_me: !!row.is_from_me,
            media_type: row.media_type || null,
            snippet: (row.content || "").slice(0, 300),
            score: match.score ? Math.round(match.score * 10000) / 10000 : 0,
          });
        } else {
          const row = await env.DB.prepare("SELECT * FROM emails WHERE id = ?")
            .bind(match.id)
            .first();
          if (!row) continue;
          if (sender && !((row.sender as string) || "").toLowerCase().includes(sender.toLowerCase())) continue;

          const attFilenames = JSON.parse((row.attachment_filenames as string) || "[]");
          messages.push({
            channel: "email",
            uid: row.uid,
            folder: row.folder,
            date: row.date_iso,
            from: row.sender,
            subject: row.subject,
            snippet: row.snippet,
            attachment_count: attFilenames.length,
            score: match.score ? Math.round(match.score * 10000) / 10000 : 0,
          });
        }
      }

      // Check if sync is running
      const runningJob = await env.DB.prepare(
        "SELECT * FROM sync_jobs WHERE status = 'running' LIMIT 1"
      ).first();

      const waCountRow = await env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM wa_messages"
      ).first<{ cnt: number }>();

      const result: any = {
        query,
        channel,
        total: messages.length,
        messages,
        email_indexed: currentlyIndexed,
        whatsapp_indexed: waCountRow?.cnt || 0,
      };

      if (channel !== "whatsapp" && currentlyIndexed === 0) {
        result._notice = "No emails have been indexed yet. Run sync_now first to populate the email index.";
      }
      if (runningJob) {
        result._notice = `> Note: email sync in progress. Results may be incomplete.`;
      }

      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  // ── get_attachments ──────────────────────────────────────────────────
  server.tool(
    "get_attachments",
    "List attachments for a message from R2 storage. Much faster than get_message for messages with large attachments.",
    {
      uid: z.number().describe("Message UID"),
      folder: z.string().default("INBOX"),
    },
    async ({ uid, folder }) => {
      const emailId = `${folder}:${uid}`;
      const row = await env.DB.prepare("SELECT attachment_filenames FROM emails WHERE id = ?")
        .bind(emailId)
        .first<{ attachment_filenames: string }>();

      if (!row) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `Message UID ${uid} in ${folder} not found in index. Run sync_now first.` }),
            },
          ],
        };
      }

      const filenames: string[] = JSON.parse(row.attachment_filenames || "[]");
      const attachments: any[] = [];

      for (const filename of filenames) {
        const key = `attachments/${folder}/${uid}/${filename}`;
        const obj = await env.R2.head(key);
        attachments.push({
          filename,
          mime: guessMime(filename),
          size: obj?.size || null,
          r2_key: key,
        });
      }

      return {
        content: [
          { type: "text", text: JSON.stringify({ uid, folder, attachments }) },
        ],
      };
    }
  );

  // ── sync_now ─────────────────────────────────────────────────────────
  server.tool(
    "sync_now",
    `Trigger an email sync. Fetches messages from IMAP, extracts text and attachments, generates embeddings, and indexes into the local vector database.

IMPORTANT for first-time users: This MUST be run once after connecting Epistole before semantic_search will return any results. semantic_search only searches the local index built by this tool.

Returns immediately with a job ID. Sync runs in the background — check progress with sync_status. A first sync on a mailbox with thousands of messages can take 5-30 minutes. The cron trigger also runs this automatically every 15 minutes.

After calling this, tell the user:
1. Sync has started in the background
2. They can ask "what's my email sync status?" to check progress
3. They don't need to keep Claude open — it runs on Cloudflare
4. Semantic search will be available once sync completes (usually 1-5 min for first batch of messages)`,
    {
      folders: z.string().optional().describe("Comma-separated folder names (default: all)"),
      full: z.boolean().default(false).describe("Re-index everything if true"),
    },
    async ({ folders, full }) => {
      const jobId = crypto.randomUUID().substring(0, 8);
      const folderList = folders
        ? folders.split(",").map((f) => f.trim())
        : undefined;

      // Record job as running
      await env.DB.prepare(
        "INSERT INTO sync_jobs (job_id, status, started_at, folders, full_sync) VALUES (?, 'running', ?, ?, ?)"
      )
        .bind(jobId, new Date().toISOString(), folders || "all", full ? 1 : 0)
        .run();

      // Fire-and-forget: run the sync in the background so we return immediately
      // Durable Object keeps the promise alive past the tool response
      const runInBackground = (async () => {
        try {
          const results = await runIncrementalSync(env, { folders: folderList, full, jobId });
          const totalNew = results.reduce((s, r) => s + r.newMessages, 0);
          const allErrors = results.flatMap((r) => r.errors);

          await env.DB.prepare(
            "UPDATE sync_jobs SET status = 'completed', finished_at = ?, error = ? WHERE job_id = ?"
          )
            .bind(
              new Date().toISOString(),
              allErrors.length > 0 ? allErrors.join("; ").slice(0, 500) : null,
              jobId
            )
            .run();

          console.log(`Sync ${jobId} complete: ${totalNew} new messages`);
        } catch (err: any) {
          await env.DB.prepare(
            "UPDATE sync_jobs SET status = 'failed', finished_at = ?, error = ? WHERE job_id = ?"
          )
            .bind(new Date().toISOString(), err.message?.slice(0, 500) || "unknown", jobId)
            .run();

          console.error(`Sync ${jobId} failed:`, err.message);
        }
      })();

      // Don't await — let it keep running
      runInBackground.catch(() => {}); // swallow unhandled rejection

      const indexedRow = await env.DB.prepare("SELECT COUNT(*) as cnt FROM emails").first<{ cnt: number }>();
      const currentlyIndexed = indexedRow?.cnt || 0;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "started",
              job_id: jobId,
              message: `Email sync started in the background. ${currentlyIndexed === 0 ? "This is your first sync — it may take a few minutes to complete." : `Currently ${currentlyIndexed} messages indexed. New messages will be added.`}`,
              full_resync: full,
              folders: folderList || "all folders",
              currently_indexed: currentlyIndexed,
              next_steps: [
                "Sync runs in the background on Cloudflare — you can close Claude Desktop",
                "Call sync_status to check progress",
                "Once complete, use semantic_search to find emails by meaning",
              ],
            }),
          },
        ],
      };
    }
  );

  // ── sync_status ──────────────────────────────────────────────────────
  server.tool(
    "sync_status",
    "Check the current state of the email sync process. Returns sync timing, per-folder stats, and recent errors.",
    {},
    async () => {
      // Treat any "running" job older than 60s as stale (the Worker probably
      // hit its CPU limit and died without updating status).
      const staleCutoff = new Date(Date.now() - 60_000).toISOString();
      await env.DB.prepare(
        "UPDATE sync_jobs SET status = 'timed_out', finished_at = ? WHERE status = 'running' AND started_at < ?"
      )
        .bind(new Date().toISOString(), staleCutoff)
        .run()
        .catch(() => {});

      // Emails grouped by folder (authoritative count from actual data)
      const emailCounts = await env.DB.prepare(
        "SELECT folder, COUNT(*) as cnt FROM emails GROUP BY folder"
      ).all<{ folder: string; cnt: number }>();

      // Folder state (sync checkpoint info)
      const folderRows = await env.DB.prepare(
        "SELECT folder, last_uid, uidvalidity, last_sync_at, message_count FROM folder_state"
      ).all();

      const folders: Record<string, any> = {};
      for (const c of emailCounts.results) {
        folders[c.folder] = { indexed: c.cnt };
      }
      for (const row of folderRows.results) {
        const f = row.folder as string;
        folders[f] = {
          indexed: folders[f]?.indexed ?? 0,
          last_uid: row.last_uid,
          last_sync_at: row.last_sync_at,
        };
      }

      // Total indexed
      const countRow = await env.DB.prepare("SELECT COUNT(*) as cnt FROM emails").first<{ cnt: number }>();

      // Recent jobs (after stale cleanup above)
      const jobs = await env.DB.prepare(
        "SELECT * FROM sync_jobs ORDER BY started_at DESC LIMIT 5"
      ).all();

      const running = jobs.results.find((j) => j.status === "running");
      const lastComplete = jobs.results.find((j) => j.status === "completed" || j.status === "timed_out");

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              last_full_sync: lastComplete?.full_sync ? lastComplete.finished_at : null,
              last_incremental: lastComplete?.finished_at || null,
              currently_syncing: !!running,
              indexed_total: countRow?.cnt || 0,
              folders,
              recent_errors: jobs.results
                .filter((j) => j.error)
                .map((j) => `${j.job_id}: ${j.error}`)
                .slice(0, 5),
            }),
          },
        ],
      };
    }
  );

  // ── find_by_thread ───────────────────────────────────────────────────
  server.tool(
    "find_by_thread",
    "Find all messages in an email thread by Message-ID, In-Reply-To header, or subject line.",
    {
      message_id_or_subject: z.string().describe("Message-ID header value or subject to search"),
    },
    async ({ message_id_or_subject }) => {
      const q = message_id_or_subject.trim();

      // Search by message_id
      let rows = await env.DB.prepare(
        "SELECT * FROM emails WHERE message_id = ? OR in_reply_to = ?"
      )
        .bind(q, q)
        .all();

      // Follow the chain
      const seen = new Set<string>();
      const allRows = [...rows.results];
      for (const row of allRows) {
        seen.add(row.id as string);
      }

      // Find replies to found messages
      const messageIds = allRows
        .map((r) => r.message_id as string)
        .filter(Boolean);
      for (const mid of messageIds) {
        const replies = await env.DB.prepare(
          "SELECT * FROM emails WHERE in_reply_to = ?"
        )
          .bind(mid)
          .all();
        for (const r of replies.results) {
          if (!seen.has(r.id as string)) {
            allRows.push(r);
            seen.add(r.id as string);
          }
        }
      }

      // Fallback: subject search (strip Re:/Fwd:)
      if (allRows.length === 0) {
        const cleanSubject = q.replace(/^(Re:|Fwd?:)\s*/gi, "").trim();
        const subjectRows = await env.DB.prepare(
          "SELECT * FROM emails WHERE subject LIKE ? LIMIT 50"
        )
          .bind(`%${cleanSubject}%`)
          .all();
        allRows.push(...subjectRows.results);
      }

      const messages = allRows
        .map((r) => ({
          uid: r.uid,
          folder: r.folder,
          date: r.date_iso,
          from: r.sender,
          to: r.recipients,
          subject: r.subject,
          message_id: r.message_id,
          in_reply_to: r.in_reply_to,
        }))
        .sort((a, b) => ((a.date as string) || "").localeCompare((b.date as string) || ""));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              query: q,
              thread_length: messages.length,
              messages,
            }),
          },
        ],
      };
    }
  );
}

function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    zip: "application/zip",
    csv: "text/csv",
    txt: "text/plain",
    html: "text/html",
  };
  return map[ext] || "application/octet-stream";
}
