/**
 * MCP prompts — pure text templates exposed to clients via prompts/list.
 *
 * No new server logic: each handler returns a single user-role message that
 * primes Claude to drive the existing tools (read_inbox, semantic_search,
 * get_emails, send_message, ...) toward a specific email-workflow goal.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function userText(text: string) {
  return {
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text: text.trim() },
      },
    ],
  };
}

export function registerPrompts(server: McpServer) {
  server.prompt(
    "triage_inbox",
    "Walk through unread inbox messages and bucket them into act-now / reply / archive / ignore.",
    {
      folder: z.string().optional().describe("Folder to triage (default: INBOX)"),
      limit: z.string().optional().describe("How many messages to consider (default: 20)"),
    },
    ({ folder, limit }) =>
      userText(`
Triage my ${folder || "INBOX"} inbox.

1. Call read_inbox with folder=${folder || "INBOX"}, limit=${limit || "20"} and unseen filter where supported.
2. For each message, decide: ACT NOW, REPLY, ARCHIVE, IGNORE.
3. For ACT NOW and REPLY items, summarise what's needed in one sentence.
4. Suggest a bulk_action plan for the ARCHIVE and IGNORE buckets (move or delete) — but DO NOT execute it without my confirmation.
5. End with a single-line summary: counts per bucket plus the top 3 things that need my attention today.
`)
  );

  server.prompt(
    "summarize_thread",
    "Summarise an email thread by Message-ID or subject — who said what, decisions made, open questions.",
    {
      message_id_or_subject: z.string().describe("Message-ID header or thread subject"),
    },
    ({ message_id_or_subject }) =>
      userText(`
Summarise the email thread identified by: "${message_id_or_subject}".

1. Use find_by_thread to gather all messages.
2. If you only have headers, fetch full bodies with get_emails (batched).
3. Produce: chronological 3-5 bullet summary, decisions/agreements made, open questions or blockers, who is waiting on whom.
4. Keep it under ~200 words. No fluff.
`)
  );

  server.prompt(
    "compose_reply",
    "Draft a reply to a specific message. Returns the draft for review — does not send.",
    {
      uid: z.string().describe("UID of the message to reply to"),
      folder: z.string().optional().describe("Folder containing the message (default: INBOX)"),
      tone: z
        .string()
        .optional()
        .describe("Optional tone hint, e.g. 'warm', 'concise', 'formal'"),
      intent: z
        .string()
        .optional()
        .describe("What the reply should accomplish (decline, accept, ask question, ...)"),
    },
    ({ uid, folder, tone, intent }) =>
      userText(`
Draft a reply to UID ${uid} in folder ${folder || "INBOX"}.

1. Call get_message to read the original.
2. Draft a reply${tone ? ` in a ${tone} tone` : ""}${intent ? ` whose intent is: ${intent}` : ""}.
3. Show me the draft in plain text. DO NOT send it.
4. After I approve, call save_draft (so I can review in my mail app) or reply_to_message (to send immediately) — whichever I choose.
`)
  );

  server.prompt(
    "draft_from_context",
    "Compose a new email based on context I describe — context can include a goal, an audience, and any attached notes.",
    {
      to: z.string().describe("Recipient address(es), comma-separated"),
      goal: z.string().describe("What this email needs to accomplish"),
      context: z.string().optional().describe("Background context (notes, links, prior conversation)"),
      tone: z.string().optional().describe("Optional tone hint"),
    },
    ({ to, goal, context, tone }) =>
      userText(`
Compose a new email.

To: ${to}
Goal: ${goal}
${context ? `Context:\n${context}\n` : ""}${tone ? `Tone: ${tone}\n` : ""}
1. Search my recent email with this person via search_messages (from/to=${to}) and skim 3-5 messages with get_emails to match my voice and prior context.
2. Draft a subject line and body. Keep it as short as the goal allows.
3. Show me the draft. DO NOT send.
4. After I approve, save_draft so I can edit, or send_message if I say "send it".
`)
  );

  server.prompt(
    "extract_action_items",
    "Pull all open action items addressed to me out of recent email.",
    {
      since: z.string().optional().describe("YYYY-MM-DD lower bound (default: last 7 days)"),
      folder: z.string().optional().describe("Folder to scan (default: INBOX)"),
    },
    ({ since, folder }) =>
      userText(`
Extract action items addressed to me from email since ${since || "the last 7 days"} in folder ${folder || "INBOX"}.

1. Use search_messages with since=${since || "(today minus 7 days)"} and folder=${folder || "INBOX"} to gather candidates.
2. Use get_emails to read bodies in batches of 20.
3. Extract only items where I am the owner (not delegated away, not informational).
4. Output a markdown checklist:
   - [ ] <action> — <who asked> — <due date or "no deadline"> — UID <uid>
5. Group by urgency (this week / this month / no deadline).
`)
  );

  server.prompt(
    "summarize_meetings",
    "Summarise meeting-related email threads from a time window — invites, recaps, follow-ups.",
    {
      since: z.string().optional().describe("YYYY-MM-DD lower bound (default: last 7 days)"),
      query: z.string().optional().describe("Optional topic filter, e.g. 'Q3 planning'"),
    },
    ({ since, query }) =>
      userText(`
Summarise meeting-related email since ${since || "the last 7 days"}${query ? ` on the topic "${query}"` : ""}.

1. Use semantic_search with query="${query || "meeting OR agenda OR minutes OR recap OR invite"}" and date_from=${since || "(today minus 7 days)"}.
2. Group results by meeting/topic. Use find_by_thread to consolidate threads.
3. For each meeting, give: date, attendees (best guess), key decisions, follow-ups owed (and by whom).
4. End with a "needs my action" section.
`)
  );

  server.prompt(
    "cleanup_inbox",
    "Identify low-value mail (newsletters, automated notifications, expired offers) and propose a cleanup plan.",
    {
      folder: z.string().optional().describe("Folder to clean (default: INBOX)"),
      older_than_days: z
        .string()
        .optional()
        .describe("Only consider mail older than this many days (default: 30)"),
    },
    ({ folder, older_than_days }) =>
      userText(`
Help me clean up ${folder || "INBOX"}.

1. Use search_messages on ${folder || "INBOX"} with before=(today minus ${older_than_days || "30"} days).
2. Use get_emails in batches to skim. Group senders into:
   - newsletters / marketing
   - automated notifications (CI, monitoring, receipts)
   - expired offers / time-sensitive notices that are now stale
   - personal/work mail (LEAVE ALONE)
3. Propose a bulk_action plan per group: move to Archive, delete, or leave.
4. Show me the plan as a table with sender, count, and proposed action. DO NOT execute until I confirm.
`)
  );
}
