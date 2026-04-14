"""Incremental IMAP sync layer.

Polls configured folders, fetches new messages, saves attachments,
extracts text from digital PDFs, and indexes everything into ChromaDB.
"""

from __future__ import annotations

import asyncio
import email as email_stdlib
import email.header
import email.utils
import imaplib
import json
import logging
import logging.handlers
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiosqlite
from pypdf import PdfReader

from .config import Config
from .index import VectorIndex

log = logging.getLogger("epistole.sync")


# ── Sync state shared with tools ────────────────────────────────────────────

@dataclass
class SyncProgress:
    """Mutable state read by ``sync_status`` / ``semantic_search`` banner."""

    running: bool = False
    current_folder: str = ""
    processed: int = 0
    total: int = 0
    started_at: float = 0
    last_full_sync: str | None = None
    last_incremental: str | None = None
    next_scheduled: str | None = None
    recent_errors: list[str] = field(default_factory=list)
    folder_stats: dict[str, dict[str, Any]] = field(default_factory=dict)

    @property
    def percent(self) -> int:
        if self.total <= 0:
            return 0
        return min(100, int(self.processed / self.total * 100))

    @property
    def banner(self) -> str | None:
        if not self.running:
            return None
        return (
            f"> Note: sync in progress ({self.percent}% — "
            f"{self.processed:,}/{self.total:,}). "
            f"Results may be incomplete."
        )

    def push_error(self, msg: str) -> None:
        self.recent_errors.append(msg)
        if len(self.recent_errors) > 5:
            self.recent_errors = self.recent_errors[-5:]


# Module-level singleton
progress = SyncProgress()


# ── PDF text extraction ─────────────────────────────────────────────────────

def extract_pdf_text(path: Path) -> tuple[str, bool]:
    """Extract text from a digital PDF.

    Returns ``(text, needed_ocr)``.  OCR is NOT implemented in v2 —
    ``needed_ocr`` is True when the PDF has pages but no extractable text,
    signalling that OCR could help in a future version.
    """
    try:
        reader = PdfReader(str(path))
        pages_text: list[str] = []
        for page in reader.pages:
            t = page.extract_text() or ""
            pages_text.append(t)
        full = "\n".join(pages_text).strip()
        if not full and len(reader.pages) > 0:
            log.info("Scanned PDF, content not indexed: %s", path.name)
            return ("", True)
        return (full, False)
    except Exception as exc:
        log.warning("PDF extraction failed for %s: %s", path.name, exc)
        return ("", False)


# ── SQLite state DB ─────────────────────────────────────────────────────────

_SCHEMA = """
CREATE TABLE IF NOT EXISTS folder_state (
    folder       TEXT PRIMARY KEY,
    last_uid     INTEGER NOT NULL DEFAULT 0,
    uidvalidity  INTEGER NOT NULL DEFAULT 0,
    last_sync_at TEXT,
    message_count INTEGER NOT NULL DEFAULT 0
);
"""


async def _init_db(db_path: Path) -> aiosqlite.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    db = await aiosqlite.connect(str(db_path))
    await db.executescript(_SCHEMA)
    await db.commit()
    return db


async def _get_folder_state(db: aiosqlite.Connection, folder: str) -> dict[str, Any]:
    async with db.execute(
        "SELECT last_uid, uidvalidity, last_sync_at, message_count FROM folder_state WHERE folder = ?",
        (folder,),
    ) as cur:
        row = await cur.fetchone()
    if row:
        return {
            "last_uid": row[0],
            "uidvalidity": row[1],
            "last_sync_at": row[2],
            "message_count": row[3],
        }
    return {"last_uid": 0, "uidvalidity": 0, "last_sync_at": None, "message_count": 0}


async def _set_folder_state(
    db: aiosqlite.Connection,
    folder: str,
    last_uid: int,
    uidvalidity: int,
    message_count: int,
) -> None:
    now = datetime.now(timezone.utc).isoformat()
    await db.execute(
        """INSERT INTO folder_state (folder, last_uid, uidvalidity, last_sync_at, message_count)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(folder) DO UPDATE SET
               last_uid = excluded.last_uid,
               uidvalidity = excluded.uidvalidity,
               last_sync_at = excluded.last_sync_at,
               message_count = excluded.message_count
        """,
        (folder, last_uid, uidvalidity, now, message_count),
    )
    await db.commit()


# ── Header decoding ─────────────────────────────────────────────────────────

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


# ── Core sync logic (runs in thread) ────────────────────────────────────────

def _imap_connect(cfg: Config) -> imaplib.IMAP4_SSL | imaplib.IMAP4:
    if cfg.imap_use_ssl:
        conn = imaplib.IMAP4_SSL(cfg.imap_host, cfg.imap_port)
    else:
        conn = imaplib.IMAP4(cfg.imap_host, cfg.imap_port)
    conn.login(cfg.imap_username, cfg.imap_password)
    return conn


def _safe_filename(name: str) -> str:
    """Sanitise a filename for disk storage."""
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)[:200]


def _sync_folder_blocking(
    cfg: Config,
    conn: imaplib.IMAP4_SSL | imaplib.IMAP4,
    index: VectorIndex,
    folder: str,
    state: dict[str, Any],
    full: bool,
) -> tuple[int, int]:
    """Sync one folder.  Returns (new_count, last_uid)."""
    # Select folder, get UIDVALIDITY
    status, select_data = conn.select(f'"{folder}"', readonly=True)
    if status != "OK":
        raise RuntimeError(f"Cannot select {folder}: {select_data}")

    # Parse UIDVALIDITY from select response
    uidvalidity = 0
    for line in conn.response("UIDVALIDITY")[1]:
        if line:
            uidvalidity = int(line)
            break

    old_validity = state["uidvalidity"]
    old_last_uid = state["last_uid"]

    # UIDVALIDITY changed → drop and re-sync
    if old_validity and uidvalidity != old_validity:
        log.warning("UIDVALIDITY changed for %s (%d → %d), re-indexing", folder, old_validity, uidvalidity)
        index.delete_by_folder(folder)
        old_last_uid = 0

    if full:
        old_last_uid = 0

    # Search for new UIDs
    if old_last_uid > 0:
        search_criteria = f"UID {old_last_uid + 1}:*"
    else:
        search_criteria = "ALL"

    _s, data = conn.uid("SEARCH", None, search_criteria)
    uid_list = data[0].split() if data[0] else []
    # Filter out UIDs ≤ old_last_uid (IMAP search can include boundary)
    uid_list = [u for u in uid_list if int(u) > old_last_uid]

    if not uid_list:
        return 0, old_last_uid

    max_uid = old_last_uid
    count = 0

    for uid_bytes in uid_list:
        uid = int(uid_bytes)
        try:
            _fetch_and_index(cfg, conn, index, folder, uidvalidity, uid)
            count += 1
            if uid > max_uid:
                max_uid = uid
            progress.processed += 1
        except Exception as exc:
            log.error("Failed to index UID %d in %s: %s", uid, folder, exc)
            progress.push_error(f"{folder}/UID {uid}: {exc}")

    return count, max_uid


def _fetch_and_index(
    cfg: Config,
    conn: imaplib.IMAP4_SSL | imaplib.IMAP4,
    index: VectorIndex,
    folder: str,
    uidvalidity: int,
    uid: int,
) -> None:
    """Fetch one message by UID, save attachments, index."""
    _s, data = conn.uid("FETCH", str(uid), "(BODY.PEEK[])")
    if not data or data[0] is None:
        return

    raw = data[0][1] if isinstance(data[0], tuple) else data[0]
    msg = email_stdlib.message_from_bytes(raw)

    subj = _decode_header(msg.get("Subject"))
    from_ = _decode_header(msg.get("From"))
    to = _decode_header(msg.get("To"))
    message_id = msg.get("Message-ID", "")
    in_reply_to = msg.get("In-Reply-To", "")
    date_tuple = email.utils.parsedate_to_datetime(msg.get("Date", "")) if msg.get("Date") else None
    date_iso = date_tuple.isoformat() if date_tuple else ""

    # Extract body text
    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and part.get("Content-Disposition") != "attachment":
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    body = payload.decode(charset, errors="replace")
                    break
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            charset = msg.get_content_charset() or "utf-8"
            body = payload.decode(charset, errors="replace")

    # Save attachments + extract PDF text
    attachment_filenames: list[str] = []
    pdf_texts: list[str] = []
    has_attachments = False

    if date_tuple:
        year = str(date_tuple.year)
        month = f"{date_tuple.month:02d}"
    else:
        year = "unknown"
        month = "00"

    for part in msg.walk():
        cd = part.get("Content-Disposition", "")
        if "attachment" not in cd and "inline" not in cd:
            continue
        filename = part.get_filename()
        if not filename:
            continue

        has_attachments = True
        safe_name = _safe_filename(_decode_header(filename))
        attachment_filenames.append(safe_name)

        att_dir = cfg.attachments_dir / year / month
        att_dir.mkdir(parents=True, exist_ok=True)
        att_path = att_dir / f"{uid}-{safe_name}"

        payload_bytes = part.get_payload(decode=True)
        if payload_bytes and not att_path.exists():
            att_path.write_bytes(payload_bytes)

        # PDF text extraction
        if safe_name.lower().endswith(".pdf") and att_path.exists():
            text, _needed_ocr = extract_pdf_text(att_path)
            if text:
                pdf_texts.append(text)

    pdf_text = "\n".join(pdf_texts)

    index.upsert(
        uid=uid,
        folder=folder,
        uidvalidity=uidvalidity,
        subject=subj,
        from_=from_,
        to=to,
        date_iso=date_iso,
        body=body,
        pdf_text=pdf_text,
        has_attachments=has_attachments,
        attachment_filenames=attachment_filenames,
        message_id=message_id,
        in_reply_to=in_reply_to,
    )


# ── Async orchestration ────────────────────────────────────────────────────

def _setup_logging(cfg: Config) -> None:
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(
        str(cfg.log_path), maxBytes=5_000_000, backupCount=3,
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    root = logging.getLogger("epistole")
    if not root.handlers:
        root.addHandler(handler)
        root.setLevel(logging.INFO)


async def run_sync(cfg: Config, index: VectorIndex, *, full: bool = False, folders: list[str] | None = None) -> None:
    """Run one sync cycle (all folders)."""
    if progress.running:
        log.info("Sync already in progress, skipping")
        return

    progress.running = True
    progress.processed = 0
    progress.started_at = time.time()

    try:
        db = await _init_db(cfg.state_db_path)
        try:
            # Determine folders
            target_folders = folders or cfg.sync_folders
            if not target_folders:
                # Discover all folders from IMAP
                def _list():
                    c = _imap_connect(cfg)
                    try:
                        _s, data = c.list()
                        found = []
                        for line in data:
                            if not line:
                                continue
                            decoded = line.decode() if isinstance(line, bytes) else line
                            m = re.match(r'\(([^)]*)\)\s+"([^"]+)"\s+"?([^"]*)"?', decoded)
                            if m:
                                found.append(m.group(3).strip('"'))
                        return found
                    finally:
                        c.logout()
                target_folders = await asyncio.to_thread(_list)

            # Count total UIDs to process (estimate)
            progress.total = 0
            folder_states: dict[str, dict[str, Any]] = {}
            for f in target_folders:
                state = await _get_folder_state(db, f)
                folder_states[f] = state

            # Sync each folder
            for folder_name in target_folders:
                progress.current_folder = folder_name
                state = folder_states[folder_name]
                try:
                    def _do_folder(fn=folder_name, st=state):
                        conn = _imap_connect(cfg)
                        try:
                            # Count messages to estimate total
                            conn.select(f'"{fn}"', readonly=True)
                            _s, d = conn.uid("SEARCH", None, "ALL")
                            all_uids = d[0].split() if d[0] else []
                            last = st["last_uid"] if not full else 0
                            new_uids = [u for u in all_uids if int(u) > last]
                            return len(new_uids), len(all_uids)
                        finally:
                            conn.logout()

                    new_count, total_count = await asyncio.to_thread(_do_folder)
                    progress.total += new_count

                    def _sync(fn=folder_name, st=state):
                        conn = _imap_connect(cfg)
                        try:
                            return _sync_folder_blocking(cfg, conn, index, fn, st, full)
                        finally:
                            conn.logout()

                    synced, last_uid = await asyncio.to_thread(_sync)

                    await _set_folder_state(db, folder_name, last_uid, state.get("uidvalidity", 0), total_count)
                    progress.folder_stats[folder_name] = {
                        "indexed": total_count,
                        "last_uid": last_uid,
                        "uidvalidity": state.get("uidvalidity", 0),
                    }
                    log.info("Synced %s: %d new messages", folder_name, synced)

                except Exception as exc:
                    log.error("Sync failed for folder %s: %s", folder_name, exc)
                    progress.push_error(f"{folder_name}: {exc}")

            now = datetime.now(timezone.utc).isoformat()
            if full:
                progress.last_full_sync = now
            progress.last_incremental = now

        finally:
            await db.close()
    finally:
        progress.running = False
        progress.current_folder = ""


async def sync_loop(cfg: Config, index: VectorIndex) -> None:
    """Background loop: sync every ``sync_interval_minutes``."""
    _setup_logging(cfg)
    log.info("Sync loop starting (interval=%dm)", cfg.sync_interval_minutes)

    while True:
        if cfg.imap_configured:
            next_at = datetime.now(timezone.utc).isoformat()
            progress.next_scheduled = next_at
            try:
                await run_sync(cfg, index)
            except Exception as exc:
                log.error("Sync cycle failed: %s", exc)
                progress.push_error(f"cycle: {exc}")
        else:
            log.info("IMAP not configured, sleeping")

        await asyncio.sleep(cfg.sync_interval_minutes * 60)
