/**
 * Epistole — Remote email MCP server on Cloudflare Workers.
 *
 * Auth: OAuth 2.1 with PKCE via @cloudflare/workers-oauth-provider.
 * Login: Email verification code (magic link).
 *
 * Entry points:
 *   fetch()     → OAuthProvider handles /authorize, /token, /register, /mcp
 *   scheduled() → cron-triggered IMAP sync
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { registerLiveTools } from "./tools/live.js";
import { registerSearchTools } from "./tools/search.js";
import { registerWhatsAppTools } from "./tools/whatsapp.js";
import { runIncrementalSync } from "./sync/incremental.js";
import authHandler from "./auth-handler.js";
import type { Env } from "./types.js";

// ── User props passed through OAuth ───────────────────────────────────────

type Props = {
  email: string;
  name: string;
};

// ── MCP Agent (Durable Object) ────────────────────────────────────────────

export class EmailMcpAgent extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: "epistole",
    version: "3.0.0",
  });

  async init() {
    registerLiveTools(this.server, this.env);
    registerSearchTools(this.server, this.env);
    registerWhatsAppTools(this.server, this.env);
  }
}

// ── OAuthProvider (handles fetch) ─────────────────────────────────────────

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: EmailMcpAgent.serve("/mcp"),
  defaultHandler: authHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

// ── Worker default export (fetch + scheduled) ─────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Health check — bypass OAuth
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok");
    }

    // Everything else goes through OAuthProvider
    return oauthProvider.fetch(request, env, ctx);
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
          const results = await runIncrementalSync(env, { jobId });
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

          console.log(
            `Cron sync complete: ${totalNew} new messages across ${results.length} folders`
          );
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
