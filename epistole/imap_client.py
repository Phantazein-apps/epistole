"""Live IMAP operations for the existing MCP tools.

Every public function connects, does its work, and disconnects.
All blocking ``imaplib`` calls are run via ``asyncio.to_thread``.
"""

from __future__ import annotations

import asyncio
import email
import email.header
import email.utils
import imaplib
import re
from contextlib import contextmanager
from email.message import Message
from typing import Any

from .config import Config


# ── connection helper ───────────────────────────────────────────────────────

@contextmanager
def _connect(cfg: Config):
    if not cfg.imap_configured:
        raise RuntimeError("IMAP credentials not configured")
    if cfg.imap_use_ssl:
        conn = imaplib.IMAP4_SSL(cfg.imap_host, cfg.imap_port)
    else:
        conn = imaplib.IMAP4(cfg.imap_host, cfg.imap_port)
    conn.login(cfg.imap_username, cfg.imap_password)
    try:
        yield conn
    finally:
        try:
            conn.logout()
        except Exception:
            pass


def _decode_header(raw: str | None) -> str:
    if not raw:
        return ""
    parts = email.header.decode_header(raw)
    decoded = []
    for data, charset in parts:
        if isinstance(data, bytes):
            decoded.append(data.decode(charset or "utf-8", errors="replace"))
        else:
            decoded.append(data)
    return " ".join(decoded)


def _format_addr(msg: Message, key: str) -> str:
    raw = msg.get(key, "")
    return _decode_header(raw)


def _parse_envelope(raw_bytes: bytes) -> dict[str, Any]:
    """Parse a raw RFC-822 message into a summary dict."""
    msg = email.message_from_bytes(raw_bytes)
    date_tuple = email.utils.parsedate_to_datetime(msg.get("Date", ""))
    date_iso = date_tuple.isoformat() if date_tuple else None

    return {
        "date": date_iso,
        "from": _format_addr(msg, "From"),
        "to": _format_addr(msg, "To"),
        "cc": _format_addr(msg, "Cc"),
        "subject": _decode_header(msg.get("Subject")),
        "messageId": msg.get("Message-ID", ""),
        "inReplyTo": msg.get("In-Reply-To", ""),
        "references": msg.get("References", ""),
    }


def _msg_summary(uid: int, raw: bytes, flags_str: str) -> dict[str, Any]:
    env = _parse_envelope(raw)
    flags = re.findall(r"\\(\w+)", flags_str)
    return {
        "uid": uid,
        "date": env["date"],
        "from": env["from"],
        "to": env["to"],
        "subject": env["subject"],
        "flags": flags,
        "messageId": env["messageId"],
    }


def _extract_text(msg: Message) -> str:
    """Walk a MIME tree and return the first text/plain part."""
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            if ct == "text/plain" and part.get("Content-Disposition") != "attachment":
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    return payload.decode(charset, errors="replace")
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            charset = msg.get_content_charset() or "utf-8"
            return payload.decode(charset, errors="replace")
    return ""


def _extract_html(msg: Message) -> str:
    """Walk a MIME tree and return the first text/html part."""
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            if ct == "text/html" and part.get("Content-Disposition") != "attachment":
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    return payload.decode(charset, errors="replace")
    return ""


def _list_attachments(msg: Message) -> list[dict[str, Any]]:
    atts = []
    for part in msg.walk():
        cd = part.get("Content-Disposition", "")
        if "attachment" in cd or "inline" in cd:
            filename = part.get_filename()
            if filename:
                atts.append({
                    "filename": _decode_header(filename),
                    "contentType": part.get_content_type(),
                    "size": len(part.get_payload(decode=True) or b""),
                })
    return atts


# ── UID parsing helpers ─────────────────────────────────────────────────────

_UID_RE = re.compile(rb"UID (\d+)")
_FLAGS_RE = re.compile(rb"FLAGS \(([^)]*)\)")


def _parse_uid(fetch_line: bytes) -> int:
    m = _UID_RE.search(fetch_line)
    return int(m.group(1)) if m else 0


def _parse_flags(fetch_line: bytes) -> str:
    m = _FLAGS_RE.search(fetch_line)
    return m.group(1).decode() if m else ""


# ── public async API ────────────────────────────────────────────────────────

async def list_folders(cfg: Config) -> list[dict[str, Any]]:
    def _run():
        with _connect(cfg) as conn:
            _status, data = conn.list()
            folders = []
            for line in data:
                if not line:
                    continue
                decoded = line.decode() if isinstance(line, bytes) else line
                # Parse: (flags) "delimiter" "path"
                m = re.match(r'\(([^)]*)\)\s+"([^"]+)"\s+"?([^"]*)"?', decoded)
                if m:
                    flags_str, delimiter, path = m.groups()
                    flags = re.findall(r"\\(\w+)", flags_str)
                    special = None
                    for f in flags:
                        if f in ("Sent", "Drafts", "Junk", "Trash", "Archive", "All"):
                            special = f"\\{f}"
                    folders.append({
                        "path": path.strip('"'),
                        "name": path.strip('"').split(delimiter)[-1] if delimiter else path.strip('"'),
                        "delimiter": delimiter,
                        "flags": flags,
                        "specialUse": special,
                    })
            return folders
    return await asyncio.to_thread(_run)


async def read_inbox(cfg: Config, folder: str = "INBOX", limit: int = 20) -> dict[str, Any]:
    limit = min(max(1, limit), 100)

    def _run():
        with _connect(cfg) as conn:
            conn.select(f'"{folder}"', readonly=True)
            _s, data = conn.search(None, "ALL")
            all_uids_raw = data[0].split() if data[0] else []
            total = len(all_uids_raw)
            if total == 0:
                return {"folder": folder, "total": 0, "messages": []}

            # Take last `limit` UIDs
            subset = all_uids_raw[-limit:]

            # Fetch in one call
            uid_set = b",".join(subset)
            _s, fetch_data = conn.fetch(uid_set, "(UID FLAGS BODY.PEEK[HEADER])")

            messages = []
            i = 0
            while i < len(fetch_data):
                item = fetch_data[i]
                if isinstance(item, tuple) and len(item) == 2:
                    meta_line, header_bytes = item
                    uid = _parse_uid(meta_line)
                    flags_str = _parse_flags(meta_line)
                    if uid:
                        summary = _msg_summary(uid, header_bytes, flags_str)
                        messages.append(summary)
                    i += 1
                else:
                    i += 1

            messages.sort(key=lambda m: m["date"] or "", reverse=True)
            return {"folder": folder, "total": total, "messages": messages[:limit]}

    return await asyncio.to_thread(_run)


async def search_messages(
    cfg: Config,
    folder: str = "INBOX",
    *,
    from_: str | None = None,
    to: str | None = None,
    subject: str | None = None,
    body: str | None = None,
    since: str | None = None,
    before: str | None = None,
    unseen: bool = False,
    limit: int = 20,
) -> dict[str, Any]:
    limit = min(max(1, limit), 100)

    def _run():
        with _connect(cfg) as conn:
            conn.select(f'"{folder}"', readonly=True)
            criteria = []
            if from_:
                criteria.extend(["FROM", f'"{from_}"'])
            if to:
                criteria.extend(["TO", f'"{to}"'])
            if subject:
                criteria.extend(["SUBJECT", f'"{subject}"'])
            if body:
                criteria.extend(["BODY", f'"{body}"'])
            if since:
                criteria.extend(["SINCE", since])
            if before:
                criteria.extend(["BEFORE", before])
            if unseen:
                criteria.append("UNSEEN")
            if not criteria:
                criteria.append("ALL")

            _s, data = conn.search(None, *criteria)
            uids = data[0].split() if data[0] else []
            total = len(uids)
            if total == 0:
                return {"folder": folder, "total": 0, "showing": 0, "messages": []}

            subset = uids[-limit:]
            uid_set = b",".join(subset)
            _s, fetch_data = conn.fetch(uid_set, "(UID FLAGS BODY.PEEK[HEADER])")

            messages = []
            i = 0
            while i < len(fetch_data):
                item = fetch_data[i]
                if isinstance(item, tuple) and len(item) == 2:
                    meta_line, header_bytes = item
                    uid = _parse_uid(meta_line)
                    flags_str = _parse_flags(meta_line)
                    if uid:
                        messages.append(_msg_summary(uid, header_bytes, flags_str))
                    i += 1
                else:
                    i += 1

            messages.sort(key=lambda m: m["date"] or "", reverse=True)
            return {"folder": folder, "total": total, "showing": len(messages), "messages": messages}

    return await asyncio.to_thread(_run)


async def get_message(cfg: Config, uid: int, folder: str = "INBOX") -> dict[str, Any]:
    def _run():
        with _connect(cfg) as conn:
            conn.select(f'"{folder}"', readonly=True)
            _s, data = conn.fetch(str(uid), "(BODY.PEEK[])")
            if not data or data[0] is None:
                raise ValueError(f"Message UID {uid} not found in {folder}")

            raw = data[0][1] if isinstance(data[0], tuple) else data[0]
            msg = email.message_from_bytes(raw)
            env = _parse_envelope(raw)

            return {
                "uid": uid,
                "folder": folder,
                "messageId": env["messageId"],
                "inReplyTo": env["inReplyTo"] or None,
                "references": env["references"] or None,
                "date": env["date"],
                "from": env["from"],
                "to": env["to"],
                "cc": env["cc"],
                "subject": env["subject"],
                "text": _extract_text(msg),
                "html": _extract_html(msg) or None,
                "attachments": _list_attachments(msg),
            }

    return await asyncio.to_thread(_run)


async def mark_message(cfg: Config, uid: int, folder: str, flag: str, add: bool) -> dict[str, Any]:
    def _run():
        with _connect(cfg) as conn:
            conn.select(f'"{folder}"')
            if add:
                conn.store(str(uid), "+FLAGS", f"({flag})")
            else:
                conn.store(str(uid), "-FLAGS", f"({flag})")
            action = "marked_read" if add else "marked_unread"
            return {"success": True, "uid": uid, "folder": folder, "action": action}

    return await asyncio.to_thread(_run)


async def move_message(cfg: Config, uid: int, folder: str, destination: str) -> dict[str, Any]:
    def _run():
        with _connect(cfg) as conn:
            conn.select(f'"{folder}"')
            conn.copy(str(uid), f'"{destination}"')
            conn.store(str(uid), "+FLAGS", "(\\Deleted)")
            conn.expunge()
            return {"success": True, "uid": uid, "from": folder, "to": destination, "action": "moved"}

    return await asyncio.to_thread(_run)
