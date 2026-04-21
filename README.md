# Epistole — Email MCP Server

*Epistole* (ἐπιστολή) — Greek for "letter" or "epistle."

A **remote MCP server** that connects Claude to your email over IMAP/SMTP, with semantic search powered by Cloudflare's AI stack. Runs as a single Cloudflare Worker — nothing installed locally.

Unlike local email MCP servers, Epistole runs in the cloud: it syncs continuously (not just when your laptop is open), works from any device including mobile, and never stores email data on your machine. Your own Cloudflare account, your own Worker, your own data.

## Install

You need a [Cloudflare account](https://dash.cloudflare.com/sign-up) (free) and [Node.js](https://nodejs.org). Then:

```bash
curl -fsSL https://raw.githubusercontent.com/Phantazein-apps/epistole/master/install.sh | bash
```

The installer will:
1. Check dependencies and log you into Cloudflare if needed
2. Ask for your email provider (Migadu, Gmail, Fastmail, etc.), address, and password
3. Validate your IMAP credentials before proceeding
4. Create all Cloudflare resources (D1, R2, Vectorize)
5. Set credentials as encrypted Worker secrets
6. Optionally configure a custom domain (e.g. `mail.yourdomain.com`)
7. Deploy the Worker
8. Configure Claude Desktop automatically
9. Show connection details for any other MCP client

After it finishes, restart Claude Desktop and ask Claude to show your emails.

## Architecture

```
Claude Desktop → mcp-remote → Cloudflare Worker (/mcp)
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                Workers AI      Vectorize          D1
              (embeddings)    (vector search)   (metadata)
                    │                               │
                   R2                          IMAP / SMTP
              (attachments)                (your email server)
```

All email data stays in your own Cloudflare account. No third-party services. $0/month on the free tier for personal use.

## Tools (14)

### Live IMAP/SMTP

| Tool | Description |
|------|-------------|
| `read_inbox` | List recent messages from any folder |
| `search_messages` | Search by sender, recipient, subject, body, date |
| `get_message` | Full message content with text, HTML, attachments |
| `send_message` | Compose and send new emails |
| `reply_to_message` | Reply or reply-all with proper threading |
| `list_folders` | List all mailbox folders |
| `mark_read` / `mark_unread` | Toggle read status |
| `move_message` | Move messages between folders |

### Semantic Search

| Tool | Description |
|------|-------------|
| `semantic_search` | Find emails by meaning using vector search |
| `get_attachments` | Serve attachments from R2 (no IMAP call) |
| `sync_now` | Trigger an immediate sync cycle |
| `sync_status` | Check progress, per-folder stats, errors |
| `find_by_thread` | Find thread by Message-ID or subject |

## Manual Deploy

If you prefer not to use the one-liner, or it doesn't work on your platform:

```bash
git clone https://github.com/Phantazein-apps/epistole
cd epistole
npm install
./setup.sh                          # creates D1, R2, Vectorize
npx wrangler secret put IMAP_HOST   # repeat for all 11 secrets
npx wrangler deploy
```

Then add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://email-mcp.YOUR-SUBDOMAIN.workers.dev/mcp",
        "--header",
        "Authorization: Bearer YOUR_MCP_TOKEN"
      ]
    }
  }
}
```

## Provider Quick Reference

| Provider | IMAP Host | SMTP Host | Notes |
|----------|-----------|-----------|-------|
| **Migadu** | `imap.migadu.com` | `smtp.migadu.com` | Full email as username |
| **Fastmail** | `imap.fastmail.com` | `smtp.fastmail.com` | App password required |
| **Gmail** | `imap.gmail.com` | `smtp.gmail.com` | [App password](https://myaccount.google.com/apppasswords) required |
| **Outlook** | `outlook.office365.com` | `smtp.office365.com` | Port 587 for SMTP |
| **Yahoo** | `imap.mail.yahoo.com` | `smtp.mail.yahoo.com` | App password required |
| **iCloud** | `imap.mail.me.com` | `smtp.mail.me.com` | App password required |

## How Sync Works

A cron trigger runs every 15 minutes:

1. Connects to IMAP, checks each folder for new messages (by UID)
2. Fetches new messages (headers + first 20KB of body), stores metadata in D1
3. Generates embeddings via Workers AI (`bge-base-en-v1.5`)
4. Upserts vectors into Vectorize for semantic search
5. Handles UIDVALIDITY changes (server rebuild) by re-indexing

First sync after deployment: call `sync_now` to bootstrap. Subsequent syncs are automatic.

### Sync budget

Each sync run processes up to **200 messages** across all folders (configurable via `MAX_MESSAGES_PER_INVOCATION` in `src/sync/incremental.ts`). This cap exists because Cloudflare Workers have a 30-second CPU time limit on cron triggers. At 200 messages per run and a cron every 15 minutes, the system indexes up to ~19,200 messages/day — enough to keep up with any normal mailbox.

If you have a very large mailbox (50K+ messages), the first full index may take several hours to catch up. During this period, **semantic search is automatically disabled** — it returns an `index_incomplete` error and tells Claude to use `search_messages` (live IMAP search) instead. This prevents stale or misleading results. Once the index reaches 90% of the server-side message count, semantic search re-enables itself.

Folders are synced in priority order: INBOX first, then Sent, Archive, and the rest alphabetically. This ensures your most important mail is searchable first.

## Status Dashboard

Visit `https://<your-worker>/status` (e.g. `https://email-mcp.your-subdomain.workers.dev/status` or `https://mail.yourdomain.com/status`) to check sync progress anytime. The page is protected by the same email verification flow — you'll need to enter a one-time code sent to your inbox. No login or password required.

## Security

- **Credentials** stored as Worker secrets (encrypted at rest, never in code or logs)
- **MCP endpoint** protected by bearer token authentication
- **Single-tenant** — each user deploys their own Worker, no shared infrastructure
- **No local data** — everything lives in your Cloudflare account

## Cost

| Service | Free tier | Typical personal use |
|---------|-----------|---------------------|
| Workers | 100K req/day | ~2K req/day |
| D1 | 5GB, 5M reads/day | <1MB |
| Workers AI | 10K neurons/day | ~6K neurons/mo |
| Vectorize | 30M queried dims/mo | ~8M stored dims |
| R2 | 10GB, 1M ops/mo | depends on attachments |

**Personal use: $0/month.** Heavy use (50K+ messages, constant searching): ~$5–8/month (Workers Paid plan base).

## Comparison to other email MCP servers

*Last updated: April 21, 2026*

Compared to `yunfeizhu/mcp-mail-server`, `ai-zerolab/mcp-email-server`, `codefuturist/email-mcp`, Improvado, and Gmail/Outlook MCP:

- **Persisted semantic search over the archive** (Vectorize + `bge-base-en-v1.5`). No open-source IMAP/SMTP MCP ships this; competitors do IMAP `SEARCH` plus AI-on-fetch.
- **Remote MCP, claude.ai web and mobile compatible** via Streamable HTTP + bearer token. Local stdio competitors can't be used outside Claude Desktop.
- **User-owned single-tenant deploy.** Your Cloudflare account, your D1, your Vectorize. Improvado is hosted but multi-tenant SaaS holding your credentials; everyone else is local-only.
- **Always-on background sync** every 15 min via cron. Inbox stays searchable when your laptop is off.
- **R2-cached attachments** served without an IMAP round-trip.
- **Provider-agnostic IMAP/SMTP** (Gmail, Outlook, Migadu, Fastmail, self-hosted Dovecot, anything RFC 3501). Gmail/Outlook MCPs lock you to one OAuth provider.
- **$0/month** on Cloudflare free tier for personal use.

### Trade-offs

- Tool surface is narrower than `codefuturist/email-mcp` (14 vs 47 tools): no multi-account, no scheduling, no calendar extraction, no IDLE-based real-time triage.
- Setup is heavier than an npx one-liner: 6 commands + 11 secrets + a Cloudflare account.
- No Docker image, no `.mcpb` bundle, no install wizard yet.

## License

MIT
