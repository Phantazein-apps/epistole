/**
 * Epistole — Remote email MCP server on Cloudflare Workers.
 *
 * Entry points:
 *   fetch()     → MCP over Streamable HTTP (/mcp)
 *   scheduled() → cron-triggered IMAP sync
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerLiveTools } from "./tools/live.js";
import { registerSearchTools } from "./tools/search.js";
import { runIncrementalSync } from "./sync/incremental.js";
import type { Env } from "./types.js";

// ── MCP Agent ──────────────────────────────────────────────────────────────

export class EmailMcpAgent extends McpAgent<Env> {
  server = new McpServer({
    name: "epistole",
    version: "3.0.0",
  });

  async init() {
    registerLiveTools(this.server, this.env);
    registerSearchTools(this.server, this.env);
  }
}

// ── Worker ─────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response("ok");
    }

    // MCP endpoint — auth required
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      // Bearer token auth
      const auth = request.headers.get("Authorization");
      if (!auth || auth !== `Bearer ${env.MCP_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Route to MCP agent
      return (EmailMcpAgent as any).serve(url.pathname).fetch(request, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        console.log("Cron sync starting...");

        // Record sync job
        const jobId = crypto.randomUUID().substring(0, 8);
        await env.DB.prepare(
          "INSERT INTO sync_jobs (job_id, status, started_at, folders, full_sync) VALUES (?, 'running', ?, 'all', 0)"
        )
          .bind(jobId, new Date().toISOString())
          .run();

        try {
          const results = await runIncrementalSync(env);
          const totalNew = results.reduce((s, r) => s + r.newMessages, 0);
          const errors = results.flatMap((r) => r.errors);

          await env.DB.prepare(
            "UPDATE sync_jobs SET status = 'completed', finished_at = ?, error = ? WHERE job_id = ?"
          )
            .bind(
              new Date().toISOString(),
              errors.length > 0 ? errors.join("; ") : null,
              jobId
            )
            .run();

          console.log(`Cron sync complete: ${totalNew} new messages across ${results.length} folders`);
        } catch (err: any) {
          await env.DB.prepare(
            "UPDATE sync_jobs SET status = 'failed', finished_at = ?, error = ? WHERE job_id = ?"
          )
            .bind(new Date().toISOString(), err.message, jobId)
            .run();

          console.error("Cron sync failed:", err.message);
        }
      })()
    );
  },
};
