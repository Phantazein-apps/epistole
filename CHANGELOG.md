# Changelog

## v2.0.0

### Added

- **Semantic search** — `semantic_search` tool finds emails by meaning, not just keywords. Searches across subject, body, and extracted PDF text.
- **Local sync layer** — Background task incrementally polls IMAP folders and indexes messages into a local ChromaDB vector database. Configurable interval (default 15 minutes).
- **Attachment management** — `get_attachments` returns file metadata from local disk, avoiding IMAP timeouts on large messages. Attachments are saved during sync to `~/.epistole/attachments/`.
- **PDF text extraction** — Digital PDFs are automatically extracted with pypdf during sync and included in the search index. Scanned PDFs are logged but not OCR'd (planned for v2.1).
- **Thread search** — `find_by_thread` finds all messages in a conversation by Message-ID or In-Reply-To headers.
- **Sync control** — `sync_now` triggers an immediate sync (with optional `full=True` for re-indexing). `sync_status` shows progress, per-folder stats, and recent errors.
- **UIDVALIDITY handling** — If a folder's UIDVALIDITY changes (server-side rebuild), Epistole automatically drops and re-indexes that folder.
- **Sync-in-progress banner** — `semantic_search` results include a notice when sync is running with completion percentage.

### Changed

- **Rewritten in Python** — Server now uses FastMCP (Python MCP SDK) with UV for dependency management. The Node.js implementation is replaced.
- **Embedding model** — Uses model2vec (`minishlab/potion-base-8M`) for lightweight local embeddings — no torch or onnxruntime required.
- **MCPB server type** — Manifest changed from `node` to `uv` for automatic Python dependency management.
- **Separate IMAP/SMTP credentials** — user_config now has separate username/password fields for IMAP and SMTP (backward-compatible with shared credentials).

### Migration from v1

Existing v1 installations (Node.js) should uninstall the old bundle and install the new `.mcpb`. After configuration, run `sync_now(full=True)` once to bootstrap the search index.

## v1.0.0

Initial release — Node.js IMAP/SMTP MCP server with 9 tools: read_inbox, search_messages, get_message, send_message, reply_to_message, list_folders, mark_read, mark_unread, move_message.
