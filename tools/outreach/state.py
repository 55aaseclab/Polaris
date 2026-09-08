"""Durable outreach state for a workspace customer-acquisition tree."""

from __future__ import annotations

import json
import os
import re
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "clue.outreach.state.v1"
TOOL_NAME = "clue-outreach"
TOOL_VERSION = "0.1.0"

RELATIONSHIP_STATES = frozenset(
    {
        "new",
        "first_touch",
        "waiting",
        "engaged",
        "suppressed",
        "closed",
        "customer",
    }
)

ENGAGEMENT_STATUSES = frozenset(
    {
        "draft",
        "approved",
        "queued",
        "sent",
        "failed",
        "replied",
        "cancelled",
    }
)

CONTACT_POINT_STATUSES = frozenset(
    {"active", "bounced", "unsubscribed", "do_not_use"}
)

# Channels the system can auto-draft for.
AUTO_DRAFT_CHANNELS = frozenset({"email"})

# Channels that require an operator (logged, not SMTP-sent).
MANUAL_CHANNELS = frozenset(
    {
        "phone",
        "linkedin_message",
        "instagram_dm",
        "contact_form",
    }
)

DEFAULT_WAIT_DAYS = 7
DEFAULT_MAX_AUTO_TOUCHES = 1
AUDIT_LIMIT = 500


class OutreachError(RuntimeError):
    """User-facing outreach failure."""


def utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def parse_utc(value: str | None) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    try:
        with open(descriptor, "w", encoding="utf-8", closefd=True) as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        Path(temporary).replace(path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        handle.write("\n")


def clean_text(value: Any, limit: int = 500) -> str | None:
    if not isinstance(value, str):
        return None
    text = re.sub(r"\s+", " ", value).strip()
    if not text:
        return None
    return text[:limit]


def workspaces_root() -> Path:
    raw = os.environ.get("POLARIS_BUSINESS_WORKSPACES_ROOT", "").strip()
    if not raw:
        raise OutreachError("POLARIS_BUSINESS_WORKSPACES_ROOT is required")
    root = Path(raw).expanduser().resolve()
    if not root.is_dir():
        raise OutreachError(f"POLARIS_BUSINESS_WORKSPACES_ROOT is not a directory: {root}")
    return root


def resolve_workspace_id(workspace: str) -> str:
    value = clean_text(workspace, 200)
    if not value or Path(value).name != value or value in {".", ".."}:
        raise OutreachError("Invalid workspace id")
    return value


def collection_root(workspace: str) -> Path:
    workspace_id = resolve_workspace_id(workspace)
    root = workspaces_root() / workspace_id / "acquisition" / "customer-data-collection"
    return root


def default_paths(workspace: str) -> dict[str, Path]:
    root = collection_root(workspace)
    return {
        "root": root,
        "output": root / "outputs" / "output.json",
        "state": root / "work" / "outreach-state.json",
        "log": root / "outputs" / "outreach-log.jsonl",
    }


def empty_state(workspace: str) -> dict[str, Any]:
    now = utc_now()
    return {
        "schema_version": SCHEMA_VERSION,
        "tool": {"name": TOOL_NAME, "version": TOOL_VERSION},
        "workspace": resolve_workspace_id(workspace),
        "created_at": now,
        "updated_at": now,
        "config": {
            "wait_days": DEFAULT_WAIT_DAYS,
            "max_auto_touches": DEFAULT_MAX_AUTO_TOUCHES,
            "auto_follow_up": False,
        },
        "leads": {},
        "audit": [],
    }


def load_state(state_path: Path, workspace: str) -> dict[str, Any]:
    if not state_path.exists():
        return empty_state(workspace)
    payload = read_json(state_path)
    if not isinstance(payload, dict):
        raise OutreachError("outreach-state.json must be a JSON object")
    if payload.get("schema_version") != SCHEMA_VERSION:
        # Accept missing/legacy by re-wrapping known keys when possible.
        if "leads" not in payload:
            raise OutreachError(
                f"Unsupported outreach schema: {payload.get('schema_version')!r}"
            )
        payload["schema_version"] = SCHEMA_VERSION
    payload.setdefault("tool", {"name": TOOL_NAME, "version": TOOL_VERSION})
    payload.setdefault("workspace", resolve_workspace_id(workspace))
    payload.setdefault("leads", {})
    payload.setdefault("audit", [])
    payload.setdefault(
        "config",
        {
            "wait_days": DEFAULT_WAIT_DAYS,
            "max_auto_touches": DEFAULT_MAX_AUTO_TOUCHES,
            "auto_follow_up": False,
        },
    )
    if not isinstance(payload["leads"], dict):
        raise OutreachError("outreach-state.json leads must be an object")
    return payload


def save_state(state_path: Path, state: dict[str, Any], log_path: Path | None = None) -> None:
    state["updated_at"] = utc_now()
    state["tool"] = {"name": TOOL_NAME, "version": TOOL_VERSION}
    audit = state.get("audit")
    if isinstance(audit, list) and len(audit) > AUDIT_LIMIT:
        state["audit"] = audit[-AUDIT_LIMIT:]
    write_json_atomic(state_path, state)
    if log_path is not None:
        append_jsonl(
            log_path,
            {
                "at": state["updated_at"],
                "event": "state_saved",
                "workspace": state.get("workspace"),
                "lead_count": len(state.get("leads") or {}),
            },
        )


def append_audit(state: dict[str, Any], action: str, **fields: Any) -> None:
    entry = {"at": utc_now(), "action": action, **fields}
    audit = state.setdefault("audit", [])
    if not isinstance(audit, list):
        state["audit"] = [entry]
    else:
        audit.append(entry)


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def lead_id_from_record(record: dict[str, Any]) -> str:
    record = customer_lead_payload(record)
    dedupe = record.get("deduplication")
    if isinstance(dedupe, dict):
        group = clean_text(dedupe.get("duplicate_group_id"), 200)
        if group:
            return f"candidate:{group}"
    record_id = clean_text(record.get("record_id"), 200)
    if record_id:
        return f"record:{record_id}"
    company = clean_text(record.get("company_name") or record.get("name"), 120)
    if company:
        slug = re.sub(r"[^a-z0-9]+", "-", company.casefold()).strip("-")
        return f"company:{slug or 'unknown'}"
    return new_id("lead")


def customer_lead_payload(record: dict[str, Any]) -> dict[str, Any]:
    """Return a customer-lead payload carried by a generic v2 collection record."""
    payload = record.get("payload")
    if not isinstance(payload, dict):
        return record
    customer_lead = payload.get("customer_lead")
    return customer_lead if isinstance(customer_lead, dict) else record


def contact_points_from_record(record: dict[str, Any]) -> list[dict[str, Any]]:
    record = customer_lead_payload(record)
    points: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    methods = record.get("contact_methods")
    if isinstance(methods, list):
        for method in methods:
            if not isinstance(method, dict):
                continue
            channel = clean_text(method.get("channel"), 80)
            value = clean_text(method.get("value"), 500)
            if not channel or not value:
                continue
            key = (channel, value.casefold())
            if key in seen:
                continue
            seen.add(key)
            points.append(
                {
                    "channel": channel,
                    "value": value,
                    "status": "active",
                    "contact_role": clean_text(method.get("contact_role"), 80),
                    "source_url": clean_text(method.get("source_url"), 500),
                    "is_public_business_contact": bool(
                        method.get("is_public_business_contact", True)
                    ),
                }
            )

    # Fallback fields sometimes present without contact_methods.
    for email in record.get("emails") or []:
        value = clean_text(email, 320)
        if not value:
            continue
        key = ("email", value.casefold())
        if key in seen:
            continue
        seen.add(key)
        points.append(
            {
                "channel": "email",
                "value": value,
                "status": "active",
                "contact_role": "general",
                "source_url": None,
                "is_public_business_contact": True,
            }
        )

    phone = clean_text(record.get("public_business_phone"), 100)
    if phone and ("phone", phone.casefold()) not in seen:
        points.append(
            {
                "channel": "phone",
                "value": phone,
                "status": "active",
                "contact_role": "general",
                "source_url": None,
                "is_public_business_contact": True,
            }
        )

    for social in record.get("social_links") or []:
        value = clean_text(social, 500)
        if not value:
            continue
        channel = "linkedin_message" if "linkedin.com" in value.casefold() else None
        if channel is None and "instagram.com" in value.casefold():
            channel = "instagram_dm"
        if channel is None:
            continue
        key = (channel, value.casefold())
        if key in seen:
            continue
        seen.add(key)
        points.append(
            {
                "channel": channel,
                "value": value,
                "status": "active",
                "contact_role": "unknown",
                "source_url": value,
                "is_public_business_contact": True,
            }
        )

    return points


def company_name_from_record(record: dict[str, Any]) -> str | None:
    record = customer_lead_payload(record)
    for key in ("company_name", "name", "name_zh", "title"):
        value = clean_text(record.get(key), 300)
        if value:
            return value
    return None


def make_lead_from_record(record: dict[str, Any], workspace: str) -> dict[str, Any]:
    record = customer_lead_payload(record)
    now = utc_now()
    lead_id = lead_id_from_record(record)
    return {
        "lead_id": lead_id,
        "record_id": clean_text(record.get("record_id"), 200),
        "workspace": resolve_workspace_id(workspace),
        "company_name": company_name_from_record(record),
        "relationship": "new",
        "suppression_reason": None,
        "assignee": None,
        "language": clean_text(record.get("language") or record.get("page_language"), 16),
        "contact_points": contact_points_from_record(record),
        "engagements": [],
        "source_snapshot": {
            "record_id": clean_text(record.get("record_id"), 200),
            "buyer_type": clean_text(
                (record.get("classification") or {}).get("buyer_type")
                if isinstance(record.get("classification"), dict)
                else record.get("buyer_type"),
                120,
            ),
            "website": clean_text(
                record.get("website_candidate_url") or record.get("website"),
                500,
            ),
            "country": clean_text(record.get("country"), 80),
            "city": clean_text(record.get("city"), 80),
        },
        "imported_at": now,
        "updated_at": now,
        "next_eligible_at": None,
        "last_event_at": now,
    }


def merge_contact_points(
    existing: list[dict[str, Any]], incoming: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for point in existing:
        channel = clean_text(point.get("channel"), 80) or ""
        value = clean_text(point.get("value"), 500) or ""
        if channel and value:
            by_key[(channel, value.casefold())] = dict(point)
    for point in incoming:
        channel = clean_text(point.get("channel"), 80) or ""
        value = clean_text(point.get("value"), 500) or ""
        if not channel or not value:
            continue
        key = (channel, value.casefold())
        if key in by_key:
            # Keep non-active status if already restricted.
            current = by_key[key]
            if current.get("status") in {"bounced", "unsubscribed", "do_not_use"}:
                continue
            by_key[key] = {**point, "status": current.get("status", "active")}
        else:
            by_key[key] = dict(point)
    return list(by_key.values())


def import_ready_records(
    state: dict[str, Any],
    output_document: dict[str, Any],
    workspace: str,
    actor: str | None = None,
) -> dict[str, Any]:
    records = output_document.get("outreach_ready_records")
    if records is None:
        raise OutreachError("output.json missing outreach_ready_records")
    if not isinstance(records, list):
        raise OutreachError("outreach_ready_records must be a list")

    leads = state.setdefault("leads", {})
    if not isinstance(leads, dict):
        raise OutreachError("state.leads must be an object")

    created = 0
    updated = 0
    skipped = 0
    for raw in records:
        if not isinstance(raw, dict):
            skipped += 1
            continue
        lead = make_lead_from_record(raw, workspace)
        lead_id = lead["lead_id"]
        existing = leads.get(lead_id)
        if not isinstance(existing, dict):
            leads[lead_id] = lead
            created += 1
            continue
        # Do not resurrect suppressed / customer leads on re-import.
        if existing.get("relationship") in {"suppressed", "customer"}:
            skipped += 1
            continue
        existing["company_name"] = lead["company_name"] or existing.get("company_name")
        existing["record_id"] = lead["record_id"] or existing.get("record_id")
        existing["language"] = lead["language"] or existing.get("language")
        existing["source_snapshot"] = lead["source_snapshot"]
        existing["contact_points"] = merge_contact_points(
            list(existing.get("contact_points") or []),
            lead["contact_points"],
        )
        existing["updated_at"] = utc_now()
        updated += 1

    append_audit(
        state,
        "import_ready_records",
        created=created,
        updated=updated,
        skipped=skipped,
        source_count=len(records),
        actor=actor,
    )
    return {"created": created, "updated": updated, "skipped": skipped, "total": len(leads)}


def get_lead(state: dict[str, Any], lead_id: str) -> dict[str, Any]:
    leads = state.get("leads") or {}
    lead = leads.get(lead_id) if isinstance(leads, dict) else None
    if not isinstance(lead, dict):
        raise OutreachError(f"Unknown lead_id: {lead_id}")
    return lead


def find_engagement(
    state: dict[str, Any], engagement_id: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    for lead in (state.get("leads") or {}).values():
        if not isinstance(lead, dict):
            continue
        for engagement in lead.get("engagements") or []:
            if isinstance(engagement, dict) and engagement.get("engagement_id") == engagement_id:
                return lead, engagement
    raise OutreachError(f"Unknown engagement_id: {engagement_id}")


def active_points(lead: dict[str, Any], channel: str | None = None) -> list[dict[str, Any]]:
    points = []
    for point in lead.get("contact_points") or []:
        if not isinstance(point, dict):
            continue
        if point.get("status") != "active":
            continue
        if channel and point.get("channel") != channel:
            continue
        points.append(point)
    return points


def count_sent_auto(lead: dict[str, Any]) -> int:
    count = 0
    for engagement in lead.get("engagements") or []:
        if not isinstance(engagement, dict):
            continue
        if engagement.get("channel") not in AUTO_DRAFT_CHANNELS:
            continue
        if engagement.get("status") in {"sent", "replied", "queued", "approved"}:
            count += 1
    return count


def default_email_draft(lead: dict[str, Any]) -> tuple[str, str]:
    company = lead.get("company_name") or "your team"
    language = (lead.get("language") or "en").casefold()
    if language.startswith("zh"):
        subject = f"关于与 {company} 的商务合作"
        body = (
            f"您好，\n\n"
            f"我是 Jianxiaoyi Technology 的同事。"
            f"我们关注到 {company} 的业务方向，"
            f"希望了解是否有产品或合作方面的沟通机会。\n\n"
            f"如不方便，请直接回复 stop，我们不会再联系。\n\n"
            f"Jianxiaoyi Technology\n"
            f"contact@jianxiaoyitech.com\n"
        )
    else:
        subject = f"Introduction from Jianxiaoyi Technology — {company}"
        body = (
            f"Hello,\n\n"
            f"I am writing from Jianxiaoyi Technology. "
            f"We came across {company} and would like to explore "
            f"whether there is a fit for a short product conversation.\n\n"
            f"If this is not relevant, reply with stop and we will "
            f"not contact you again.\n\n"
            f"Jianxiaoyi Technology\n"
            f"contact@jianxiaoyitech.com\n"
        )
    return subject, body


def create_draft(
    state: dict[str, Any],
    lead_id: str,
    channel: str = "email",
    intent: str = "first_touch",
    subject: str | None = None,
    body_text: str | None = None,
    recipient: str | None = None,
    actor: str | None = None,
) -> dict[str, Any]:
    lead = get_lead(state, lead_id)
    if lead.get("relationship") in {"suppressed", "customer", "closed"}:
        raise OutreachError(
            f"Lead {lead_id} is {lead.get('relationship')}; cannot draft"
        )

    channel = clean_text(channel, 80) or "email"
    points = active_points(lead, channel if channel in AUTO_DRAFT_CHANNELS else None)
    if channel in AUTO_DRAFT_CHANNELS:
        points = active_points(lead, channel)
        if not points:
            raise OutreachError(f"No active {channel} contact point on {lead_id}")
        chosen = points[0]
        to_value = recipient or chosen["value"]
    else:
        # Manual channel draft becomes a task card, not SMTP.
        manual_points = active_points(lead, channel)
        if not manual_points and channel in MANUAL_CHANNELS:
            # Allow operator to open a manual task without pre-scraped value.
            to_value = recipient or channel
            chosen = {
                "channel": channel,
                "value": to_value,
                "status": "active",
            }
        elif manual_points:
            chosen = manual_points[0]
            to_value = recipient or chosen["value"]
        else:
            raise OutreachError(f"No contact path for channel {channel}")

    if channel == "email":
        default_subject, default_body = default_email_draft(lead)
        subject = subject or default_subject
        body_text = body_text or default_body
    else:
        subject = subject or f"{intent} via {channel}"
        body_text = body_text or ""

    engagement = {
        "engagement_id": new_id("eng"),
        "channel": channel,
        "intent": intent,
        "status": "draft",
        "recipient": to_value,
        "subject": subject,
        "body_text": body_text,
        "template_version": "v1",
        "message_id": None,
        "created_at": utc_now(),
        "created_by": actor,
        "approved_at": None,
        "approved_by": None,
        "sent_at": None,
        "failed_at": None,
        "failure_reason": None,
        "replied_at": None,
        "outcome": None,
        "contact_point": {
            "channel": chosen.get("channel"),
            "value": chosen.get("value"),
        },
    }
    lead.setdefault("engagements", []).append(engagement)
    lead["updated_at"] = utc_now()
    lead["last_event_at"] = lead["updated_at"]
    append_audit(
        state,
        "draft_created",
        lead_id=lead_id,
        engagement_id=engagement["engagement_id"],
        channel=channel,
        actor=actor,
    )
    return engagement


def approve_engagement(
    state: dict[str, Any],
    engagement_id: str,
    actor: str | None = None,
) -> dict[str, Any]:
    lead, engagement = find_engagement(state, engagement_id)
    if lead.get("relationship") in {"suppressed", "customer", "closed"}:
        raise OutreachError("Lead is suppressed or closed")
    if engagement.get("status") != "draft":
        raise OutreachError(
            f"Engagement {engagement_id} is {engagement.get('status')}, not draft"
        )
    engagement["status"] = "approved"
    engagement["approved_at"] = utc_now()
    engagement["approved_by"] = actor
    lead["updated_at"] = utc_now()
    lead["last_event_at"] = lead["updated_at"]
    append_audit(
        state,
        "engagement_approved",
        lead_id=lead["lead_id"],
        engagement_id=engagement_id,
        actor=actor,
    )
    return engagement


def reject_engagement(
    state: dict[str, Any],
    engagement_id: str,
    actor: str | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    lead, engagement = find_engagement(state, engagement_id)
    if engagement.get("status") not in {"draft", "approved", "queued"}:
        raise OutreachError(
            f"Cannot reject engagement in status {engagement.get('status')}"
        )
    engagement["status"] = "cancelled"
    engagement["outcome"] = reason or "rejected"
    lead["updated_at"] = utc_now()
    append_audit(
        state,
        "engagement_rejected",
        lead_id=lead["lead_id"],
        engagement_id=engagement_id,
        actor=actor,
        reason=reason,
    )
    return engagement


def mark_sent(
    state: dict[str, Any],
    engagement_id: str,
    message_id: str | None = None,
    dry_run: bool = False,
    actor: str | None = None,
) -> dict[str, Any]:
    lead, engagement = find_engagement(state, engagement_id)
    if lead.get("relationship") in {"suppressed", "customer", "closed"}:
        raise OutreachError("Lead is suppressed or closed")
    if engagement.get("status") not in {"approved", "queued"}:
        raise OutreachError(
            f"Engagement {engagement_id} must be approved before send"
        )
    now = utc_now()
    engagement["status"] = "sent"
    engagement["sent_at"] = now
    engagement["message_id"] = message_id or (
        f"dry-run-{engagement_id}" if dry_run else new_id("msg")
    )
    engagement["outcome"] = "dry_run" if dry_run else "sent"
    if lead.get("relationship") in {"new", "first_touch", "waiting"}:
        lead["relationship"] = "waiting"
    config = state.get("config") or {}
    wait_days = int(config.get("wait_days") or DEFAULT_WAIT_DAYS)
    lead["next_eligible_at"] = (
        datetime.now(timezone.utc) + timedelta(days=wait_days)
    ).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    lead["updated_at"] = now
    lead["last_event_at"] = now
    append_audit(
        state,
        "engagement_sent",
        lead_id=lead["lead_id"],
        engagement_id=engagement_id,
        dry_run=dry_run,
        message_id=engagement["message_id"],
        actor=actor,
    )
    return engagement


def mark_failed(
    state: dict[str, Any],
    engagement_id: str,
    reason: str,
    actor: str | None = None,
) -> dict[str, Any]:
    lead, engagement = find_engagement(state, engagement_id)
    engagement["status"] = "failed"
    engagement["failed_at"] = utc_now()
    engagement["failure_reason"] = reason
    lead["updated_at"] = utc_now()
    append_audit(
        state,
        "engagement_failed",
        lead_id=lead["lead_id"],
        engagement_id=engagement_id,
        reason=reason,
        actor=actor,
    )
    return engagement


def mark_replied(
    state: dict[str, Any],
    engagement_id: str,
    actor: str | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    lead, engagement = find_engagement(state, engagement_id)
    now = utc_now()
    engagement["status"] = "replied"
    engagement["replied_at"] = now
    engagement["outcome"] = note or "replied"
    lead["relationship"] = "engaged"
    lead["next_eligible_at"] = None
    # Cancel other open auto follow-ups.
    for other in lead.get("engagements") or []:
        if not isinstance(other, dict):
            continue
        if other.get("engagement_id") == engagement_id:
            continue
        if other.get("status") in {"draft", "approved", "queued"}:
            other["status"] = "cancelled"
            other["outcome"] = "cancelled_on_reply"
    lead["updated_at"] = now
    lead["last_event_at"] = now
    append_audit(
        state,
        "engagement_replied",
        lead_id=lead["lead_id"],
        engagement_id=engagement_id,
        actor=actor,
        note=note,
    )
    return engagement


def mark_bounce(
    state: dict[str, Any],
    engagement_id: str,
    hard: bool = True,
    actor: str | None = None,
) -> dict[str, Any]:
    lead, engagement = find_engagement(state, engagement_id)
    now = utc_now()
    engagement["status"] = "failed"
    engagement["failed_at"] = now
    engagement["failure_reason"] = "hard_bounce" if hard else "soft_bounce"
    engagement["outcome"] = engagement["failure_reason"]
    recipient = clean_text(engagement.get("recipient"), 500)
    if hard and recipient:
        for point in lead.get("contact_points") or []:
            if (
                isinstance(point, dict)
                and point.get("channel") == engagement.get("channel")
                and clean_text(point.get("value"), 500) == recipient
            ):
                point["status"] = "bounced"
    if hard and engagement.get("channel") == "email":
        # Soften relationship back so strategy may suggest another channel.
        if lead.get("relationship") == "waiting":
            lead["relationship"] = "first_touch"
        lead["next_eligible_at"] = now
    lead["updated_at"] = now
    lead["last_event_at"] = now
    append_audit(
        state,
        "engagement_bounced",
        lead_id=lead["lead_id"],
        engagement_id=engagement_id,
        hard=hard,
        actor=actor,
    )
    return engagement


def suppress_lead(
    state: dict[str, Any],
    lead_id: str,
    reason: str,
    actor: str | None = None,
) -> dict[str, Any]:
    lead = get_lead(state, lead_id)
    reason = clean_text(reason, 300) or "suppressed"
    lead["relationship"] = "suppressed"
    lead["suppression_reason"] = reason
    lead["next_eligible_at"] = None
    now = utc_now()
    for engagement in lead.get("engagements") or []:
        if isinstance(engagement, dict) and engagement.get("status") in {
            "draft",
            "approved",
            "queued",
        }:
            engagement["status"] = "cancelled"
            engagement["outcome"] = f"suppressed:{reason}"
    # Mark email points unsubscribed when reason suggests it.
    if "unsub" in reason.casefold() or reason.casefold() in {"stop", "opt_out"}:
        for point in lead.get("contact_points") or []:
            if isinstance(point, dict) and point.get("channel") == "email":
                point["status"] = "unsubscribed"
    lead["updated_at"] = now
    lead["last_event_at"] = now
    append_audit(
        state,
        "lead_suppressed",
        lead_id=lead_id,
        reason=reason,
        actor=actor,
    )
    return lead


def log_manual_outcome(
    state: dict[str, Any],
    lead_id: str,
    channel: str,
    outcome: str,
    note: str | None = None,
    actor: str | None = None,
    recipient: str | None = None,
) -> dict[str, Any]:
    lead = get_lead(state, lead_id)
    if lead.get("relationship") in {"suppressed", "customer", "closed"}:
        raise OutreachError("Lead is suppressed or closed")
    channel = clean_text(channel, 80) or "phone"
    outcome = clean_text(outcome, 120) or "logged"
    now = utc_now()
    engagement = {
        "engagement_id": new_id("eng"),
        "channel": channel,
        "intent": "manual",
        "status": "sent" if outcome not in {"replied", "no_answer", "refused"} else (
            "replied" if outcome == "replied" else "sent"
        ),
        "recipient": recipient
        or next(
            (
                p.get("value")
                for p in active_points(lead, channel)
                if isinstance(p, dict)
            ),
            channel,
        ),
        "subject": f"manual:{channel}",
        "body_text": note or "",
        "template_version": "manual-v1",
        "message_id": None,
        "created_at": now,
        "created_by": actor,
        "approved_at": now,
        "approved_by": actor,
        "sent_at": now,
        "failed_at": None,
        "failure_reason": None,
        "replied_at": now if outcome == "replied" else None,
        "outcome": outcome,
        "contact_point": {"channel": channel, "value": recipient},
    }
    if outcome == "replied":
        engagement["status"] = "replied"
        lead["relationship"] = "engaged"
        lead["next_eligible_at"] = None
    elif outcome in {"refused", "do_not_contact"}:
        lead["relationship"] = "suppressed"
        lead["suppression_reason"] = outcome
    elif lead.get("relationship") in {"new", "first_touch"}:
        lead["relationship"] = "waiting"
        config = state.get("config") or {}
        wait_days = int(config.get("wait_days") or DEFAULT_WAIT_DAYS)
        lead["next_eligible_at"] = (
            datetime.now(timezone.utc) + timedelta(days=wait_days)
        ).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    lead.setdefault("engagements", []).append(engagement)
    lead["updated_at"] = now
    lead["last_event_at"] = now
    append_audit(
        state,
        "manual_outcome_logged",
        lead_id=lead_id,
        engagement_id=engagement["engagement_id"],
        channel=channel,
        outcome=outcome,
        actor=actor,
    )
    return engagement


def mark_customer(
    state: dict[str, Any],
    lead_id: str,
    actor: str | None = None,
) -> dict[str, Any]:
    lead = get_lead(state, lead_id)
    lead["relationship"] = "customer"
    lead["suppression_reason"] = "existing_customer"
    lead["next_eligible_at"] = None
    for engagement in lead.get("engagements") or []:
        if isinstance(engagement, dict) and engagement.get("status") in {
            "draft",
            "approved",
            "queued",
        }:
            engagement["status"] = "cancelled"
            engagement["outcome"] = "customer"
    lead["updated_at"] = utc_now()
    append_audit(state, "lead_marked_customer", lead_id=lead_id, actor=actor)
    return lead


def status_summary(state: dict[str, Any]) -> dict[str, Any]:
    leads = state.get("leads") or {}
    by_relationship: dict[str, int] = {}
    engagement_by_status: dict[str, int] = {}
    for lead in leads.values():
        if not isinstance(lead, dict):
            continue
        rel = str(lead.get("relationship") or "unknown")
        by_relationship[rel] = by_relationship.get(rel, 0) + 1
        for engagement in lead.get("engagements") or []:
            if not isinstance(engagement, dict):
                continue
            st = str(engagement.get("status") or "unknown")
            engagement_by_status[st] = engagement_by_status.get(st, 0) + 1
    return {
        "workspace": state.get("workspace"),
        "lead_count": len(leads),
        "by_relationship": by_relationship,
        "engagements_by_status": engagement_by_status,
        "updated_at": state.get("updated_at"),
        "config": state.get("config"),
    }
