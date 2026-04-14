"""FastMCP server — registers all tools and manages the sync lifecycle."""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

from .config import Config, load_config
from .index import VectorIndex
from .sync import SyncProgress, progress, run_sync, sync_loop
from . import imap_client, smtp_client

# ── globals initialised lazily ──────────────────────────────────────────────

_cfg: Config | None = None
_index: VectorIndex | None = None
_sync_task: asyncio.Task | None = None


def _get_cfg() -> Config:
    global _cfg
    if _cfg is None:
        _cfg = load_config()
    return _cfg


def _get_index() -> VectorIndex:
    global _index
    if _index is None:
        _index = VectorIndex(_get_cfg())
    return _index


def _ensure_sync_started() -> None:
    """Start the background sync loop if not already running."""
    global _sync_task
    cfg = _get_cfg()
    if _sync_task is None and cfg.auto_sync and cfg.imap_configured:
        _sync_task = asyncio.create_task(sync_loop(cfg, _get_index()))


def _not_configured(what: str = "IMAP") -> dict[str, Any]:
    return {"error": f"{what} credentials not configured. Please set the required environment variables."}


# ── MCP server ──────────────────────────────────────────────────────────────

mcp = FastMCP("epistole")


# ── existing tools (backward-compatible wire format) ────────────────────────

@mcp.tool()
async def read_inbox(folder: str = "INBOX", limit: int = 20) -> str:
    """List recent messages from a mailbox folder.

    Returns message summaries (uid, date, from, to, subject, flags).
    """
    _ensure_sync_started()
    cfg = _get_cfg()
    if not cfg.imap_configured:
        return json.dumps(_not_configured())
    result = await imap_client.read_inbox(cfg, folder, limit)
    return json.dumps(result, default=str)


@mcp.tool()
async def search_messages(
    folder: str = "INBOX",
    from_: str | None = None,
    to: str | None = None,
    subject: str | None = None,
    body: str | None = None,
    since: str | None = None,
    before: str | None = None,
    unseen: bool = False,
    limit: int = 20,
) -> str:
    """Search messages using IMAP search criteria.

    Supports searching by from, to, subject, body text, date ranges, and flags.
    """
    _ensure_sync_started()
    cfg = _get_cfg()
    if not cfg.imap_configured:
        return json.dumps(_not_configured())
    result = await imap_client.search_messages(
        cfg, folder, from_=from_, to=to, subject=subject,
        body=body, since=since, before=before, unseen=unseen, limit=limit,
    )
    return json.dumps(result, default=str)


@mcp.tool()
async def get_message(uid: int, folder: str = "INBOX") -> str:
    """Get the full content of a specific message by UID.

    Includes plain text body, HTML body, and attachment list.
    For large messages with attachments, consider using get_attachments instead.
    """
    _ensure_sync_started()
    cfg = _get_cfg()
    if not cfg.imap_configured:
        return json.dumps(_not_configured())
    result = await imap_client.get_message(cfg, uid, folder)
    return json.dumps(result, default=str)


@mcp.tool()
async def send_message(
    to: str,
    subject: str,
    body: str,
    cc: str | None = None,
    bcc: str | None = None,
) -> str:
    """Compose and send a new email message."""
    cfg = _get_cfg()
    if not cfg.smtp_configured:
        return json.dumps(_not_configured("SMTP"))
    result = await smtp_client.send_message(cfg, to, subject, body, cc, bcc)
    return json.dumps(result, default=str)


@mcp.tool()
async def reply_to_message(
    uid: int,
    body: str,
    folder: str = "INBOX",
    reply_all: bool = False,
) -> str:
    """Reply to an existing email message.

    Fetches the original to set In-Reply-To, References, and quoted text.
    """
    cfg = _get_cfg()
    if not cfg.imap_configured:
        return json.dumps(_not_configured())
    if not cfg.smtp_configured:
        return json.dumps(_not_configured("SMTP"))
    original = await imap_client.get_message(cfg, uid, folder)
    result = await smtp_client.reply_to_message(cfg, original, body, reply_all)
    return json.dumps(result, default=str)


@mcp.tool()
async def list_folders() -> str:
    """List all available mailbox folders/labels."""
    _ensure_sync_started()
    cfg = _get_cfg()
    if not cfg.imap_configured:
        return json.dumps(_not_configured())
    result = await imap_client.list_folders(cfg)
    return json.dumps(result, default=str)


@mcp.tool()
async def mark_read(uid: int, folder: str = "INBOX") -> str:
    """Mark a message as read (add \\Seen flag)."""
    cfg = _get_cfg()
    if not cfg.imap_configured:
        return json.dumps(_not_configured())
    result = await imap_client.mark_message(cfg, uid, folder, "\\Seen", add=True)
    return json.dumps(result, default=str)


@mcp.tool()
async def mark_unread(uid: int, folder: str = "INBOX") -> str:
    """Mark a message as unread (remove \\Seen flag)."""
    cfg = _get_cfg()
    if not cfg.imap_configured:
        return json.dumps(_not_configured())
    result = await imap_client.mark_message(cfg, uid, folder, "\\Seen", add=False)
    return json.dumps(result, default=str)


@mcp.tool()
async def move_message(uid: int, destination: str, folder: str = "INBOX") -> str:
    """Move a message to a different folder."""
    cfg = _get_cfg()
    if not cfg.imap_configured:
        return json.dumps(_not_configured())
    result = await imap_client.move_message(cfg, uid, folder, destination)
    return json.dumps(result, default=str)


# ── new v2 tools ────────────────────────────────────────────────────────────

@mcp.tool()
async def semantic_search(
    query: str,
    folders: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    sender: str | None = None,
    has_attachment: bool | None = None,
    limit: int = 10,
) -> str:
    """Search emails by meaning using semantic vector search.

    Finds messages whose content is semantically similar to the query,
    even if exact keywords don't match. Searches across subject, body,
    and extracted PDF attachment text.

    Args:
        query: Natural language search query
        folders: Comma-separated folder names to restrict search
        date_from: ISO date (YYYY-MM-DD) — only messages on or after
        date_to: ISO date (YYYY-MM-DD) — only messages on or before
        sender: Filter by sender address or name
        has_attachment: Filter to messages with/without attachments
        limit: Maximum results (default 10)
    """
    _ensure_sync_started()
    idx = _get_index()

    # Build Chroma where-filter
    conditions: list[dict[str, Any]] = []
    if folders:
        folder_list = [f.strip() for f in folders.split(",")]
        if len(folder_list) == 1:
            conditions.append({"folder": folder_list[0]})
        else:
            conditions.append({"folder": {"$in": folder_list}})
    if date_from:
        conditions.append({"date_iso": {"$gte": date_from}})
    if date_to:
        conditions.append({"date_iso": {"$lte": date_to}})
    if sender:
        conditions.append({"from": {"$contains": sender}})
    if has_attachment is True:
        conditions.append({"has_attachments": True})
    elif has_attachment is False:
        conditions.append({"has_attachments": False})

    where: dict[str, Any] | None = None
    if len(conditions) == 1:
        where = conditions[0]
    elif len(conditions) > 1:
        where = {"$and": conditions}

    results = idx.query(query, n_results=limit, where=where)

    # Format output
    messages = []
    for r in results:
        messages.append({
            "uid": r.get("uid"),
            "folder": r.get("folder"),
            "date": r.get("date_iso"),
            "from": r.get("from"),
            "subject": r.get("subject"),
            "snippet": r.get("snippet", ""),
            "attachment_count": r.get("attachment_count", 0),
            "score": r.get("score", 0),
        })

    output: dict[str, Any] = {"query": query, "total": len(messages), "messages": messages}

    # Prepend sync banner if running
    banner = progress.banner
    if banner:
        output["_notice"] = banner

    return json.dumps(output, default=str)


@mcp.tool()
async def get_attachments(uid: int, folder: str = "INBOX") -> str:
    """List attachments for a message, served from local disk.

    Returns file metadata including local_path that can be read directly.
    Much faster than get_message for messages with large attachments,
    as it never calls IMAP if the attachment is already synced.

    Args:
        uid: Message UID
        folder: Mailbox folder (default INBOX)
    """
    cfg = _get_cfg()
    idx = _get_index()

    # Look up metadata from index
    docs = idx.get_by_metadata({"uid": uid, "folder": folder}, limit=1)
    if not docs:
        return json.dumps({"error": f"Message UID {uid} in {folder} not found in index. Run sync_now first."})

    meta = docs[0]
    filenames = meta.get("attachment_filenames", [])
    if not filenames:
        return json.dumps({"uid": uid, "folder": folder, "attachments": []})

    date_iso = meta.get("date_iso", "")
    if date_iso and len(date_iso) >= 7:
        year = date_iso[:4]
        month = date_iso[5:7]
    else:
        year = "unknown"
        month = "00"

    attachments = []
    for name in filenames:
        att_path = cfg.attachments_dir / year / month / f"{uid}-{name}"
        if att_path.exists():
            attachments.append({
                "filename": name,
                "mime": _guess_mime(name),
                "size": att_path.stat().st_size,
                "local_path": str(att_path),
            })
        else:
            attachments.append({
                "filename": name,
                "mime": _guess_mime(name),
                "size": None,
                "local_path": None,
                "note": "Not yet synced to disk",
            })

    return json.dumps({"uid": uid, "folder": folder, "attachments": attachments})


def _guess_mime(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    mapping = {
        ".pdf": "application/pdf",
        ".doc": "application/msword",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xls": "application/vnd.ms-excel",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".zip": "application/zip",
        ".csv": "text/csv",
        ".txt": "text/plain",
        ".html": "text/html",
    }
    return mapping.get(ext, "application/octet-stream")


@mcp.tool()
async def sync_now(folders: str | None = None, full: bool = False) -> str:
    """Trigger an immediate sync cycle.

    Returns immediately with a job ID; sync runs in the background.

    Args:
        folders: Comma-separated folder names (default: all configured)
        full: If true, ignore last_uid and re-index everything
    """
    cfg = _get_cfg()
    if not cfg.imap_configured:
        return json.dumps(_not_configured())

    idx = _get_index()
    folder_list = [f.strip() for f in folders.split(",") if f.strip()] if folders else None
    job_id = str(uuid.uuid4())[:8]

    asyncio.create_task(run_sync(cfg, idx, full=full, folders=folder_list))

    return json.dumps({
        "job_id": job_id,
        "status": "started",
        "full": full,
        "folders": folder_list or "all",
    })


@mcp.tool()
async def sync_status() -> str:
    """Check the current state of the email sync process.

    Returns sync timing, per-folder stats, progress (if running), and recent errors.
    """
    _ensure_sync_started()
    idx = _get_index()

    result: dict[str, Any] = {
        "last_full_sync": progress.last_full_sync,
        "last_incremental": progress.last_incremental,
        "next_scheduled": progress.next_scheduled,
        "currently_syncing": progress.running,
        "indexed_total": idx.count,
    }

    if progress.running:
        result["sync_progress"] = {
            "folder": progress.current_folder,
            "processed": progress.processed,
            "total": progress.total,
            "percent": progress.percent,
        }

    result["folders"] = progress.folder_stats
    result["recent_errors"] = progress.recent_errors[-5:]

    return json.dumps(result, default=str)


@mcp.tool()
async def find_by_thread(message_id_or_subject: str) -> str:
    """Find all messages in an email thread.

    Searches by Message-ID, In-Reply-To header, or subject line.
    Cheaper than IMAP THREAD as it uses the local index.

    Args:
        message_id_or_subject: A Message-ID header value or subject to search by
    """
    _ensure_sync_started()
    idx = _get_index()

    query = message_id_or_subject.strip()
    results: list[dict[str, Any]] = []

    # Try by message_id
    found = idx.get_by_metadata({"message_id": query})
    results.extend(found)

    # Try by in_reply_to
    found = idx.get_by_metadata({"in_reply_to": query})
    for f in found:
        if f not in results:
            results.append(f)

    # Also search for messages replying to any found message_ids
    seen_ids = {r.get("message_id") for r in results if r.get("message_id")}
    for mid in list(seen_ids):
        if mid:
            more = idx.get_by_metadata({"in_reply_to": mid})
            for m in more:
                if m.get("message_id") not in seen_ids:
                    results.append(m)
                    seen_ids.add(m.get("message_id"))

    # If no results by ID, try subject match
    if not results:
        found = idx.get_by_metadata({"subject": query})
        results.extend(found)

    # Format
    messages = []
    for r in results:
        messages.append({
            "uid": r.get("uid"),
            "folder": r.get("folder"),
            "date": r.get("date_iso"),
            "from": r.get("from"),
            "to": r.get("to"),
            "subject": r.get("subject"),
            "message_id": r.get("message_id"),
            "in_reply_to": r.get("in_reply_to"),
        })

    # Sort by date
    messages.sort(key=lambda m: m.get("date") or "")

    return json.dumps({"query": query, "thread_length": len(messages), "messages": messages}, default=str)


# ── entry point ─────────────────────────────────────────────────────────────

def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
