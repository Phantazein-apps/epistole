# Epistole — IMAP/SMTP Email MCP Server

An MCP server that connects Claude to your email account over standard IMAP and SMTP protocols. Packaged as an `.mcpb` bundle for one-click installation in Claude Desktop.

## Features

- **read_inbox** — List recent messages from any folder
- **search_messages** — Search by sender, recipient, subject, body, date, read status
- **get_message** — Full message content with text, HTML, and attachment list
- **send_message** — Compose and send new emails
- **reply_to_message** — Reply (or reply-all) with proper threading headers
- **list_folders** — List all mailbox folders
- **mark_read / mark_unread** — Toggle read status
- **move_message** — Move messages between folders

## Installation

Double-click `email.mcpb` to install in Claude Desktop. You'll be prompted for:

| Field | Example |
|-------|---------|
| Email Address | `you@example.com` |
| Full Name | `Your Name` |
| IMAP Host | `imap.migadu.com` |
| IMAP Port | `993` |
| SMTP Host | `smtp.migadu.com` |
| SMTP Port | `465` |
| Username | `you@example.com` |
| Password | your email password |

Your password is stored in the OS keychain, never in plain text.

## Compatibility

Works with any IMAP/SMTP email provider: Migadu, Fastmail, Gmail (app passwords), Outlook, Yahoo, ProtonMail Bridge, etc.

## Development

```bash
npm install
node index.js  # Runs as stdio MCP server
```

## License

MIT
