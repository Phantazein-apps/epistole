/**
 * MCP server setup — registers all 14 tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerLiveTools } from "./tools/live.js";
import { registerSearchTools } from "./tools/search.js";
import { registerWhatsAppTools } from "./tools/whatsapp.js";
import type { Env } from "./types.js";

export function createMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: "epistole",
    version: "3.0.0",
  });

  registerLiveTools(server, env);
  registerSearchTools(server, env);
  registerWhatsAppTools(server, env);

  return server;
}
