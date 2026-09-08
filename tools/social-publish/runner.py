#!/usr/bin/env python3
"""Contract-first social publish CLI (clue.social-publish.v1).

Adapters (browser / OAuth / sau submodule) are not wired yet. This module
validates input/output documents and returns structured not-implemented
results so callers and tests can freeze the v1 surface.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

TOOL_ROOT = Path(__file__).resolve().parent
REPO_ROOT = TOOL_ROOT.parents[1]
INPUT_SCHEMA_NAME = "clue.social-publish.input.v1"
OUTPUT_SCHEMA_NAME = "clue.social-publish.output.v1"
CLI_NAME = "clue-social-publish"

PLATFORMS = [
    "douyin",
    "kuaishou",
    "xiaohongshu",
    "bilibili",
    "channels",
    "baijiahao",
    "tiktok",
    "youtube",
    "instagram",
    "facebook",
    "x",
    "linkedin",
]


class CliError(RuntimeError):
    """User-facing CLI error."""


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_version() -> str:
    return (TOOL_ROOT / "VERSION").read_text(encoding="utf-8").strip()


def load_lock() -> dict[str, Any]:
    return json.loads((TOOL_ROOT / "backend.lock.json").read_text(encoding="utf-8"))


def schema_path(kind: str) -> Path:
    name = (
        "clue.social-publish.input.v1.schema.json"
        if kind == "input"
        else "clue.social-publish.output.v1.schema.json"
    )
    path = REPO_ROOT / "schemas" / name
    if not path.is_file():
        raise CliError(f"schema missing: {path}")
    return path


def load_schema(kind: str) -> dict[str, Any]:
    return json.loads(schema_path(kind).read_text(encoding="utf-8"))


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise CliError(f"file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise CliError(f"invalid JSON in {path}: {exc}") from exc


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def validate_with_schema(document: Any, kind: str) -> list[str]:
    """Return a list of error strings; empty means OK.

    Uses jsonschema when installed; otherwise applies a minimal structural
    check so offline CI without optional deps still works.
    """
    schema = load_schema(kind)
    try:
        import jsonschema
        from jsonschema import Draft202012Validator

        validator = Draft202012Validator(schema)
        return [
            f"{'/'.join(str(p) for p in err.path) or '<root>'}: {err.message}"
            for err in sorted(validator.iter_errors(document), key=lambda e: list(e.path))
        ]
    except ImportError:
        return _minimal_validate(document, kind)


def _minimal_validate(document: Any, kind: str) -> list[str]:
    errors: list[str] = []
    if not isinstance(document, dict):
        return ["<root>: must be an object"]
    expected = INPUT_SCHEMA_NAME if kind == "input" else OUTPUT_SCHEMA_NAME
    if document.get("schema_version") != expected:
        errors.append(f"schema_version: must be {expected!r}")
    if kind == "input":
        for key in (
            "publish_id",
            "platform",
            "account_id",
            "content_kind",
            "title",
            "media",
            "publish",
        ):
            if key not in document:
                errors.append(f"{key}: required")
        platform = document.get("platform")
        if platform is not None and platform not in PLATFORMS:
            errors.append(f"platform: unsupported value {platform!r}")
        media = document.get("media")
        if not isinstance(media, list) or not media:
            errors.append("media: must be a non-empty array")
        publish = document.get("publish")
        if not isinstance(publish, dict) or publish.get("mode") not in {
            "immediate",
            "scheduled",
        }:
            errors.append("publish.mode: must be immediate or scheduled")
        elif publish.get("mode") == "scheduled" and not publish.get("schedule_at"):
            errors.append("publish.schedule_at: required when mode is scheduled")
    else:
        for key in (
            "publish_id",
            "platform",
            "account_id",
            "status",
            "started_at",
            "cli",
            "adapter",
        ):
            if key not in document:
                errors.append(f"{key}: required")
    return errors


def stub_adapter_meta() -> dict[str, Any]:
    lock = load_lock()
    stub = (lock.get("adapters") or {}).get("stub") or {}
    return {
        "name": stub.get("name") or "stub",
        "version": stub.get("version") or read_version(),
        "backend_kind": stub.get("backend_kind") or "stub",
        "detail": {"note": stub.get("note")},
    }


def build_not_implemented_output(document: dict[str, Any]) -> dict[str, Any]:
    started = utc_now()
    return {
        "schema_version": OUTPUT_SCHEMA_NAME,
        "publish_id": document["publish_id"],
        "platform": document["platform"],
        "account_id": document["account_id"],
        "content_kind": document.get("content_kind"),
        "status": "failed_not_implemented",
        "started_at": started,
        "finished_at": utc_now(),
        "platform_post_id": None,
        "platform_url": None,
        "schedule_at": (document.get("publish") or {}).get("schedule_at"),
        "cli": {"name": CLI_NAME, "version": read_version()},
        "adapter": stub_adapter_meta(),
        "error": {
            "classification": "not_implemented",
            "message": (
                f"No publish adapter is wired for platform={document['platform']!r} yet. "
                "Contract validation succeeded; implement an adapter or set publish.dry_run "
                "and use planned status via a future dry-run path."
            ),
            "retryable": False,
            "resume_hint": (
                "Wire tools/social-publish adapters (e.g. sau.cli under "
                "third_party/social-auto-upload) then re-run publish."
            ),
        },
        "run_dir": None,
        "artifacts": [],
    }


def build_dry_run_output(document: dict[str, Any]) -> dict[str, Any]:
    started = utc_now()
    return {
        "schema_version": OUTPUT_SCHEMA_NAME,
        "publish_id": document["publish_id"],
        "platform": document["platform"],
        "account_id": document["account_id"],
        "content_kind": document.get("content_kind"),
        "status": "planned",
        "started_at": started,
        "finished_at": utc_now(),
        "platform_post_id": None,
        "platform_url": None,
        "schedule_at": (document.get("publish") or {}).get("schedule_at"),
        "cli": {"name": CLI_NAME, "version": read_version()},
        "adapter": stub_adapter_meta(),
        "error": None,
        "run_dir": None,
        "artifacts": [],
    }


def cmd_version(_: argparse.Namespace) -> int:
    lock = load_lock()
    print_json(
        {
            "cli": {"name": CLI_NAME, "version": read_version()},
            "contract": lock.get("contract"),
            "platforms": PLATFORMS,
            "adapters": {
                name: {
                    "name": meta.get("name"),
                    "version": meta.get("version"),
                    "backend_kind": meta.get("backend_kind"),
                }
                for name, meta in (lock.get("adapters") or {}).items()
                if isinstance(meta, dict)
            },
        }
    )
    return 0


def cmd_platforms(_: argparse.Namespace) -> int:
    print_json({"platforms": PLATFORMS})
    return 0


def cmd_validate_input(args: argparse.Namespace) -> int:
    path = Path(args.input).expanduser().resolve()
    document = read_json(path)
    errors = validate_with_schema(document, "input")
    if errors:
        print_json({"status": "invalid", "input": str(path), "errors": errors})
        return 1
    print_json(
        {
            "status": "valid",
            "input": str(path),
            "schema_version": document.get("schema_version"),
            "publish_id": document.get("publish_id"),
            "platform": document.get("platform"),
        }
    )
    return 0


def cmd_validate_output(args: argparse.Namespace) -> int:
    path = Path(args.input).expanduser().resolve()
    document = read_json(path)
    errors = validate_with_schema(document, "output")
    if errors:
        print_json({"status": "invalid", "input": str(path), "errors": errors})
        return 1
    print_json(
        {
            "status": "valid",
            "input": str(path),
            "schema_version": document.get("schema_version"),
            "publish_id": document.get("publish_id"),
            "result_status": document.get("status"),
        }
    )
    return 0


def cmd_publish(args: argparse.Namespace) -> int:
    path = Path(args.input).expanduser().resolve()
    document = read_json(path)
    errors = validate_with_schema(document, "input")
    if errors:
        print_json({"status": "invalid", "input": str(path), "errors": errors})
        return 1
    dry_run = bool((document.get("publish") or {}).get("dry_run"))
    if dry_run:
        result = build_dry_run_output(document)
    else:
        result = build_not_implemented_output(document)
    out_errors = validate_with_schema(result, "output")
    if out_errors:
        raise CliError("internal output failed schema validation: " + "; ".join(out_errors))
    if args.output:
        out_path = Path(args.output).expanduser().resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    print_json(result)
    if result["status"] == "planned":
        return 0
    return 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=CLI_NAME,
        description="Versioned social publish contract CLI (adapters optional).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("version", help="Print CLI version, contract paths, platforms.")
    sub.add_parser("platforms", help="List platform ids accepted by input.v1.")

    validate_in = sub.add_parser("validate-input", help="Validate a publish input JSON.")
    validate_in.add_argument("--input", required=True, help="Path to input JSON.")

    validate_out = sub.add_parser("validate-output", help="Validate a publish output JSON.")
    validate_out.add_argument("--input", required=True, help="Path to output JSON.")

    publish = sub.add_parser(
        "publish",
        help="Validate input and run publish (stub until adapters are wired).",
    )
    publish.add_argument("--input", required=True, help="Path to input JSON.")
    publish.add_argument(
        "--output",
        help="Optional path to write the output document.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "version":
            return cmd_version(args)
        if args.command == "platforms":
            return cmd_platforms(args)
        if args.command == "validate-input":
            return cmd_validate_input(args)
        if args.command == "validate-output":
            return cmd_validate_output(args)
        if args.command == "publish":
            if os.environ.get("POLARIS_BUSINESS_RUNTIME_MODE", "").strip() == "polaris":
                raise CliError(
                    "integrated social publishing requires the Polaris durable action service"
                )
            return cmd_publish(args)
        parser.error(f"unknown command: {args.command}")
        return 2
    except CliError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
