"""SMTP operations for send / reply tools."""

from __future__ import annotations

import asyncio
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any

from .config import Config


def _send(cfg: Config, msg: MIMEMultipart) -> dict[str, Any]:
    if not cfg.smtp_configured:
        raise RuntimeError("SMTP credentials not configured")
    if cfg.smtp_use_tls and cfg.smtp_port == 465:
        server = smtplib.SMTP_SSL(cfg.smtp_host, cfg.smtp_port)
    else:
        server = smtplib.SMTP(cfg.smtp_host, cfg.smtp_port)
        if cfg.smtp_use_tls:
            server.starttls()
    server.login(cfg.smtp_username, cfg.smtp_password)
    rejected = server.send_message(msg)
    server.quit()

    all_recipients = []
    for field in ("To", "Cc", "Bcc"):
        val = msg.get(field)
        if val:
            all_recipients.extend([a.strip() for a in val.split(",")])
    accepted = [r for r in all_recipients if r not in rejected]

    return {
        "success": True,
        "messageId": msg.get("Message-ID", ""),
        "accepted": accepted,
        "rejected": list(rejected.keys()) if rejected else [],
    }


async def send_message(
    cfg: Config,
    to: str,
    subject: str,
    body: str,
    cc: str | None = None,
    bcc: str | None = None,
) -> dict[str, Any]:
    def _run():
        msg = MIMEMultipart()
        msg["From"] = f"{cfg.full_name} <{cfg.email_address}>"
        msg["To"] = to
        msg["Subject"] = subject
        if cc:
            msg["Cc"] = cc
        if bcc:
            msg["Bcc"] = bcc
        msg.attach(MIMEText(body, "plain"))
        return _send(cfg, msg)

    return await asyncio.to_thread(_run)


async def reply_to_message(
    cfg: Config,
    original: dict[str, Any],
    body: str,
    reply_all: bool = False,
) -> dict[str, Any]:
    """Send a reply.  ``original`` must be the dict returned by ``get_message``."""

    def _run():
        subj = original["subject"]
        re_subject = subj if subj.startswith("Re:") else f"Re: {subj}"

        refs = original.get("references") or ""
        mid = original.get("messageId") or ""
        if mid and mid not in refs:
            refs = f"{refs} {mid}".strip()

        reply_to = original["from"]
        cc = None
        if reply_all:
            extras = [original.get("to", ""), original.get("cc", "")]
            all_addrs = ", ".join(e for e in extras if e)
            filtered = [
                a.strip()
                for a in all_addrs.split(",")
                if a.strip() and cfg.email_address.lower() not in a.lower()
            ]
            cc = ", ".join(filtered) if filtered else None

        # Quoted body
        quoted = "\n".join(f"> {line}" for line in (original.get("text") or "").split("\n"))
        full_body = f"{body}\n\nOn {original['date']}, {original['from']} wrote:\n{quoted}"

        msg = MIMEMultipart()
        msg["From"] = f"{cfg.full_name} <{cfg.email_address}>"
        msg["To"] = reply_to
        msg["Subject"] = re_subject
        msg["In-Reply-To"] = mid
        msg["References"] = refs
        if cc:
            msg["Cc"] = cc
        msg.attach(MIMEText(full_body, "plain"))
        return _send(cfg, msg)

    return await asyncio.to_thread(_run)
