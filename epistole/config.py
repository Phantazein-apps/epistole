"""Configuration loaded from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv


def _load_env() -> None:
    """Load .env from DOTENV_PATH if set, otherwise skip."""
    dotenv_path = os.environ.get("DOTENV_PATH")
    if dotenv_path:
        load_dotenv(dotenv_path)


_load_env()


@dataclass(frozen=True)
class Config:
    # Email identity
    email_address: str = ""
    full_name: str = ""

    # IMAP
    imap_host: str = ""
    imap_port: int = 993
    imap_username: str = ""
    imap_password: str = ""
    imap_use_ssl: bool = True

    # SMTP
    smtp_host: str = ""
    smtp_port: int = 465
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_use_tls: bool = True

    # Sync / index
    data_dir: Path = field(default_factory=lambda: Path.home() / ".epistole")
    sync_folders: list[str] = field(default_factory=list)
    sync_interval_minutes: int = 15
    embedding_model: str = "minishlab/potion-base-8M"
    max_body_chars: int = 32_000
    auto_sync: bool = True

    @property
    def imap_configured(self) -> bool:
        return bool(self.imap_host and self.imap_username and self.imap_password)

    @property
    def smtp_configured(self) -> bool:
        return bool(self.smtp_host and self.smtp_username and self.smtp_password)

    @property
    def account_id(self) -> str:
        """Sanitised identifier for per-account storage paths."""
        return (self.imap_username or "default").replace("@", "_at_").replace(".", "_")

    @property
    def attachments_dir(self) -> Path:
        return self.data_dir / "attachments" / self.account_id

    @property
    def chroma_dir(self) -> Path:
        return self.data_dir / "chroma"

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def state_db_path(self) -> Path:
        return self.data_dir / "state.db"

    @property
    def log_path(self) -> Path:
        return self.data_dir / "sync.log"


def _bool(val: str) -> bool:
    return val.strip().lower() in ("1", "true", "yes")


def load_config() -> Config:
    """Build Config from environment variables."""
    # Support both legacy (EMAIL_USERNAME) and new (IMAP_USERNAME) names
    imap_user = os.environ.get("IMAP_USERNAME") or os.environ.get("EMAIL_USERNAME", "")
    imap_pass = os.environ.get("IMAP_PASSWORD") or os.environ.get("EMAIL_PASSWORD", "")
    smtp_user = os.environ.get("SMTP_USERNAME") or imap_user
    smtp_pass = os.environ.get("SMTP_PASSWORD") or imap_pass

    folders_csv = os.environ.get("EPISTOLE_SYNC_FOLDERS", "")
    folders = [f.strip() for f in folders_csv.split(",") if f.strip()] if folders_csv else []

    data_dir_str = os.environ.get("EPISTOLE_DATA_DIR", "")
    data_dir = Path(data_dir_str).expanduser() if data_dir_str else Path.home() / ".epistole"

    return Config(
        email_address=os.environ.get("EMAIL_ADDRESS", ""),
        full_name=os.environ.get("FULL_NAME", ""),
        imap_host=os.environ.get("IMAP_HOST", ""),
        imap_port=int(os.environ.get("IMAP_PORT", "993")),
        imap_username=imap_user,
        imap_password=imap_pass,
        imap_use_ssl=_bool(os.environ.get("IMAP_USE_SSL", "true")),
        smtp_host=os.environ.get("SMTP_HOST", ""),
        smtp_port=int(os.environ.get("SMTP_PORT", "465")),
        smtp_username=smtp_user,
        smtp_password=smtp_pass,
        smtp_use_tls=_bool(os.environ.get("SMTP_USE_TLS", "true")),
        data_dir=data_dir,
        sync_folders=folders,
        sync_interval_minutes=int(os.environ.get("EPISTOLE_SYNC_INTERVAL_MINUTES", "15")),
        embedding_model=os.environ.get("EPISTOLE_EMBEDDING_MODEL", "intfloat/multilingual-e5-large"),
        max_body_chars=int(os.environ.get("EPISTOLE_MAX_BODY_CHARS", "32000")),
        auto_sync=_bool(os.environ.get("EPISTOLE_AUTO_SYNC", "true")),
    )
