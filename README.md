# Epistole — IMAP/SMTP Email MCP Server

*Epistole* (ἐπιστολή) — Greek for "letter" or "epistle," the root of the English word *epistle*.

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

### Quick Install (Recommended)

1. Download `epistole.mcpb` from the [latest release](https://github.com/Phantazein-apps/epistole/releases/latest)
2. Double-click the file — Claude Desktop opens and prompts for your settings
3. Fill in your email provider details (see table below)
4. Done — start chatting with Claude about your email

### Configuration

You'll be prompted for these fields during installation. All values are stored securely in your OS keychain.

| Field | Example | Notes |
|-------|---------|-------|
| Email Address | `you@example.com` | Your full email address |
| Full Name | `Your Name` | Appears in the From header of sent emails |
| IMAP Host | `imap.migadu.com` | Your provider's IMAP server |
| IMAP Port | `993` | Default for TLS — rarely needs changing |
| SMTP Host | `smtp.migadu.com` | Your provider's SMTP server |
| SMTP Port | `465` | Default for SSL — rarely needs changing |
| Username | `you@example.com` | Usually same as email address |
| Password | ••••••••• | App password recommended (see below) |

### Provider Quick Reference

| Provider | IMAP Host | SMTP Host | Notes |
|----------|-----------|-----------|-------|
| **Migadu** | `imap.migadu.com` | `smtp.migadu.com` | Use full email as username |
| **Fastmail** | `imap.fastmail.com` | `smtp.fastmail.com` | App password required |
| **Gmail** | `imap.gmail.com` | `smtp.gmail.com` | [App password](https://myaccount.google.com/apppasswords) required |
| **Outlook/Hotmail** | `outlook.office365.com` | `smtp.office365.com` | Port 587 for SMTP |
| **Yahoo** | `imap.mail.yahoo.com` | `smtp.mail.yahoo.com` | App password required |
| **ProtonMail** | `127.0.0.1` | `127.0.0.1` | Requires [ProtonMail Bridge](https://proton.me/mail/bridge) running locally |
| **iCloud** | `imap.mail.me.com` | `smtp.mail.me.com` | App password required |

> **Tip:** Most providers require an **app-specific password** rather than your main account password. Check your provider's security settings to generate one.

## Compatibility

Works with any IMAP/SMTP email provider: Migadu, Fastmail, Gmail (app passwords), Outlook, Yahoo, ProtonMail Bridge, etc.

## Development

```bash
npm install
node index.js  # Runs as stdio MCP server
```

## License

MIT
