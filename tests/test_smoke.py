"""Smoke tests: MCP server starts and tools respond without IMAP."""

import json

import pytest

from epistole.server import (
    list_folders,
    read_inbox,
    semantic_search,
    sync_status,
)


@pytest.mark.asyncio
async def test_read_inbox_no_imap() -> None:
    """Without IMAP creds, tools return a friendly error."""
    result = json.loads(await read_inbox())
    assert "error" in result
    assert "not configured" in result["error"].lower()


@pytest.mark.asyncio
async def test_list_folders_no_imap() -> None:
    result = json.loads(await list_folders())
    assert "error" in result


@pytest.mark.asyncio
async def test_sync_status_returns_structure() -> None:
    result = json.loads(await sync_status())
    assert "currently_syncing" in result
    assert "indexed_total" in result
    assert "recent_errors" in result
