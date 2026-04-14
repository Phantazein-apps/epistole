"""Unit tests for sync layer helpers."""

import asyncio
import tempfile
from pathlib import Path

import pytest

from epistole.sync import extract_pdf_text, _init_db, _get_folder_state, _set_folder_state


def test_extract_pdf_text_nonexistent() -> None:
    text, needed_ocr = extract_pdf_text(Path("/nonexistent/file.pdf"))
    assert text == ""
    assert needed_ocr is False


def test_extract_pdf_text_not_a_pdf(tmp_path: Path) -> None:
    fake = tmp_path / "fake.pdf"
    fake.write_text("this is not a real pdf")
    text, needed_ocr = extract_pdf_text(fake)
    assert text == ""
    assert needed_ocr is False


@pytest.mark.asyncio
async def test_folder_state_roundtrip(tmp_path: Path) -> None:
    db_path = tmp_path / "state.db"
    db = await _init_db(db_path)
    try:
        # Initial state is empty
        state = await _get_folder_state(db, "INBOX")
        assert state["last_uid"] == 0
        assert state["uidvalidity"] == 0

        # Write state
        await _set_folder_state(db, "INBOX", last_uid=42, uidvalidity=12345, message_count=100)

        # Read back
        state = await _get_folder_state(db, "INBOX")
        assert state["last_uid"] == 42
        assert state["uidvalidity"] == 12345
        assert state["message_count"] == 100
        assert state["last_sync_at"] is not None

        # Update
        await _set_folder_state(db, "INBOX", last_uid=50, uidvalidity=12345, message_count=108)
        state = await _get_folder_state(db, "INBOX")
        assert state["last_uid"] == 50
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_multiple_folders(tmp_path: Path) -> None:
    db_path = tmp_path / "state.db"
    db = await _init_db(db_path)
    try:
        await _set_folder_state(db, "INBOX", 10, 100, 10)
        await _set_folder_state(db, "Sent", 20, 200, 20)

        inbox = await _get_folder_state(db, "INBOX")
        sent = await _get_folder_state(db, "Sent")

        assert inbox["last_uid"] == 10
        assert sent["last_uid"] == 20
        assert inbox["uidvalidity"] == 100
        assert sent["uidvalidity"] == 200
    finally:
        await db.close()
