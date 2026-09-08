#!/usr/bin/env python3
"""clue-outreach CLI — durable multi-channel customer outreach."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

from email_channel import send_engagement_email
from state import (
    TOOL_NAME,
    TOOL_VERSION,
    OutreachError,
    approve_engagement,
    create_draft,
    default_paths,
    import_ready_records,
    load_state,
    log_manual_outcome,
    mark_bounce,
    mark_customer,
    mark_failed,
    mark_replied,
    mark_sent,
    read_json,
    reject_engagement,
    resolve_workspace_id,
    save_state,
    status_summary,
    suppress_lead,
    utc_now,
    workspaces_root,
    write_json_atomic,
)
from strategy import compute_next_tasks, tick


def emit(payload: Any, *, as_json: bool = True) -> None:
    if as_json:
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
        sys.stdout.write("\n")
    else:
        print(payload)


def load_workspace_state(workspace: str, state_path: Path | None = None) -> tuple[dict[str, Any], dict[str, Path]]:
    paths = default_paths(workspace)
    if state_path is not None:
        paths["state"] = state_path
    state = load_state(paths["state"], workspace)
    return state, paths


def cmd_version(_: argparse.Namespace) -> int:
    emit({"tool": TOOL_NAME, "version": TOOL_VERSION})
    return 0


def assert_business_command_allowed(command: str) -> None:
    if os.environ.get("POLARIS_BUSINESS_RUNTIME_MODE", "").strip() != "polaris":
        return
    if command in {"version", "status", "next", "show"}:
        return
    raise OutreachError(
        "integrated outreach actions require the Polaris durable action service"
    )


def cmd_status(args: argparse.Namespace) -> int:
    state, _ = load_workspace_state(args.workspace, Path(args.state) if args.state else None)
    summary = status_summary(state)
    if args.tasks:
        summary["tasks"] = compute_next_tasks(
            state,
            limit=args.limit,
            include_waiting=args.include_waiting,
        )
    emit(summary)
    return 0


def cmd_import(args: argparse.Namespace) -> int:
    state, paths = load_workspace_state(args.workspace, Path(args.state) if args.state else None)
    output_path = Path(args.output) if args.output else paths["output"]
    if not output_path.exists():
        raise OutreachError(f"Collection output not found: {output_path}")
    document = read_json(output_path)
    if not isinstance(document, dict):
        raise OutreachError("output.json must be a JSON object")
    result = import_ready_records(state, document, args.workspace, actor=args.actor)
    save_state(paths["state"], state, paths["log"])
    emit({"ok": True, "import": result, "state_path": str(paths["state"])})
    return 0


def cmd_sync(args: argparse.Namespace) -> int:
    """Synchronize a workflow collection into a standalone outreach stage.

    This imports eligible records and writes a provenance-bearing stage output.
    It never drafts or sends a message.
    """

    workspace = resolve_workspace_id(args.workspace)
    workspace_dir = (workspaces_root() / workspace).resolve()
    outreach_root = Path(args.outreach_root).expanduser().resolve()
    collection_output = Path(args.collection_output).expanduser().resolve()
    if workspace_dir not in outreach_root.parents:
        raise OutreachError("--outreach-root must be inside the selected workspace")
    if workspace_dir not in collection_output.parents:
        raise OutreachError("--collection-output must be inside the selected workspace")
    if not collection_output.is_file():
        raise OutreachError(f"Collection output not found: {collection_output}")

    for directory in ("case", "inputs", "work", "runs", "outputs"):
        (outreach_root / directory).mkdir(parents=True, exist_ok=True)

    document = read_json(collection_output)
    if not isinstance(document, dict):
        raise OutreachError("collection output must be a JSON object")
    state_path = outreach_root / "work" / "outreach-state.json"
    log_path = outreach_root / "outputs" / "outreach-log.jsonl"
    current = load_state(state_path, workspace)
    imported = import_ready_records(current, document, workspace, actor="workflow-sync")
    save_state(state_path, current, log_path)
    tasks = compute_next_tasks(current, limit=100, include_waiting=False)
    output_path = outreach_root / "outputs" / "output.json"
    output = {
        "schema_version": "clue.outreach.output.v1",
        "outreach_id": args.outreach_id,
        "workspace": workspace,
        "status": "ready",
        "generated_at": utc_now(),
        "collection_ref": {
            "collection_id": document.get("collection_id"),
            "collection_output_path": str(collection_output),
            "collection_output_sha256": (
                "sha256:"
                + hashlib.sha256(collection_output.read_bytes()).hexdigest()
            ),
        },
        "import": imported,
        "summary": status_summary(current),
        "next_task_count": len(tasks),
    }
    write_json_atomic(output_path, output)
    emit(
        {
            "ok": True,
            "outreach_output": str(output_path),
            "state_path": str(state_path),
            "import": imported,
        }
    )
    return 0


def cmd_next(args: argparse.Namespace) -> int:
    state, _ = load_workspace_state(args.workspace, Path(args.state) if args.state else None)
    tasks = compute_next_tasks(
        state,
        limit=args.limit,
        include_waiting=args.include_waiting,
    )
    emit({"workspace": resolve_workspace_id(args.workspace), "tasks": tasks, "count": len(tasks)})
    return 0


def cmd_draft(args: argparse.Namespace) -> int:
    state, paths = load_workspace_state(args.workspace, Path(args.state) if args.state else None)
    engagement = create_draft(
        state,
        args.lead_id,
        channel=args.channel,
        intent=args.intent,
        subject=args.subject,
        body_text=args.body,
        recipient=args.recipient,
        actor=args.actor,
    )
    save_state(paths["state"], state, paths["log"])
    emit({"ok": True, "engagement": engagement})
    return 0


def cmd_approve(args: argparse.Namespace) -> int:
    state, paths = load_workspace_state(args.workspace, Path(args.state) if args.state else None)
    engagement = approve_engagement(state, args.engagement_id, actor=args.actor)
    save_state(paths["state"], state, paths["log"])
    emit({"ok": True, "engagement": engagement})
    return 0


def cmd_reject(args: argparse.Namespace) -> int:
    state, paths = load_workspace_state(args.workspace, Path(args.state) if args.state else None)
    engagement = reject_engagement(
        state,
        args.engagement_id,
        actor=args.actor,
        reason=args.reason,
    )
    save_state(paths["state"], state, paths["log"])
    emit({"ok": True, "engagement": engagement})
    return 0


def cmd_send(args: argparse.Namespace) -> int:
    if args.live and os.environ.get("POLARIS_BUSINESS_RUNTIME_MODE", "").strip() == "polaris":
        raise OutreachError(
            "Integrated live outreach requires the Polaris durable action service"
        )
    state, paths = load_workspace_state(args.workspace, Path(args.state) if args.state else None)
    from state import find_engagement

    lead, engagement = find_engagement(state, args.engagement_id)
    dry_run = not args.live
    try:
        if engagement.get("channel") == "email":
            result = send_engagement_email(lead, engagement, dry_run=dry_run)
            mark_sent(
                state,
                args.engagement_id,
                message_id=result.get("message_id"),
                dry_run=dry_run,
                actor=args.actor,
            )
        else:
            # Non-email channels are operator-executed; mark sent when confirmed.
            mark_sent(
                state,
                args.engagement_id,
                message_id=None,
                dry_run=False,
                actor=args.actor,
            )
            result = {"channel": engagement.get("channel"), "manual": True}
    except OutreachError:
        raise
    except Exception as error:  # noqa: BLE001 — surface transport errors
        mark_failed(state, args.engagement_id, reason=str(error), actor=args.actor)
        save_state(paths["state"], state, paths["log"])
        emit({"ok": False, "error": str(error)})
        return 1
    save_state(paths["state"], state, paths["log"])
    _, updated = find_engagement(state, args.engagement_id)
    emit({"ok": True, "send": result, "engagement": updated})
    return 0


def cmd_log(args: argparse.Namespace) -> int:
    state, paths = load_workspace_state(args.workspace, Path(args.state) if args.state else None)
    engagement = log_manual_outcome(
        state,
        args.lead_id,
        channel=args.channel,
        outcome=args.outcome,
        note=args.note,
        actor=args.actor,
        recipient=args.recipient,
    )
    save_state(paths["state"], state, paths["log"])
    emit({"ok": True, "engagement": engagement})
    return 0


def cmd_suppress(args: argparse.Namespace) -> int:
    state, paths = load_workspace_state(args.workspace, Path(args.state) if args.state else None)
    lead = suppress_lead(state, args.lead_id, reason=args.reason, actor=args.actor)
    save_state(paths["state"], state, paths["log"])
    emit({"ok": True, "lead": lead})
    return 0


def cmd_reply(args: argparse.Namespace) -> int:
    state, paths = load_workspace_state(args.workspace, Path(args.state) if args.state else None)
    engagement = mark_replied(
        state,
        args.engagement_id,
        actor=args.actor,
        note=args.note,
    )
    save_state(paths["state"], state, paths["log"])
    emit({"ok": True, "engagement": engagement})
    return 0


def cmd_bounce(args: argparse.Namespace) -> int:
    state, paths = load_workspace_state(args.workspace, Path(args.state) if args.state else None)
    engagement = mark_bounce(
        state,
        args.engagement_id,
        hard=not args.soft,
        actor=args.actor,
    )
    save_state(paths["state"], state, paths["log"])
    emit({"ok": True, "engagement": engagement})
    return 0


def cmd_customer(args: argparse.Namespace) -> int:
    state, paths = load_workspace_state(args.workspace, Path(args.state) if args.state else None)
    lead = mark_customer(state, args.lead_id, actor=args.actor)
    save_state(paths["state"], state, paths["log"])
    emit({"ok": True, "lead": lead})
    return 0


def cmd_tick(args: argparse.Namespace) -> int:
    state, paths = load_workspace_state(args.workspace, Path(args.state) if args.state else None)
    result = tick(state, actor=args.actor or "tick")
    save_state(paths["state"], state, paths["log"])
    emit({"ok": True, **result})
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    state, _ = load_workspace_state(args.workspace, Path(args.state) if args.state else None)
    if args.lead_id:
        from state import get_lead

        emit(get_lead(state, args.lead_id))
        return 0
    emit(state)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="clue-outreach",
        description="Durable multi-channel customer outreach state machine",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add_ws(command: argparse.ArgumentParser) -> None:
        command.add_argument("--workspace", required=True, help="Workspace id")
        command.add_argument(
            "--state",
            default=None,
            help="Override outreach-state.json path (tests)",
        )

    p = sub.add_parser("version", help="Print tool version")
    p.set_defaults(func=cmd_version)

    p = sub.add_parser("status", help="Summarize outreach state")
    add_ws(p)
    p.add_argument("--tasks", action="store_true", help="Include next tasks")
    p.add_argument("--limit", type=int, default=50)
    p.add_argument("--include-waiting", action="store_true")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("import", help="Import outreach_ready_records")
    add_ws(p)
    p.add_argument(
        "--output",
        default=None,
        help="Path to collection outputs/output.json",
    )
    p.add_argument("--actor", default=None)
    p.set_defaults(func=cmd_import)

    p = sub.add_parser(
        "sync",
        help="Import workflow-ready records and write an outreach stage output",
    )
    p.add_argument("--workspace", required=True, help="Workspace id")
    p.add_argument("--collection-output", required=True)
    p.add_argument("--outreach-root", required=True)
    p.add_argument("--outreach-id", required=True)
    p.set_defaults(func=cmd_sync)

    p = sub.add_parser("next", help="List next operator tasks")
    add_ws(p)
    p.add_argument("--limit", type=int, default=50)
    p.add_argument("--include-waiting", action="store_true")
    p.set_defaults(func=cmd_next)

    p = sub.add_parser("draft", help="Create an engagement draft")
    add_ws(p)
    p.add_argument("--lead-id", required=True)
    p.add_argument("--channel", default="email")
    p.add_argument("--intent", default="first_touch")
    p.add_argument("--subject", default=None)
    p.add_argument("--body", default=None)
    p.add_argument("--recipient", default=None)
    p.add_argument("--actor", default=None)
    p.set_defaults(func=cmd_draft)

    p = sub.add_parser("approve", help="Approve a draft engagement")
    add_ws(p)
    p.add_argument("--engagement-id", required=True)
    p.add_argument("--actor", default=None)
    p.set_defaults(func=cmd_approve)

    p = sub.add_parser("reject", help="Cancel a draft/approved engagement")
    add_ws(p)
    p.add_argument("--engagement-id", required=True)
    p.add_argument("--reason", default=None)
    p.add_argument("--actor", default=None)
    p.set_defaults(func=cmd_reject)

    p = sub.add_parser("send", help="Send an approved engagement (dry-run default)")
    add_ws(p)
    p.add_argument("--engagement-id", required=True)
    p.add_argument(
        "--live",
        action="store_true",
        help="Actually SMTP-send email (standalone only; requires env credentials)",
    )
    p.add_argument("--actor", default=None)
    p.set_defaults(func=cmd_send)

    p = sub.add_parser("log", help="Log a manual channel outcome")
    add_ws(p)
    p.add_argument("--lead-id", required=True)
    p.add_argument("--channel", required=True)
    p.add_argument("--outcome", required=True)
    p.add_argument("--note", default=None)
    p.add_argument("--recipient", default=None)
    p.add_argument("--actor", default=None)
    p.set_defaults(func=cmd_log)

    p = sub.add_parser("suppress", help="Suppress a lead (stop outreach)")
    add_ws(p)
    p.add_argument("--lead-id", required=True)
    p.add_argument("--reason", required=True)
    p.add_argument("--actor", default=None)
    p.set_defaults(func=cmd_suppress)

    p = sub.add_parser("reply", help="Mark engagement replied")
    add_ws(p)
    p.add_argument("--engagement-id", required=True)
    p.add_argument("--note", default=None)
    p.add_argument("--actor", default=None)
    p.set_defaults(func=cmd_reply)

    p = sub.add_parser("bounce", help="Mark engagement bounce")
    add_ws(p)
    p.add_argument("--engagement-id", required=True)
    p.add_argument("--soft", action="store_true")
    p.add_argument("--actor", default=None)
    p.set_defaults(func=cmd_bounce)

    p = sub.add_parser("customer", help="Mark lead as existing customer")
    add_ws(p)
    p.add_argument("--lead-id", required=True)
    p.add_argument("--actor", default=None)
    p.set_defaults(func=cmd_customer)

    p = sub.add_parser("tick", help="Materialize due first-touch drafts")
    add_ws(p)
    p.add_argument("--actor", default="tick")
    p.set_defaults(func=cmd_tick)

    p = sub.add_parser("show", help="Show full state or one lead")
    add_ws(p)
    p.add_argument("--lead-id", default=None)
    p.set_defaults(func=cmd_show)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        assert_business_command_allowed(args.command)
        return int(args.func(args))
    except OutreachError as error:
        emit({"ok": False, "error": str(error)})
        return 2
    except BrokenPipeError:
        return 0


if __name__ == "__main__":
    sys.exit(main())
