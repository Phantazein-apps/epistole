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

// ── MCP Agent (Durable Object) ────────────────────────────────────────────

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

    // Health check — no auth required
    if (url.pathname === "/health") {
      return new Response("ok");
    }

    // Everything under /mcp requires bearer token auth
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const auth = request.headers.get("Authorization");
      if (!auth || auth !== `Bearer ${env.MCP_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Route to the Durable Object via Agents SDK
      const agentId = env.MCP_AGENT.idFromName("default");
      const agent = env.MCP_AGENT.get(agentId);

      // Strip the /mcp prefix — the agent expects paths relative to its root
      const agentUrl = new URL(request.url);
      agentUrl.pathname = agentUrl.pathname.replace(/^\/mcp/, "") || "/";

      const agentRequest = new Request(agentUrl.toString(), request);
      return agent.fetch(agentRequest);
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        console.log("Cron sync starting...");

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
