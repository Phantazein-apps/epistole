/**
 * MCP server setup — registers all email tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerLiveTools } from "./tools/live.js";
import { registerSearchTools } from "./tools/search.js";
import type { Env } from "./types.js";

const INSTRUCTIONS = `
This server gives you access to the user's email over IMAP/SMTP.

- Live mailbox lookups ("show my recent emails", "email from X about Y",
  "unread inbox"): use read_inbox, search_messages, get_message.
- Concept-based queries ("anything about the Barcelona trip", "messages
  mentioning the invoice"): use semantic_search.
- Sending: send_message and reply_to_message.
`.trim();

export function createMcpServer(env: Env): McpServer {
  const server = new McpServer(
    {
      name: "epistole",
      version: "3.0.0",
    },
    {
      instructions: INSTRUCTIONS,
    }
  );

  registerLiveTools(server, env);
  registerSearchTools(server, env);

  return server;
}
