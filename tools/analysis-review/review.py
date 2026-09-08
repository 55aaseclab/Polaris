#!/usr/bin/env python3
"""Polaris-owned generic intelligence-finding review state.

The analysis executor emits ``clue.manual-review.v2``.  This adapter preserves
the source application's durable review semantics without importing a Portal
package: review keys are stable, decisions are bound to revision hashes, state
updates are audited and atomic, and export produces the versioned result
consumed by the literature finalizer.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


MANUAL_LIST_SCHEMA = "clue.manual-review.v2"
STATE_SCHEMA = "clue.manual-review.state.v2"
RESULT_SCHEMA = "clue.manual-review.result.v2"
REVIEW_STATUSES = {"pending", "approved", "rejected"}
POLARIS_PRODUCER = {"name": "polaris-literature-review"}


class AnalysisReviewError(Exception):
    """A bounded generic review-state or export error."""


class ReviewPaths:
    def __init__(self, manual_list: str | Path, state: str | Path, output: str | Path):
        self.manual_list = Path(manual_list).expanduser()
        self.state = Path(state).expanduser()
        self.output = Path(output).expanduser()


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def clone(value: Any) -> Any:
    return copy.deepcopy(value)


def canonical_json(value: Any) -> Any:
    if isinstance(value, list):
        return [canonical_json(item) for item in value]
    if isinstance(value, dict):
        return {key: canonical_json(value[key]) for key in sorted(value)}
    return value


def input_path(value: Path, label: str) -> Path:
    expanded = value.expanduser()
    if expanded.is_symlink():
        raise AnalysisReviewError(f"{label} must not be a symbolic link")
    resolved = expanded.resolve()
    if not resolved.is_file():
        raise AnalysisReviewError(f"{label} does not exist: {resolved}")
    return resolved


def output_path(value: Path, label: str) -> Path:
    expanded = value.expanduser()
    if expanded.is_symlink():
        raise AnalysisReviewError(f"{label} must not be a symbolic link")
    return expanded.resolve()


def read_json_object(path: Path, label: str) -> dict[str, Any]:
    path = input_path(path, label)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AnalysisReviewError(f"{label} is not valid UTF-8 JSON: {path}") from error
    if not isinstance(value, dict):
        raise AnalysisReviewError(f"{label} must contain a JSON object")
    return value


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path = output_path(path, "review output")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass


def require_string(value: Any, key: str, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AnalysisReviewError(f"{label} must contain a non-empty '{key}' string")
    return value


def require_object_list(document: dict[str, Any], key: str, label: str) -> list[dict[str, Any]]:
    value = document.get(key)
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise AnalysisReviewError(f"{label} must contain a '{key}' array of records")
    return value


def digest_file(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as error:
        raise AnalysisReviewError(f"cannot hash review source {path}: {error}") from error


def source_manifest(path: Path, document: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"path": str(path), "sha256": digest_file(path)}
    for key in ("generated_at", "source", "source_output", "source_run_id"):
        if key in document:
            result[key] = clone(document[key])
    return result


def audit_entries(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [clone(item) for item in value if isinstance(item, dict)][-100:]


def append_audit(state: dict[str, Any], entry: dict[str, Any]) -> None:
    audit = audit_entries(state.get("audit"))
    audit.append(clone(entry))
    state["audit"] = audit[-100:]


def sanitize_decision(value: Any, revision_hash: str) -> dict[str, Any] | None:
    if not isinstance(value, dict) or value.get("status") not in REVIEW_STATUSES:
        return None
    return {
        "note": value.get("note", "")[:5000]
        if isinstance(value.get("note", ""), str)
        else "",
        "revision_hash": revision_hash,
        "status": value["status"],
        "updated_at": value.get("updated_at")
        if isinstance(value.get("updated_at"), str)
        else utc_now(),
    }


class AnalysisReview:
    def __init__(self, paths: ReviewPaths):
        self.paths = ReviewPaths(
            input_path(paths.manual_list, "manual review input"),
            output_path(paths.state, "review state"),
            output_path(paths.output, "review output"),
        )
        self.manual_document = read_json_object(self.paths.manual_list, "manual review input")
        if self.manual_document.get("schema_version") != MANUAL_LIST_SCHEMA:
            raise AnalysisReviewError(
                f"manual review input must use {MANUAL_LIST_SCHEMA}"
            )
        self.review_set_id = require_string(
            self.manual_document.get("review_set_id"),
            "review_set_id",
            self.paths.manual_list.name,
        )
        self.review_kind = require_string(
            self.manual_document.get("review_kind"),
            "review_kind",
            self.paths.manual_list.name,
        )
        self.manual_records = require_object_list(
            self.manual_document,
            "review_records",
            self.paths.manual_list.name,
        )
        self.record_by_id: dict[str, dict[str, Any]] = {}
        self.review_key_by_record_id: dict[str, str] = {}
        self.revision_by_review_key: dict[str, str] = {}
        self._index_records()
        self.sources = {
            "manual_review_list": source_manifest(
                self.paths.manual_list, self.manual_document
            )
        }
        self.state = self._load_state()

    def _index_records(self) -> None:
        label = self.paths.manual_list.name
        for record in self.manual_records:
            record_id = require_string(record.get("record_id"), "record_id", label)
            review_key = require_string(record.get("review_key"), "review_key", label)
            revision_hash = require_string(
                record.get("revision_hash"), "revision_hash", label
            )
            require_string(record.get("title"), "title", label)
            require_string(record.get("summary"), "summary", label)
            evidence = require_object_list(record, "evidence", label)
            for item in evidence:
                require_string(item.get("source_url"), "source_url", label)
                require_string(item.get("source_excerpt"), "source_excerpt", label)
                require_string(item.get("observed_at"), "observed_at", label)
            if record_id in self.record_by_id:
                raise AnalysisReviewError(f"{label} has duplicate record_id: {record_id}")
            if review_key in self.revision_by_review_key:
                raise AnalysisReviewError(f"{label} has duplicate review_key: {review_key}")
            self.record_by_id[record_id] = record
            self.review_key_by_record_id[record_id] = review_key
            self.revision_by_review_key[review_key] = revision_hash

    def _empty_state(self) -> dict[str, Any]:
        now = utc_now()
        return {
            "audit": [],
            "created_at": now,
            "producer": clone(POLARIS_PRODUCER),
            "review_kind": self.review_kind,
            "review_set_id": self.review_set_id,
            "reviews": {},
            "schema_version": STATE_SCHEMA,
            "sources": clone(self.sources),
            "updated_at": now,
        }

    def _load_state(self) -> dict[str, Any]:
        if not self.paths.state.exists():
            return self._empty_state()
        state = read_json_object(self.paths.state, "review state")
        if state.get("schema_version") != STATE_SCHEMA:
            raise AnalysisReviewError("review state has an unsupported schema_version")
        if (
            state.get("review_set_id") != self.review_set_id
            or state.get("review_kind") != self.review_kind
        ):
            raise AnalysisReviewError(
                "review state belongs to another review_set_id or review_kind"
            )
        raw_reviews = state.get("reviews")
        if not isinstance(raw_reviews, dict):
            raise AnalysisReviewError("review state must contain a reviews object")
        reviews: dict[str, Any] = {}
        invalidated = 0
        for review_key, revision_hash in self.revision_by_review_key.items():
            stored = raw_reviews.get(review_key)
            if not isinstance(stored, dict):
                continue
            decision = sanitize_decision(stored, revision_hash)
            if decision is None:
                continue
            if stored.get("revision_hash") != revision_hash:
                invalidated += 1
                continue
            reviews[review_key] = decision
        refreshed = self._empty_state()
        if isinstance(state.get("created_at"), str):
            refreshed["created_at"] = state["created_at"]
        refreshed["reviews"] = reviews
        refreshed["audit"] = audit_entries(state.get("audit"))
        if canonical_json(state.get("sources")) != canonical_json(self.sources):
            append_audit(
                refreshed,
                {
                    "action": "source_reconciled",
                    "at": utc_now(),
                    "detail": "Review input changed; matching finding decisions were retained.",
                },
            )
        if invalidated:
            append_audit(
                refreshed,
                {
                    "action": "review_revision_invalidated",
                    "at": utc_now(),
                    "detail": (
                        f"Invalidated {invalidated} decision(s) because their finding "
                        "revision changed."
                    ),
                },
            )
        return refreshed

    def _reviews(self) -> dict[str, Any]:
        reviews = self.state.get("reviews")
        if not isinstance(reviews, dict):
            raise AnalysisReviewError("review state must contain a reviews object")
        return reviews

    def _decision(self, record_id: str) -> dict[str, Any]:
        review_key = self.review_key_by_record_id[record_id]
        decision = sanitize_decision(
            self._reviews().get(review_key),
            self.revision_by_review_key[review_key],
        )
        return decision or {
            "note": "",
            "revision_hash": self.revision_by_review_key[review_key],
            "status": "pending",
            "updated_at": None,
        }

    def bootstrap(self) -> dict[str, Any]:
        decisions: dict[str, Any] = {}
        for record_id in self.record_by_id:
            decision = self._decision(record_id)
            if decision["status"] != "pending" or decision["note"]:
                decisions[record_id] = decision
        return {
            "paths": {
                "result_file": str(self.paths.output),
                "state_file": str(self.paths.state),
            },
            "review_kind": self.review_kind,
            "review_records": clone(self.manual_records),
            "review_set_id": self.review_set_id,
            "reviews": decisions,
            "sources": clone(self.sources),
            "summary": self._summary(),
            "tool": clone(POLARIS_PRODUCER),
        }

    def save(self, record_id: str, status: str, note: str) -> dict[str, Any]:
        if not record_id.strip():
            raise AnalysisReviewError("Review request requires record_id")
        if record_id not in self.record_by_id:
            raise AnalysisReviewError("record_id is not in the manual review list")
        if status not in REVIEW_STATUSES:
            raise AnalysisReviewError("status must be pending, approved or rejected")
        if not isinstance(note, str) or len(note) > 5000:
            raise AnalysisReviewError("note must be a string up to 5000 characters")
        review_key = self.review_key_by_record_id[record_id]
        revision_hash = self.revision_by_review_key[review_key]
        decision = {
            "note": note,
            "revision_hash": revision_hash,
            "status": status,
            "updated_at": utc_now(),
        }
        reviews = self._reviews()
        if status == "pending" and not note.strip():
            reviews.pop(review_key, None)
        else:
            reviews[review_key] = decision
        append_audit(
            self.state,
            {
                "action": "review_saved",
                "at": decision["updated_at"],
                "record_id": record_id,
                "review_key": review_key,
                "status": status,
            },
        )
        self._persist_state()
        return {"review": self._decision(record_id), "summary": self._summary()}

    def _summary(self) -> dict[str, int]:
        counts = {"approved": 0, "pending": 0, "rejected": 0}
        for record_id in self.record_by_id:
            counts[self._decision(record_id)["status"]] += 1
        return {
            "approved": counts["approved"],
            "pending": counts["pending"],
            "rejected": counts["rejected"],
            "review_total": len(self.manual_records),
        }

    def export_document(self) -> dict[str, Any]:
        grouped = {status: [] for status in REVIEW_STATUSES}
        for record_id, record in self.record_by_id.items():
            decision = self._decision(record_id)
            grouped[decision["status"]].append(
                {
                    **clone(record),
                    "manual_review": {
                        **decision,
                        "status": decision["status"],
                    },
                }
            )
        return {
            "approval_mode": "manual",
            "approved_records": grouped["approved"],
            "generated_at": utc_now(),
            "pending_records": grouped["pending"],
            "producer": clone(POLARIS_PRODUCER),
            "rejected_records": grouped["rejected"],
            "review_kind": self.review_kind,
            "review_set_id": self.review_set_id,
            "review_state": {
                "identity_strategy": "review_key plus revision_hash",
                "path": str(self.paths.state),
                "updated_at": self.state["updated_at"],
            },
            "schema_version": RESULT_SCHEMA,
            "sources": clone(self.sources),
            "summary": self._summary(),
        }

    def export(self) -> dict[str, Any]:
        payload = self.export_document()
        atomic_write_json(self.paths.output, payload)
        return {
            "approved_count": len(payload["approved_records"]),
            "output": str(self.paths.output),
            "pending_count": len(payload["pending_records"]),
            "rejected_count": len(payload["rejected_records"]),
            "summary": payload["summary"],
        }

    def _persist_state(self) -> None:
        self.state["updated_at"] = utc_now()
        self.state["sources"] = clone(self.sources)
        atomic_write_json(self.paths.state, self.state)


def paths_from_args(args: argparse.Namespace) -> ReviewPaths:
    return ReviewPaths(args.manual_list, args.state, args.output)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="polaris-literature-analysis-review",
        description="Polaris-owned intelligence-finding review state and export.",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    def add_paths(command: argparse.ArgumentParser) -> None:
        command.add_argument("--manual-list", required=True)
        command.add_argument("--state", required=True)
        command.add_argument("--output", required=True)

    add_paths(commands.add_parser("bootstrap"))
    save = commands.add_parser("save")
    add_paths(save)
    save.add_argument("--record-id", required=True)
    save.add_argument("--status", required=True, choices=sorted(REVIEW_STATUSES))
    save.add_argument("--note", required=True)
    add_paths(commands.add_parser("export"))
    return parser


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    try:
        review = AnalysisReview(paths_from_args(args))
        if args.command == "bootstrap":
            value = review.bootstrap()
        elif args.command == "save":
            value = review.save(args.record_id, args.status, args.note)
        elif args.command == "export":
            value = review.export()
        else:
            raise AnalysisReviewError(f"unsupported command: {args.command}")
        print(json.dumps(value, ensure_ascii=False, indent=2))
        return 0
    except (AnalysisReviewError, OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
