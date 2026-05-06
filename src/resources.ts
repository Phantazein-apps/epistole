/**
 * MCP resources — read-only views over the configured account, exposed via
 * resources/list and resources/read.
 *
 * Epistole is single-account today; the {account} URI template variable is
 * a parity hook for codefuturist-style multi-account servers and MUST match
 * env.EMAIL_ADDRESS (case-insensitive).  Multi-account is on the Tier 3
 * roadmap; the schema is shaped now so clients won't break later.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withImap, type ImapConfig } from "./imap/client.js";
import type { Env } from "./types.js";

function imapConfig(env: Env): ImapConfig {
  return {
    host: env.IMAP_HOST,
    port: parseInt(env.IMAP_PORT || "993"),
    user: env.IMAP_USER,
    pass: env.IMAP_PASS,
  };
}

function jsonContent(uri: URL, value: unknown) {
  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function accountMatches(env: Env, account: string): boolean {
  return account.toLowerCase() === env.EMAIL_ADDRESS.toLowerCase();
}

function unknownAccount(uri: URL, env: Env, account: string) {
  return jsonContent(uri, {
    error: "unknown_account",
    requested: account,
    configured: env.EMAIL_ADDRESS,
    note: "Epistole is single-account today; multi-account is on the Tier 3 roadmap.",
  });
}

export function registerResources(server: McpServer, env: Env) {
  // ── email://accounts ─────────────────────────────────────────────────
  server.resource(
    "accounts",
    "email://accounts",
    {
      description:
        "Configured email accounts. Single-account today; multi-account is roadmap Tier 3.",
      mimeType: "application/json",
    },
    async (uri) =>
      jsonContent(uri, {
        accounts: [
          {
            address: env.EMAIL_ADDRESS,
            name: env.FULL_NAME,
            imap_host: env.IMAP_HOST,
            smtp_host: env.SMTP_HOST,
            default: true,
          },
        ],
      })
  );

  // ── email://templates ────────────────────────────────────────────────
  server.resource(
    "templates",
    "email://templates",
    {
      description:
        "Reusable email templates (acknowledge, decline, follow-up, intro, out-of-office) — text only, fill in placeholders before sending.",
      mimeType: "application/json",
    },
    async (uri) => jsonContent(uri, { templates: BUILTIN_TEMPLATES })
  );

  // ── email://scheduled ────────────────────────────────────────────────
  // Honest empty list: scheduled sending is on the Tier 3 roadmap and is
  // not yet implemented. Resource is present so clients can poll without
  // erroring.
  server.resource(
    "scheduled",
    "email://scheduled",
    {
      description:
        "Scheduled (deferred-send) emails. Returns an empty list until scheduled sending lands (roadmap Tier 3).",
      mimeType: "application/json",
    },
    async (uri) =>
      jsonContent(uri, {
        scheduled: [],
        note: "Scheduled sending is not yet implemented. Tracked on the v3 roadmap (Tier 3).",
      })
  );

  // ── email://{account}/unread ────────────────────────────────────────
  server.resource(
    "unread",
    new ResourceTemplate("email://{account}/unread", { list: undefined }),
    {
      description: "Unread messages in INBOX for the given account (most recent 20).",
      mimeType: "application/json",
    },
    async (uri, { account }) => {
      const acct = String(account);
      if (!accountMatches(env, acct)) return unknownAccount(uri, env, acct);

      const result = await withImap(imapConfig(env), async (c) => {
        const { exists } = await c.select("INBOX");
        if (exists === 0) return { account: acct, total: 0, messages: [] };
        const uids = await c.uidSearch("UNSEEN");
        if (uids.length === 0) return { account: acct, total: 0, messages: [] };
        const subset = uids.slice(-20);
        const messages = await c.uidFetchHeaders(subset);
        messages.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        return { account: acct, total: uids.length, showing: messages.length, messages };
      });
      return jsonContent(uri, result);
    }
  );

  // ── email://{account}/mailboxes ─────────────────────────────────────
  server.resource(
    "mailboxes",
    new ResourceTemplate("email://{account}/mailboxes", { list: undefined }),
    {
      description: "All IMAP mailbox folders for the given account.",
      mimeType: "application/json",
    },
    async (uri, { account }) => {
      const acct = String(account);
      if (!accountMatches(env, acct)) return unknownAccount(uri, env, acct);

      const folders = await withImap(imapConfig(env), (c) => c.list());
      return jsonContent(uri, { account: acct, folders });
    }
  );

  // ── email://{account}/stats ─────────────────────────────────────────
  server.resource(
    "stats",
    new ResourceTemplate("email://{account}/stats", { list: undefined }),
    {
      description:
        "Index stats for the given account: total indexed, per-folder counts, top senders, last sync time.",
      mimeType: "application/json",
    },
    async (uri, { account }) => {
      const acct = String(account);
      if (!accountMatches(env, acct)) return unknownAccount(uri, env, acct);

      const totalRow = await env.DB
        .prepare("SELECT COUNT(*) as cnt FROM emails")
        .first<{ cnt: number }>();
      const perFolder = await env.DB
        .prepare("SELECT folder, COUNT(*) as cnt FROM emails GROUP BY folder ORDER BY cnt DESC")
        .all<{ folder: string; cnt: number }>();
      const topSenders = await env.DB
        .prepare(
          "SELECT sender, COUNT(*) as cnt FROM emails WHERE sender IS NOT NULL GROUP BY sender ORDER BY cnt DESC LIMIT 10"
        )
        .all<{ sender: string; cnt: number }>();
      const lastSync = await env.DB
        .prepare(
          "SELECT folder, last_sync_at FROM folder_state ORDER BY last_sync_at DESC LIMIT 1"
        )
        .first<{ folder: string; last_sync_at: string }>();

      return jsonContent(uri, {
        account: acct,
        total_indexed: totalRow?.cnt ?? 0,
        per_folder: perFolder.results,
        top_senders: topSenders.results,
        last_sync_at: lastSync?.last_sync_at ?? null,
        last_sync_folder: lastSync?.folder ?? null,
      });
    }
  );
}

// ── built-in email templates ───────────────────────────────────────────

const BUILTIN_TEMPLATES = [
  {
    name: "acknowledge",
    subject: "Re: {{original_subject}}",
    body: "Hi {{name}},\n\nThanks — got it. I'll {{action}} by {{deadline}}.\n\n{{your_name}}",
  },
  {
    name: "decline_meeting",
    subject: "Re: {{meeting_title}}",
    body: "Hi {{name}},\n\nThanks for the invite. I won't be able to make {{meeting_title}}. {{reason}}\n\n{{alt_proposal_or_blank}}\n\n{{your_name}}",
  },
  {
    name: "follow_up",
    subject: "Following up: {{topic}}",
    body: "Hi {{name}},\n\nCircling back on {{topic}} — wanted to check whether you've had a chance to look at this. Happy to jump on a quick call if it's easier.\n\n{{your_name}}",
  },
  {
    name: "intro",
    subject: "Intro: {{person_a}} <> {{person_b}}",
    body: "Hi {{person_a}}, {{person_b}} — making a quick intro.\n\n{{person_a}}, meet {{person_b}}: {{person_b_blurb}}.\n{{person_b}}, meet {{person_a}}: {{person_a_blurb}}.\n\nI'll let you two take it from here.\n\n{{your_name}}",
  },
  {
    name: "out_of_office",
    subject: "Out of office until {{return_date}}",
    body: "Thanks for your message. I'm out of office until {{return_date}} with limited email access. For urgent matters, please reach {{backup_contact}}. Otherwise I'll respond when I'm back.\n\n{{your_name}}",
  },
  {
    name: "thank_you",
    subject: "Thank you — {{topic}}",
    body: "Hi {{name}},\n\nJust a quick note to say thank you for {{specific_thing}}. {{personal_detail}}\n\n{{your_name}}",
  },
];
