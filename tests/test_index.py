"""Unit tests for the vector index.

These tests require the embedding model to be downloaded.
Skip with: pytest -k 'not test_index'
"""

import json
import tempfile
from pathlib import Path

import pytest

from epistole.config import Config
from epistole.index import VectorIndex


def _model_cached() -> bool:
    """Check if the model files exist in HuggingFace cache without downloading."""
    from pathlib import Path
    hf_home = Path.home() / ".cache" / "huggingface" / "hub"
    candidates = list(hf_home.glob("models--minishlab--potion-base-8M/*/model.safetensors"))
    return len(candidates) > 0


# Skip all tests in this module if the model isn't already cached
pytestmark = pytest.mark.skipif(
    not _model_cached(),
    reason="Embedding model not cached locally — download first",
)


@pytest.fixture
def cfg(tmp_path: Path) -> Config:
    return Config(
        imap_username="test@example.com",
        data_dir=tmp_path,
        embedding_model="minishlab/potion-base-8M",
    )


@pytest.fixture
def index(cfg: Config) -> VectorIndex:
    return VectorIndex(cfg)


def test_upsert_and_count(index: VectorIndex) -> None:
    index.upsert(
        uid=1, folder="INBOX", uidvalidity=100,
        subject="Invoice #123", from_="alice@example.com", to="bob@example.com",
        date_iso="2025-01-15T10:00:00", body="Please find attached the January invoice.",
    )
    assert index.count == 1


def test_upsert_is_idempotent(index: VectorIndex) -> None:
    for _ in range(3):
        index.upsert(
            uid=1, folder="INBOX", uidvalidity=100,
            subject="Test", from_="a@b.com", to="c@d.com",
            date_iso="2025-01-01", body="Hello",
        )
    assert index.count == 1


def test_query_returns_results(index: VectorIndex) -> None:
    index.upsert(
        uid=1, folder="INBOX", uidvalidity=100,
        subject="Q4 Financial Report", from_="finance@corp.com",
        to="ceo@corp.com", date_iso="2025-01-10", body="Quarterly earnings exceeded forecast.",
    )
    index.upsert(
        uid=2, folder="INBOX", uidvalidity=100,
        subject="Lunch tomorrow?", from_="friend@social.com",
        to="me@social.com", date_iso="2025-01-11", body="Want to grab lunch?",
    )

    results = index.query("financial earnings report")
    assert len(results) >= 1
    assert results[0]["uid"] == 1
    assert results[0]["score"] > 0


def test_query_with_where_filter(index: VectorIndex) -> None:
    index.upsert(
        uid=1, folder="INBOX", uidvalidity=100,
        subject="A", from_="a@b.com", to="c@d.com",
        date_iso="2025-01-01", body="msg one",
    )
    index.upsert(
        uid=2, folder="Sent", uidvalidity=200,
        subject="B", from_="c@d.com", to="a@b.com",
        date_iso="2025-01-02", body="msg two",
    )

    results = index.query("msg", where={"folder": "Sent"})
    assert len(results) == 1
    assert results[0]["folder"] == "Sent"


def test_delete_by_folder(index: VectorIndex) -> None:
    index.upsert(uid=1, folder="INBOX", uidvalidity=100,
                 subject="A", from_="a@b.com", to="c@d.com",
                 date_iso="2025-01-01", body="keep")
    index.upsert(uid=2, folder="Trash", uidvalidity=200,
                 subject="B", from_="a@b.com", to="c@d.com",
                 date_iso="2025-01-02", body="delete")
    assert index.count == 2

    index.delete_by_folder("Trash")
    assert index.count == 1


def test_get_by_metadata(index: VectorIndex) -> None:
    index.upsert(uid=5, folder="INBOX", uidvalidity=100,
                 subject="Thread start", from_="a@b.com", to="c@d.com",
                 date_iso="2025-01-01", body="Hello",
                 message_id="<msg1@example.com>")
    index.upsert(uid=6, folder="INBOX", uidvalidity=100,
                 subject="Re: Thread start", from_="c@d.com", to="a@b.com",
                 date_iso="2025-01-02", body="Hi back",
                 message_id="<msg2@example.com>",
                 in_reply_to="<msg1@example.com>")

    results = index.get_by_metadata({"in_reply_to": "<msg1@example.com>"})
    assert len(results) == 1
    assert results[0]["uid"] == 6


def test_attachment_filenames_roundtrip(index: VectorIndex) -> None:
    index.upsert(
        uid=10, folder="INBOX", uidvalidity=100,
        subject="Invoice", from_="a@b.com", to="c@d.com",
        date_iso="2025-03-01", body="See attached",
        has_attachments=True,
        attachment_filenames=["invoice.pdf", "receipt.png"],
    )
    results = index.query("invoice")
    assert results[0]["attachment_filenames"] == ["invoice.pdf", "receipt.png"]
    assert results[0]["attachment_count"] == 2
