# Epistole — IMAP/SMTP Email MCP Server

*Epistole* (ἐπιστολή) — Greek for "letter" or "epistle," the root of the English word *epistle*.

An MCP server that connects Claude to your email account over standard IMAP and SMTP protocols, with **local semantic search** powered by ChromaDB and model2vec. Packaged as an `.mcpb` bundle for one-click installation in Claude Desktop.

## Features

### Live IMAP/SMTP tools

- **read_inbox** — List recent messages from any folder
- **search_messages** — Search by sender, recipient, subject, body, date, read status
- **get_message** — Full message content with text, HTML, and attachment list
- **send_message** — Compose and send new emails
- **reply_to_message** — Reply (or reply-all) with proper threading headers
- **list_folders** — List all mailbox folders
- **mark_read / mark_unread** — Toggle read status
- **move_message** — Move messages between folders

### Semantic search (v2)

- **semantic_search** — Find emails by meaning, not just keywords. Searches across subject, body, and extracted PDF attachment text.
- **get_attachments** — List attachments from local disk (fast, never calls IMAP)
- **sync_now** — Trigger an immediate mailbox sync
- **sync_status** — Check sync progress, per-folder stats, and errors
- **find_by_thread** — Find all messages in a thread by Message-ID or subject

## Installation

### One-click install (Claude Desktop)

1. Download `epistole.mcpb` from the [latest release](https://github.com/Phantazein-apps/epistole/releases/latest)
2. Double-click the file — Claude Desktop opens and prompts for your settings
3. Fill in your email provider details (see table below)
4. Done — start chatting with Claude about your email

### Developer install

```bash
git clone https://github.com/Phantazein-apps/epistole
cd epistole
uv sync
uv run mcp_server.py
```

Or with environment variables:

```bash
export IMAP_HOST=imap.migadu.com
export IMAP_USERNAME=you@example.com
export IMAP_PASSWORD=your-password
export SMTP_HOST=smtp.migadu.com
export SMTP_USERNAME=you@example.com
export SMTP_PASSWORD=your-password
export EMAIL_ADDRESS=you@example.com
export FULL_NAME="Your Name"
uv run mcp_server.py
```

## Configuration

All values are stored securely in your OS keychain when installed via `.mcpb`.

| Field | Example | Notes |
|-------|---------|-------|
| Email Address | `you@example.com` | Your full email address |
| Full Name | `Your Name` | Appears in the From header of sent emails |
| IMAP Host | `imap.migadu.com` | Your provider's IMAP server |
| IMAP Port | `993` | Default for TLS — rarely needs changing |
| IMAP Username | `you@example.com` | Usually same as email address |
| IMAP Password | ••••••••• | App password recommended |
| SMTP Host | `smtp.migadu.com` | Your provider's SMTP server |
| SMTP Port | `465` | Default for SSL — rarely needs changing |
| SMTP Username | `you@example.com` | Usually same as email address |
| SMTP Password | ••••••••• | App password recommended |
| Sync Folders | *(empty)* | Comma-separated; empty = all folders |
| Sync Interval | `15` | Minutes between background polls |

### Provider Quick Reference

| Provider | IMAP Host | SMTP Host | Notes |
|----------|-----------|-----------|-------|
| **Migadu** | `imap.migadu.com` | `smtp.migadu.com` | Use full email as username |
| **Fastmail** | `imap.fastmail.com` | `smtp.fastmail.com` | App password required |
| **Gmail** | `imap.gmail.com` | `smtp.gmail.com` | [App password](https://myaccount.google.com/apppasswords) required |
| **Outlook/Hotmail** | `outlook.office365.com` | `smtp.office365.com` | Port 587 for SMTP |
| **Yahoo** | `imap.mail.yahoo.com` | `smtp.mail.yahoo.com` | App password required |
| **ProtonMail** | `127.0.0.1` | `127.0.0.1` | Requires [ProtonMail Bridge](https://proton.me/mail/bridge) |
| **iCloud** | `imap.mail.me.com` | `smtp.mail.me.com` | App password required |

## Sync Behavior

On startup, Epistole spawns a background task that:

1. Connects to IMAP and lists folders (or uses `EPISTOLE_SYNC_FOLDERS` if set)
2. For each folder, checks UIDVALIDITY and fetches new messages since the last sync
3. Saves attachments to `~/.epistole/attachments/<account>/<year>/<month>/`
4. Extracts text from digital PDFs (scanned PDFs are logged but not OCR'd)
5. Indexes messages into a local ChromaDB vector database
6. Sleeps for the configured interval, then repeats

The first sync may take a while depending on your mailbox size. The embedding model (~30MB) is downloaded on first run.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `EPISTOLE_DATA_DIR` | `~/.epistole` | Base directory for all local data |
| `EPISTOLE_SYNC_FOLDERS` | *(all)* | CSV of folders to sync |
| `EPISTOLE_SYNC_INTERVAL_MINUTES` | `15` | Polling interval |
| `EPISTOLE_EMBEDDING_MODEL` | `minishlab/potion-base-8M` | model2vec model name |
| `EPISTOLE_MAX_BODY_CHARS` | `32000` | Max chars per document for embedding |
| `EPISTOLE_AUTO_SYNC` | `true` | Set `false` to disable background sync |

## Troubleshooting

### Sync is stuck or not starting

Check `sync_status` — it shows whether a sync is running, recent errors, and per-folder progress. Common issues:

- **Wrong credentials** — verify IMAP login works with another client
- **Firewall** — ensure port 993 (IMAP) is reachable
- **Folder name encoding** — some servers use non-ASCII folder names; set `EPISTOLE_SYNC_FOLDERS` explicitly

### Force a full re-index

```
sync_now(full=True)
```

This drops the existing index and re-syncs all messages from scratch. Useful after upgrading Epistole or changing the embedding model.

### Wipe all local data

```bash
rm -rf ~/.epistole
```

This removes the vector database, attachments, sync state, and logs. The next sync will rebuild everything.

### Where does data live?

```
~/.epistole/
├── chroma/                      # Vector database
├── attachments/<account>/<yyyy>/<mm>/  # Saved attachments
├── models/                      # Embedding model cache
├── state.db                     # Per-folder sync state (SQLite)
└── sync.log                     # Rotating log file
```

## Upgrading from v1

v1 was a Node.js server. v2 is a complete rewrite in Python with semantic search. To upgrade:

1. Uninstall the old bundle from Claude Desktop
2. Download and install the new `epistole.mcpb`
3. Re-enter your credentials (they're stored in the keychain under a new key)
4. After the server starts, run `sync_now(full=True)` to bootstrap the search index

## License

MIT
