/**
 * MCP server setup — registers all tools (email + WhatsApp bridge).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerLiveTools } from "./tools/live.js";
import { registerSearchTools } from "./tools/search.js";
import { registerWhatsAppTools } from "./tools/whatsapp.js";
import type { Env } from "./types.js";

// Top-level guidance for the model. Visible via the MCP initialize handshake's
// InitializeResult.instructions, which Claude surfaces as a system-level prompt
// when this connector is attached. Primary value: disambiguate routing between
// the email tools (search_messages, semantic_search) and the WhatsApp tools
// (wa_list_messages, wa_search_contacts, etc.) since both are in one server.
const INSTRUCTIONS = `
This server gives you access to the user's email (IMAP/SMTP) and — if the
WhatsApp bridge is enabled — a read-only mirror of their WhatsApp history.
Pick tools by channel:

- Email questions ("show my recent emails", "email from X about Y", "unread
  inbox"): use read_inbox, search_messages, get_message, or semantic_search.
- WhatsApp questions ("what did X text me", "recent whatsapp messages", "find
  a contact named Y"): prefer the wa_* tools — wa_list_messages,
  wa_search_contacts, wa_get_contact, wa_list_chats, wa_get_last_interaction,
  wa_get_chat, wa_get_message_context, wa_get_contact_chats,
  wa_accounts_status. These query the mirrored history directly and are much
  more precise than semantic_search for WhatsApp-specific intent.
- Cross-channel or fuzzy intent ("anything about the Barcelona trip",
  "messages mentioning the invoice"): use semantic_search. It ranks across
  both email and mirrored WhatsApp messages.

You cannot SEND WhatsApp messages through this server — send is desktop-only
via Hermeneia. You can send email via send_message and reply_to_message.
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
  registerWhatsAppTools(server, env);

  return server;
}
