"""Optional SMTP email send for approved outreach engagements."""

from __future__ import annotations

import os
import smtplib
import ssl
import uuid
from email.message import EmailMessage
from typing import Any

from state import OutreachError, clean_text


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def smtp_config_from_env() -> dict[str, Any]:
    return {
        "from_email": clean_text(os.environ.get("OUTREACH_FROM_EMAIL"), 320)
        or clean_text(os.environ.get("SMTP_USER"), 320)
        or "contact@jianxiaoyitech.com",
        "from_name": clean_text(os.environ.get("OUTREACH_FROM_NAME"), 200)
        or "Jianxiaoyi Technology",
        "reply_to": clean_text(os.environ.get("OUTREACH_REPLY_TO"), 320)
        or clean_text(os.environ.get("OUTREACH_FROM_EMAIL"), 320)
        or "contact@jianxiaoyitech.com",
        "host": clean_text(os.environ.get("SMTP_HOST"), 200),
        "port": int(os.environ.get("SMTP_PORT") or "465"),
        "user": clean_text(os.environ.get("SMTP_USER"), 320),
        "password": os.environ.get("SMTP_PASSWORD") or "",
        "secure": env_bool("SMTP_SECURE", True),
    }


def build_message(
    *,
    to_email: str,
    subject: str,
    body_text: str,
    lead_id: str,
    engagement_id: str,
    config: dict[str, Any] | None = None,
) -> tuple[EmailMessage, str]:
    cfg = config or smtp_config_from_env()
    message_id = f"<outreach-{lead_id}-{uuid.uuid4().hex[:12]}@jianxiaoyitech.com>"
    msg = EmailMessage()
    from_name = cfg.get("from_name") or "Jianxiaoyi Technology"
    from_email = cfg.get("from_email") or "contact@jianxiaoyitech.com"
    msg["From"] = f"{from_name} <{from_email}>"
    msg["To"] = to_email
    msg["Reply-To"] = cfg.get("reply_to") or from_email
    msg["Subject"] = subject
    msg["Message-ID"] = message_id
    msg["X-Jianxiaoyi-Lead-ID"] = lead_id
    msg["X-Jianxiaoyi-Engagement-ID"] = engagement_id
    msg.set_content(body_text or "")
    return msg, message_id


def send_email_message(msg: EmailMessage, config: dict[str, Any] | None = None) -> str:
    cfg = config or smtp_config_from_env()
    host = cfg.get("host")
    user = cfg.get("user")
    password = cfg.get("password")
    if not host or not user or not password:
        raise OutreachError(
            "SMTP_HOST / SMTP_USER / SMTP_PASSWORD required for live send"
        )
    port = int(cfg.get("port") or 465)
    context = ssl.create_default_context()
    if cfg.get("secure", True) and port == 465:
        with smtplib.SMTP_SSL(host, port, context=context, timeout=30) as smtp:
            smtp.login(user, password)
            smtp.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=30) as smtp:
            if cfg.get("secure", True):
                smtp.starttls(context=context)
            smtp.login(user, password)
            smtp.send_message(msg)
    return str(msg["Message-ID"])


def send_engagement_email(
    lead: dict[str, Any],
    engagement: dict[str, Any],
    *,
    dry_run: bool = True,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if engagement.get("channel") != "email":
        raise OutreachError("SMTP send only supports email channel")
    to_email = clean_text(engagement.get("recipient"), 320)
    if not to_email or "@" not in to_email:
        raise OutreachError("Engagement recipient is not a valid email")
    subject = clean_text(engagement.get("subject"), 500) or "(no subject)"
    body = engagement.get("body_text") if isinstance(engagement.get("body_text"), str) else ""
    msg, message_id = build_message(
        to_email=to_email,
        subject=subject,
        body_text=body,
        lead_id=str(lead.get("lead_id") or "unknown"),
        engagement_id=str(engagement.get("engagement_id") or "unknown"),
        config=config,
    )
    if dry_run:
        return {
            "dry_run": True,
            "message_id": f"dry-run-{message_id.strip('<>')}",
            "to": to_email,
            "subject": subject,
        }
    sent_id = send_email_message(msg, config=config)
    return {
        "dry_run": False,
        "message_id": sent_id,
        "to": to_email,
        "subject": subject,
    }
