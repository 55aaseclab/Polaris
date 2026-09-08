"""Next-task strategy for the durable outreach state machine."""

from __future__ import annotations

from typing import Any

from state import (
    AUTO_DRAFT_CHANNELS,
    DEFAULT_MAX_AUTO_TOUCHES,
    DEFAULT_WAIT_DAYS,
    MANUAL_CHANNELS,
    active_points,
    count_sent_auto,
    create_draft,
    parse_utc,
    utc_now,
)

# Task kinds operators care about in the queue UI.
TASK_KINDS = frozenset(
    {
        "approve_draft",
        "send_engagement",
        "retry_failed",
        "suggest_first_touch",
        "suggest_manual_channel",
        "handle_reply",
        "waiting",
    }
)

PRIORITY = {
    "handle_reply": 10,
    "retry_failed": 20,
    "approve_draft": 30,
    "send_engagement": 40,
    "suggest_first_touch": 50,
    "suggest_manual_channel": 60,
    "waiting": 90,
}


def _config_int(state: dict[str, Any], key: str, default: int) -> int:
    config = state.get("config") or {}
    value = config.get(key, default)
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _config_bool(state: dict[str, Any], key: str, default: bool) -> bool:
    config = state.get("config") or {}
    value = config.get(key, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return default


def _eligible_now(lead: dict[str, Any], now_iso: str | None = None) -> bool:
    next_at = parse_utc(lead.get("next_eligible_at"))
    if next_at is None:
        return True
    now = parse_utc(now_iso or utc_now())
    if now is None:
        return True
    # Compare aware datetimes.
    if next_at.tzinfo is None:
        from datetime import timezone

        next_at = next_at.replace(tzinfo=timezone.utc)
    if now.tzinfo is None:
        from datetime import timezone

        now = now.replace(tzinfo=timezone.utc)
    return now >= next_at


def _open_engagements(lead: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for engagement in lead.get("engagements") or []:
        if isinstance(engagement, dict) and engagement.get("status") in {
            "draft",
            "approved",
            "queued",
        }:
            result.append(engagement)
    return result


def _latest_replied(lead: dict[str, Any]) -> dict[str, Any] | None:
    replied = [
        e
        for e in (lead.get("engagements") or [])
        if isinstance(e, dict) and e.get("status") == "replied"
    ]
    if not replied:
        return None
    replied.sort(key=lambda item: item.get("replied_at") or item.get("sent_at") or "")
    return replied[-1]


def _failed_retryable(lead: dict[str, Any]) -> list[dict[str, Any]]:
    failed = []
    for engagement in lead.get("engagements") or []:
        if not isinstance(engagement, dict):
            continue
        if engagement.get("status") != "failed":
            continue
        reason = str(engagement.get("failure_reason") or "")
        if reason == "hard_bounce":
            continue
        failed.append(engagement)
    return failed


def _manual_channel_candidates(lead: dict[str, Any]) -> list[dict[str, Any]]:
    used_channels = {
        e.get("channel")
        for e in (lead.get("engagements") or [])
        if isinstance(e, dict) and e.get("status") in {"sent", "replied", "approved", "draft"}
    }
    candidates = []
    for point in lead.get("contact_points") or []:
        if not isinstance(point, dict):
            continue
        if point.get("status") != "active":
            continue
        channel = point.get("channel")
        if channel not in MANUAL_CHANNELS:
            continue
        if channel in used_channels:
            continue
        candidates.append(point)
    return candidates


def tasks_for_lead(state: dict[str, Any], lead: dict[str, Any]) -> list[dict[str, Any]]:
    lead_id = lead.get("lead_id")
    company = lead.get("company_name")
    relationship = lead.get("relationship")
    tasks: list[dict[str, Any]] = []

    if relationship in {"suppressed", "customer", "closed"}:
        return tasks

    if relationship == "engaged":
        replied = _latest_replied(lead)
        tasks.append(
            {
                "task_id": f"handle-reply:{lead_id}",
                "kind": "handle_reply",
                "priority": PRIORITY["handle_reply"],
                "lead_id": lead_id,
                "company_name": company,
                "engagement_id": (replied or {}).get("engagement_id"),
                "channel": (replied or {}).get("channel"),
                "title": "客户已回复，销售接手",
                "detail": "停止自动跟进；由负责人继续对话。",
                "action": "assign_or_note",
            }
        )
        return tasks

    for engagement in _open_engagements(lead):
        status = engagement.get("status")
        if status == "draft":
            tasks.append(
                {
                    "task_id": f"approve:{engagement.get('engagement_id')}",
                    "kind": "approve_draft",
                    "priority": PRIORITY["approve_draft"],
                    "lead_id": lead_id,
                    "company_name": company,
                    "engagement_id": engagement.get("engagement_id"),
                    "channel": engagement.get("channel"),
                    "title": "审批外联草稿",
                    "detail": engagement.get("subject") or engagement.get("intent"),
                    "action": "approve_or_reject",
                }
            )
        elif status in {"approved", "queued"}:
            tasks.append(
                {
                    "task_id": f"send:{engagement.get('engagement_id')}",
                    "kind": "send_engagement",
                    "priority": PRIORITY["send_engagement"],
                    "lead_id": lead_id,
                    "company_name": company,
                    "engagement_id": engagement.get("engagement_id"),
                    "channel": engagement.get("channel"),
                    "title": "发送已批准外联",
                    "detail": engagement.get("recipient"),
                    "action": "send",
                }
            )

    for engagement in _failed_retryable(lead):
        tasks.append(
            {
                "task_id": f"retry:{engagement.get('engagement_id')}",
                "kind": "retry_failed",
                "priority": PRIORITY["retry_failed"],
                "lead_id": lead_id,
                "company_name": company,
                "engagement_id": engagement.get("engagement_id"),
                "channel": engagement.get("channel"),
                "title": "处理发送失败",
                "detail": engagement.get("failure_reason") or "failed",
                "action": "retry_or_cancel",
            }
        )

    # If operator-facing open tasks already exist, do not also suggest new drafts.
    if any(t["kind"] in {"approve_draft", "send_engagement"} for t in tasks):
        return tasks

    max_auto = _config_int(state, "max_auto_touches", DEFAULT_MAX_AUTO_TOUCHES)
    auto_sent = count_sent_auto(lead)
    email_points = active_points(lead, "email")

    if (
        relationship in {"new", "first_touch"}
        and email_points
        and auto_sent < max_auto
        and not _open_engagements(lead)
    ):
        tasks.append(
            {
                "task_id": f"first-touch:{lead_id}",
                "kind": "suggest_first_touch",
                "priority": PRIORITY["suggest_first_touch"],
                "lead_id": lead_id,
                "company_name": company,
                "engagement_id": None,
                "channel": "email",
                "title": "建议：创建首封邮件草稿",
                "detail": email_points[0].get("value"),
                "action": "create_draft",
                "recipient": email_points[0].get("value"),
            }
        )
        return tasks

    if not _eligible_now(lead):
        tasks.append(
            {
                "task_id": f"waiting:{lead_id}",
                "kind": "waiting",
                "priority": PRIORITY["waiting"],
                "lead_id": lead_id,
                "company_name": company,
                "engagement_id": None,
                "channel": None,
                "title": "冷却中",
                "detail": f"next_eligible_at={lead.get('next_eligible_at')}",
                "action": "none",
                "next_eligible_at": lead.get("next_eligible_at"),
            }
        )
        return tasks

    # After wait window: optional manual multi-channel (P2/P3). Never auto-send.
    if relationship in {"waiting", "first_touch"} and auto_sent >= 1:
        manuals = _manual_channel_candidates(lead)
        if manuals:
            point = manuals[0]
            tasks.append(
                {
                    "task_id": f"manual:{lead_id}:{point.get('channel')}",
                    "kind": "suggest_manual_channel",
                    "priority": PRIORITY["suggest_manual_channel"],
                    "lead_id": lead_id,
                    "company_name": company,
                    "engagement_id": None,
                    "channel": point.get("channel"),
                    "title": f"建议：人工触达 ({point.get('channel')})",
                    "detail": point.get("value"),
                    "action": "log_manual_or_draft",
                    "recipient": point.get("value"),
                }
            )
            return tasks

        # Optional auto follow-up email draft only when explicitly enabled.
        if (
            _config_bool(state, "auto_follow_up", False)
            and email_points
            and auto_sent < max_auto + 1
        ):
            tasks.append(
                {
                    "task_id": f"follow-up:{lead_id}",
                    "kind": "suggest_first_touch",
                    "priority": PRIORITY["suggest_first_touch"],
                    "lead_id": lead_id,
                    "company_name": company,
                    "engagement_id": None,
                    "channel": "email",
                    "title": "建议：创建跟进邮件草稿",
                    "detail": email_points[0].get("value"),
                    "action": "create_draft",
                    "intent": "follow_up",
                    "recipient": email_points[0].get("value"),
                }
            )

    return tasks


def compute_next_tasks(
    state: dict[str, Any],
    *,
    limit: int = 50,
    include_waiting: bool = False,
) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    leads = state.get("leads") or {}
    if not isinstance(leads, dict):
        return []
    for lead in leads.values():
        if not isinstance(lead, dict):
            continue
        tasks.extend(tasks_for_lead(state, lead))

    if not include_waiting:
        tasks = [task for task in tasks if task.get("kind") != "waiting"]

    tasks.sort(
        key=lambda task: (
            int(task.get("priority") or 99),
            str(task.get("company_name") or ""),
            str(task.get("task_id") or ""),
        )
    )
    if limit > 0:
        return tasks[:limit]
    return tasks


def ensure_suggested_drafts(
    state: dict[str, Any],
    *,
    actor: str | None = "strategy",
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Materialize suggest_first_touch tasks into real drafts (still needs approve)."""

    created: list[dict[str, Any]] = []
    for task in compute_next_tasks(state, limit=limit, include_waiting=False):
        if task.get("kind") != "suggest_first_touch":
            continue
        if task.get("channel") not in AUTO_DRAFT_CHANNELS:
            continue
        lead_id = task.get("lead_id")
        if not isinstance(lead_id, str):
            continue
        engagement = create_draft(
            state,
            lead_id,
            channel="email",
            intent=str(task.get("intent") or "first_touch"),
            recipient=task.get("recipient") if isinstance(task.get("recipient"), str) else None,
            actor=actor,
        )
        created.append(engagement)
        if len(created) >= limit:
            break
    return created


def tick(state: dict[str, Any], *, actor: str | None = "tick") -> dict[str, Any]:
    """Time-based pass: materialize due first-touch drafts; report queue size."""

    created = ensure_suggested_drafts(state, actor=actor)
    tasks = compute_next_tasks(state, include_waiting=False)
    return {
        "drafts_created": len(created),
        "open_tasks": len(tasks),
        "tasks": tasks,
        "wait_days": _config_int(state, "wait_days", DEFAULT_WAIT_DAYS),
    }
