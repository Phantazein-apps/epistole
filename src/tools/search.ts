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
    "Search emails by meaning using semantic vector search. Finds messages whose content is semantically similar to the query, searching across subject, body, and PDF attachment text.",
    {
      query: z.string().describe("Natural language search query"),
      folders: z.string().optional().describe("Comma-separated folder names to restrict search"),
      date_from: z.string().optional().describe("ISO date (YYYY-MM-DD) — only messages on or after"),
      date_to: z.string().optional().describe("ISO date (YYYY-MM-DD) — only messages on or before"),
      sender: z.string().optional().describe("Filter by sender address or name"),
      has_attachment: z.boolean().optional().describe("Filter to messages with/without attachments"),
      limit: z.number().default(10).describe("Maximum results"),
    },
    async ({ query, folders, date_from, date_to, sender, has_attachment, limit }) => {
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
      if (folders) {
        const folderList = folders.split(",").map((f) => f.trim());
        if (folderList.length === 1) {
          filter.folder = folderList[0];
        } else {
          filter.folder = { $in: folderList };
        }
      }
      if (date_from) {
        filter.date = { ...filter.date, $gte: new Date(date_from).getTime() / 1000 };
      }
      if (date_to) {
        filter.date = { ...filter.date, $lte: new Date(date_to).getTime() / 1000 };
      }
      if (sender) {
        // Vectorize doesn't support $contains, so we skip sender filter in vector query
        // and post-filter from D1 results
      }
      if (has_attachment === true) filter.has_attachment = 1;
      if (has_attachment === false) filter.has_attachment = 0;

      // Query Vectorize
      const vectorResults = await env.VECTORIZE.query(queryVector, {
        topK: limit,
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        returnMetadata: "all",
      });

      // Enrich from D1
      const messages: any[] = [];
      for (const match of vectorResults.matches) {
        const meta = match.metadata || {};
        const row = await env.DB.prepare("SELECT * FROM emails WHERE id = ?")
          .bind(match.id)
          .first();

        if (row) {
          // Post-filter by sender if specified
          if (sender && !(row.sender as string).toLowerCase().includes(sender.toLowerCase())) {
            continue;
          }

          const attFilenames = JSON.parse((row.attachment_filenames as string) || "[]");
          messages.push({
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

      const result: any = { query, total: messages.length, messages };
      if (runningJob) {
        result._notice = `> Note: sync in progress. Results may be incomplete.`;
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
    "Trigger an immediate email sync cycle. Returns immediately with a job ID; sync runs in the background.",
    {
      folders: z.string().optional().describe("Comma-separated folder names (default: all)"),
      full: z.boolean().default(false).describe("Re-index everything if true"),
    },
    async ({ folders, full }, { sendNotification }) => {
      const jobId = crypto.randomUUID().substring(0, 8);
      const folderList = folders
        ? folders.split(",").map((f) => f.trim())
        : undefined;

      // Record job
      await env.DB.prepare(
        "INSERT INTO sync_jobs (job_id, status, started_at, folders, full_sync) VALUES (?, 'running', ?, ?, ?)"
      )
        .bind(jobId, new Date().toISOString(), folders || "all", full ? 1 : 0)
        .run();

      // Run sync (this will block but that's OK for a tool call)
      try {
        const results = await runIncrementalSync(env, { folders: folderList, full });
        const totalNew = results.reduce((s, r) => s + r.newMessages, 0);
        const allErrors = results.flatMap((r) => r.errors);

        await env.DB.prepare(
          "UPDATE sync_jobs SET status = 'completed', finished_at = ?, error = ? WHERE job_id = ?"
        )
          .bind(
            new Date().toISOString(),
            allErrors.length > 0 ? allErrors.join("; ") : null,
            jobId
          )
          .run();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                job_id: jobId,
                status: "completed",
                full,
                folders: folderList || "all",
                new_messages: totalNew,
                errors: allErrors.slice(0, 5),
              }),
            },
          ],
        };
      } catch (err: any) {
        await env.DB.prepare(
          "UPDATE sync_jobs SET status = 'failed', finished_at = ?, error = ? WHERE job_id = ?"
        )
          .bind(new Date().toISOString(), err.message, jobId)
          .run();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ job_id: jobId, status: "failed", error: err.message }),
            },
          ],
        };
      }
    }
  );

  // ── sync_status ──────────────────────────────────────────────────────
  server.tool(
    "sync_status",
    "Check the current state of the email sync process. Returns sync timing, per-folder stats, and recent errors.",
    {},
    async () => {
      // Folder stats
      const folderRows = await env.DB.prepare(
        "SELECT folder, last_uid, uidvalidity, last_sync_at, message_count FROM folder_state"
      ).all();

      const folders: Record<string, any> = {};
      for (const row of folderRows.results) {
        folders[row.folder as string] = {
          indexed: row.message_count,
          last_uid: row.last_uid,
          uidvalidity: row.uidvalidity,
          last_sync_at: row.last_sync_at,
        };
      }

      // Total indexed
      const countRow = await env.DB.prepare("SELECT COUNT(*) as cnt FROM emails").first<{ cnt: number }>();

      // Recent jobs
      const jobs = await env.DB.prepare(
        "SELECT * FROM sync_jobs ORDER BY started_at DESC LIMIT 5"
      ).all();

      const running = jobs.results.find((j) => j.status === "running");
      const lastComplete = jobs.results.find((j) => j.status === "completed");

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
