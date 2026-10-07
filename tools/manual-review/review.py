#!/usr/bin/env python3
"""Polaris-owned manual-review state and export semantics.

The literature collector deliberately stops at phase 3 when
``review_mode=manual-review``.  This module owns the durable continuation that
used to live in the source application's portal support: stable review
identities, atomic state updates, audit entries, source reconciliation, and a
review-output export.  The workflow runner then converts a completed export
back into the literature collection v2 handoff.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import sys
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


MANUAL_LIST_SCHEMA = "clue.data-collection.review-list.v1"
NON_REVIEW_SCHEMA = "clue.data-collection.non-review.v1"
COLLECTION_STATE_SCHEMA = "clue.data-collection.review-state.v1"
COLLECTION_RESULT_SCHEMA = "clue.data-collection.review-output.v1"
COLLECTION_OUTPUT_SCHEMA = "clue.data-collection.output.v2"
REVIEW_STATUSES = {"pending", "approved", "rejected"}
POLARIS_PRODUCER = {"name": "polaris-manual-review"}


class ManualReviewError(Exception):
    """A bounded review-state or review-export error."""


@dataclass(frozen=True)
class ManualReviewPaths:
    manual_list: Path
    non_review: Path
    state: Path
    output: Path

    @classmethod
    def from_values(
        cls,
        *,
        manual_list: str | Path,
        non_review: str | Path,
        state: str | Path,
        output: str | Path,
    ) -> "ManualReviewPaths":
        return cls(
            manual_list=Path(manual_list).expanduser(),
            non_review=Path(non_review).expanduser(),
            state=Path(state).expanduser(),
            output=Path(output).expanduser(),
        )


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def clone(value: Any) -> Any:
    return copy.deepcopy(value)


def canonical_json(value: Any) -> Any:
    if isinstance(value, list):
        return [canonical_json(item) for item in value]
    if isinstance(value, dict):
        return {
            key: canonical_json(value[key])
            for key in sorted(value)
        }
    return value


def equal_json(left: Any, right: Any) -> bool:
    return canonical_json(left) == canonical_json(right)


def require_string(value: Any, key: str, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ManualReviewError(f"{label} must contain a non-empty '{key}' string")
    return value


def input_path(value: Path, label: str) -> Path:
    expanded = value.expanduser()
    if expanded.is_symlink():
        raise ManualReviewError(f"{label} must not be a symbolic link")
    resolved = expanded.resolve()
    if not resolved.is_file():
        raise ManualReviewError(f"{label} does not exist: {resolved}")
    return resolved


def output_path(value: Path, label: str) -> Path:
    expanded = value.expanduser()
    if expanded.is_symlink():
        raise ManualReviewError(f"{label} must not be a symbolic link")
    return expanded.resolve()


def read_json_object(path: Path, label: str) -> dict[str, Any]:
    path = input_path(path, label)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ManualReviewError(f"{label} is not valid UTF-8 JSON: {path}") from error
    if not isinstance(value, dict):
        raise ManualReviewError(f"{label} must contain a JSON object")
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


def require_object_list(document: dict[str, Any], key: str, label: str) -> list[dict[str, Any]]:
    value = document.get(key)
    if not isinstance(value, list) or any(
        not isinstance(item, dict) for item in value
    ):
        raise ManualReviewError(f"{label} must contain a '{key}' array of records")
    return value


def digest_file(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as error:
        raise ManualReviewError(f"cannot hash review source {path}: {error}") from error


def source_manifest(path: Path, document: dict[str, Any]) -> dict[str, Any]:
    manifest: dict[str, Any] = {
        "path": str(path),
        "sha256": digest_file(path),
    }
    for key in ("generated_at", "source_output", "source_run_id"):
        if key in document:
            manifest[key] = document[key]
    return manifest


def sanitize_decision(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    status = value.get("status")
    if status not in REVIEW_STATUSES:
        return None
    note = value.get("note")
    updated_at = value.get("updated_at")
    return {
        "note": note[:5000] if isinstance(note, str) else "",
        "status": status,
        "updated_at": updated_at if isinstance(updated_at, str) else utc_now(),
    }


def audit_entries(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    entries = [clone(item) for item in value if isinstance(item, dict)]
    return entries[-100:]


def append_audit(state: dict[str, Any], entry: dict[str, Any]) -> None:
    audit = audit_entries(state.get("audit"))
    audit.append(clone(entry))
    state["audit"] = audit[-100:]


class ManualReview:
    """Implement durable manual-review state independently of any portal app."""

    def __init__(self, paths: ManualReviewPaths):
        self.paths = ManualReviewPaths(
            manual_list=input_path(paths.manual_list, "manual review input"),
            non_review=input_path(paths.non_review, "non-review input"),
            state=output_path(paths.state, "review state"),
            output=output_path(paths.output, "review output"),
        )
        self.manual_document = read_json_object(
            self.paths.manual_list, "manual review input"
        )
        self.non_review_document = read_json_object(
            self.paths.non_review, "non-review input"
        )
        self._validate_source_documents()
        self.collection_id = require_string(
            self.manual_document.get("collection_id"),
            "collection_id",
            self.paths.manual_list.name,
        )
        if self.non_review_document.get("collection_id") != self.collection_id:
            raise ManualReviewError(
                "manual-review-list.json and non-review-results.json belong to "
                "different collection_id values"
            )
        self.manual_records = require_object_list(
            self.manual_document,
            "review_records",
            self.paths.manual_list.name,
        )
        self.automatic_records = require_object_list(
            self.non_review_document,
            "qualified_without_manual_review",
            self.paths.non_review.name,
        )
        self.source_rejected_records = require_object_list(
            self.non_review_document,
            "rejected_records",
            self.paths.non_review.name,
        )
        self.manual_by_record_id: dict[str, dict[str, Any]] = {}
        self.review_key_by_record_id: dict[str, str] = {}
        self.manual_by_review_key: set[str] = set()
        self._index_manual_records()
        automatic_ids = [
            require_string(item.get("record_id"), "record_id", self.paths.non_review.name)
            for item in self.automatic_records
        ]
        if len(set(automatic_ids)) != len(automatic_ids):
            raise ManualReviewError(
                f"{self.paths.non_review.name} has duplicate record_id values"
            )
        overlap = set(automatic_ids) & set(self.manual_by_record_id)
        if overlap:
            raise ManualReviewError(
                "manual and non-review records share record_id values: "
                + ", ".join(sorted(overlap))
            )
        self.sources = {
            "manual_review_list": source_manifest(
                self.paths.manual_list, self.manual_document
            ),
            "non_review_results": source_manifest(
                self.paths.non_review, self.non_review_document
            ),
        }
        self.state = self._load_state()

    def _validate_source_documents(self) -> None:
        if self.manual_document.get("schema_version") not in {
            None,
            MANUAL_LIST_SCHEMA,
        }:
            raise ManualReviewError(
                f"manual review input must use {MANUAL_LIST_SCHEMA}"
            )
        if self.non_review_document.get("schema_version") not in {
            None,
            NON_REVIEW_SCHEMA,
        }:
            raise ManualReviewError(
                f"non-review input must use {NON_REVIEW_SCHEMA}"
            )
        for document, label in (
            (self.manual_document, "manual review input"),
            (self.non_review_document, "non-review input"),
        ):
            kind = document.get("collection_kind")
            if kind not in {None, "literature"}:
                raise ManualReviewError(
                    f"{label} must use collection_kind=literature"
                )

    def _index_manual_records(self) -> None:
        for record in self.manual_records:
            record_id = require_string(
                record.get("record_id"), "record_id", self.paths.manual_list.name
            )
            if record_id in self.manual_by_record_id:
                raise ManualReviewError(
                    f"{self.paths.manual_list.name} has duplicate record_id: {record_id}"
                )
            review_key = self._review_key_for_record(record)
            if review_key in self.manual_by_review_key:
                raise ManualReviewError(
                    f"{self.paths.manual_list.name} has duplicate durable review "
                    f"identity: {review_key}"
                )
            self.manual_by_record_id[record_id] = record
            self.manual_by_review_key.add(review_key)
            self.review_key_by_record_id[record_id] = review_key

    def _review_key_for_record(self, record: dict[str, Any]) -> str:
        deduplication = record.get("deduplication")
        if isinstance(deduplication, dict):
            candidate_id = deduplication.get("duplicate_group_id")
            if isinstance(candidate_id, str) and candidate_id.strip():
                return f"candidate:{candidate_id}"
        record_id = require_string(
            record.get("record_id"), "record_id", self.paths.manual_list.name
        )
        return f"record:{record_id}"

    def _empty_state(self) -> dict[str, Any]:
        now = utc_now()
        return {
            "audit": [],
            "collection_id": self.collection_id,
            "created_at": now,
            "producer": clone(POLARIS_PRODUCER),
            "reviews": {},
            "schema_version": COLLECTION_STATE_SCHEMA,
            "sources": clone(self.sources),
            "updated_at": now,
        }

    def _load_state(self) -> dict[str, Any]:
        if not self.paths.state.exists():
            return self._empty_state()
        state = read_json_object(self.paths.state, "review state")
        if state.get("schema_version") != COLLECTION_STATE_SCHEMA:
            raise ManualReviewError(
                "review state has an unsupported schema_version"
            )
        if state.get("collection_id") != self.collection_id:
            raise ManualReviewError(
                "review state belongs to another collection_id; choose another "
                "state path"
            )
        raw_reviews = state.get("reviews")
        if not isinstance(raw_reviews, dict):
            raise ManualReviewError("review state must contain a reviews object")
        reviews: dict[str, dict[str, Any]] = {}
        migrated_legacy_keys = 0
        for stored_key, value in raw_reviews.items():
            review_key = (
                stored_key
                if stored_key in self.manual_by_review_key
                else self.review_key_by_record_id.get(stored_key)
            )
            if review_key is None:
                continue
            decision = sanitize_decision(value)
            if decision is None:
                continue
            reviews[review_key] = decision
            if stored_key != review_key:
                migrated_legacy_keys += 1

        refreshed = self._empty_state()
        if isinstance(state.get("created_at"), str):
            refreshed["created_at"] = state["created_at"]
        refreshed["reviews"] = reviews
        refreshed["audit"] = audit_entries(state.get("audit"))
        if not equal_json(state.get("sources"), self.sources):
            append_audit(
                refreshed,
                {
                    "action": "source_reconciled",
                    "at": utc_now(),
                    "detail": "Source result files changed; matching decisions were retained.",
                },
            )
        if migrated_legacy_keys:
            append_audit(
                refreshed,
                {
                    "action": "review_identity_migrated",
                    "at": utc_now(),
                    "detail": (
                        f"Migrated {migrated_legacy_keys} saved decision(s) to stable "
                        "review keys."
                    ),
                },
            )
        return refreshed

    def _reviews(self) -> dict[str, Any]:
        reviews = self.state.get("reviews")
        if not isinstance(reviews, dict):
            raise ManualReviewError("review state must contain a reviews object")
        return reviews

    def _decision_for_record_id(self, record_id: str) -> dict[str, Any]:
        review_key = self.review_key_by_record_id.get(record_id)
        decision = sanitize_decision(self._reviews().get(review_key)) if review_key else None
        return decision or {"note": "", "status": "pending", "updated_at": None}

    def _reviewed_record(self, record: dict[str, Any], status: str) -> dict[str, Any]:
        record_id = require_string(
            record.get("record_id"), "record_id", self.paths.manual_list.name
        )
        return {
            **clone(record),
            "manual_review": {
                **self._decision_for_record_id(record_id),
                "status": status,
            },
        }

    def _summary(self) -> dict[str, int]:
        counts = {"approved": 0, "pending": 0, "rejected": 0}
        for record_id in self.manual_by_record_id:
            counts[self._decision_for_record_id(record_id)["status"]] += 1
        return {
            "automatic_qualified": len(self.automatic_records),
            "manual_review_approved": counts["approved"],
            "manual_review_pending": counts["pending"],
            "manual_review_rejected": counts["rejected"],
            "manual_review_total": len(self.manual_records),
            "source_rejected": len(self.source_rejected_records),
        }

    def bootstrap(self) -> dict[str, Any]:
        decisions: dict[str, Any] = {}
        for record_id in self.manual_by_record_id:
            decision = self._decision_for_record_id(record_id)
            if decision["status"] != "pending" or decision["note"]:
                decisions[record_id] = decision
        return {
            "collection_id": self.collection_id,
            "paths": {
                "result_file": str(self.paths.output),
                "state_file": str(self.paths.state),
            },
            "qualified_without_manual_review": clone(self.automatic_records),
            "rejected_records": clone(self.source_rejected_records),
            "review_records": clone(self.manual_records),
            "reviews": decisions,
            "sources": clone(self.sources),
            "summary": self._summary(),
            "tool": clone(POLARIS_PRODUCER),
        }

    def save(self, record_id: str, status: Any, note: Any) -> dict[str, Any]:
        if not record_id.strip():
            raise ManualReviewError("Review request requires record_id")
        if record_id not in self.manual_by_record_id:
            raise ManualReviewError("record_id is not in the manual review list")
        if status not in REVIEW_STATUSES:
            raise ManualReviewError(
                "status must be pending, approved or rejected"
            )
        if not isinstance(note, str) or len(note) > 5000:
            raise ManualReviewError("note must be a string up to 5000 characters")
        review_key = self.review_key_by_record_id[record_id]
        decision = {
            "note": note,
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
        return {
            "review": self._decision_for_record_id(record_id),
            "summary": self._summary(),
        }

    def build_export(self) -> dict[str, Any]:
        approved: list[dict[str, Any]] = []
        rejected: list[dict[str, Any]] = []
        pending: list[dict[str, Any]] = []
        for record in self.manual_records:
            record_id = require_string(
                record.get("record_id"), "record_id", self.paths.manual_list.name
            )
            decision = self._decision_for_record_id(record_id)
            reviewed = self._reviewed_record(record, decision["status"])
            if decision["status"] == "approved":
                approved.append(reviewed)
            elif decision["status"] == "rejected":
                rejected.append(reviewed)
            else:
                pending.append(reviewed)
        automatic_ready = [
            {
                **clone(record),
                "manual_review": {
                    "note": "Automatically qualified; no manual review was required.",
                    "status": "not_required",
                    "updated_at": None,
                },
            }
            for record in self.automatic_records
        ]
        return {
            "collection_id": self.collection_id,
            "generated_at": utc_now(),
            "manually_rejected_records": rejected,
            "outreach_ready_records": [*automatic_ready, *approved],
            "pending_manual_review_records": pending,
            "producer": clone(POLARIS_PRODUCER),
            "review_state": {
                "identity_strategy": (
                    "deduplication.duplicate_group_id (fallback: record_id)"
                ),
                "path": str(self.paths.state),
                "updated_at": self.state["updated_at"],
            },
            "schema_version": COLLECTION_RESULT_SCHEMA,
            "source_rejected_records": clone(self.source_rejected_records),
            "sources": clone(self.sources),
            "summary": self._summary(),
        }

    def export(self) -> dict[str, Any]:
        payload = self.build_export()
        atomic_write_json(self.paths.output, payload)
        return {
            "manually_rejected_count": len(payload["manually_rejected_records"]),
            "output": str(self.paths.output),
            "outreach_ready_count": len(payload["outreach_ready_records"]),
            "pending_manual_review_count": len(payload["pending_manual_review_records"]),
            "summary": payload["summary"],
        }

    def finalize_collection_output(
        self,
        base_output: dict[str, Any],
        *,
        review_output: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Convert a completed review export to a final literature v2 output."""
        if base_output.get("schema_version") != COLLECTION_OUTPUT_SCHEMA:
            raise ManualReviewError(
                f"collection output must use {COLLECTION_OUTPUT_SCHEMA}"
            )
        if base_output.get("collection_id") != self.collection_id:
            raise ManualReviewError(
                "collection output and manual review list belong to different collection_id values"
            )
        if base_output.get("collection_kind") != "literature":
            raise ManualReviewError("collection output must use collection_kind=literature")
        if base_output.get("status") != "pending_manual_review":
            raise ManualReviewError(
                "collection output must be pending_manual_review before completion"
            )
        payload = review_output or self.build_export()
        if payload.get("schema_version") != COLLECTION_RESULT_SCHEMA:
            raise ManualReviewError(
                f"review output must use {COLLECTION_RESULT_SCHEMA}"
            )
        if payload.get("collection_id") != self.collection_id:
            raise ManualReviewError(
                "review output and manual review list belong to different collection_id values"
            )
        if not equal_json(payload.get("sources"), self.sources):
            raise ManualReviewError(
                "review output was produced from different collection source files"
            )
        pending = payload.get("pending_manual_review_records")
        ready = payload.get("outreach_ready_records")
        manually_rejected = payload.get("manually_rejected_records")
        source_rejected = payload.get("source_rejected_records")
        if not all(
            isinstance(items, list)
            for items in (pending, ready, manually_rejected, source_rejected)
        ):
            raise ManualReviewError("review output has an invalid record grouping")
        if pending:
            raise ManualReviewError(
                "collection review is still pending; resolve every record before continuation"
            )

        base_records = require_object_list(base_output, "records", "collection output")
        base_id_list = [
            require_string(item.get("record_id"), "record_id", "collection output")
            for item in base_records
        ]
        if len(set(base_id_list)) != len(base_id_list):
            raise ManualReviewError("collection output contains duplicate record_id values")
        base_ids = set(base_id_list)
        reviewed_ids = {
            require_string(item.get("record_id"), "record_id", "review output")
            for item in [*ready, *manually_rejected]
        }
        if len(reviewed_ids) != len([*ready, *manually_rejected]):
            raise ManualReviewError(
                "review output contains duplicate record_id values"
            )
        if not reviewed_ids.issubset(base_ids):
            missing = sorted(reviewed_ids - base_ids)
            raise ManualReviewError(
                "review output contains records not present in the pending collection: "
                + ", ".join(missing)
            )
        expected_review_ids = set(self.manual_by_record_id)
        automatic_ids = {
            require_string(item.get("record_id"), "record_id", "non-review input")
            for item in self.automatic_records
        }
        expected_ids = expected_review_ids | automatic_ids
        if base_ids != expected_ids:
            missing = sorted(expected_ids - base_ids)
            extra = sorted(base_ids - expected_ids)
            detail = []
            if missing:
                detail.append("missing=" + ",".join(missing))
            if extra:
                detail.append("extra=" + ",".join(extra))
            raise ManualReviewError(
                "pending collection does not match its review records ("
                + "; ".join(detail)
                + ")"
            )
        if reviewed_ids != expected_ids:
            missing = sorted(expected_ids - reviewed_ids)
            extra = sorted(reviewed_ids - expected_ids)
            detail = []
            if missing:
                detail.append("missing=" + ",".join(missing))
            if extra:
                detail.append("extra=" + ",".join(extra))
            raise ManualReviewError(
                "review output does not cover the pending collection records ("
                + "; ".join(detail)
                + ")"
            )
        for item in ready:
            record_id = item["record_id"]
            decision = item.get("manual_review")
            if not isinstance(decision, dict):
                raise ManualReviewError(
                    f"review output is missing manual_review for {record_id}"
                )
            expected_status = (
                "not_required" if record_id in automatic_ids else "approved"
            )
            if decision.get("status") != expected_status:
                raise ManualReviewError(
                    f"review output has an invalid ready status for {record_id}"
                )
        for item in manually_rejected:
            decision = item.get("manual_review")
            if not isinstance(decision, dict) or decision.get("status") != "rejected":
                raise ManualReviewError(
                    "review output has an invalid rejected status"
                )

        final = clone(base_output)
        final["status"] = "final"
        final["records"] = clone(ready)
        final["rejected_records"] = [
            *clone(source_rejected),
            *clone(manually_rejected),
        ]
        pipeline = dict(final.get("pipeline") or {})
        pipeline.update(
            {
                "manual_review": "completed",
                "review_mode": "manual-review",
                "manual_review_list": str(self.paths.manual_list),
                "non_review_results": str(self.paths.non_review),
                "manual_review_result": str(self.paths.output),
                "manual_review_state": str(self.paths.state),
            }
        )
        phases = pipeline.get("phases")
        if isinstance(phases, list):
            refreshed_phases = []
            for phase in phases:
                if isinstance(phase, dict) and phase.get("phase") == "manual-review":
                    refreshed = {
                        **phase,
                        "status": "completed",
                        "pending_count": 0,
                        "approved_count": len(ready),
                        "rejected_count": len(manually_rejected),
                    }
                    refreshed_phases.append(refreshed)
                else:
                    refreshed_phases.append(phase)
            pipeline["phases"] = refreshed_phases
        final["pipeline"] = pipeline
        return final

    def _persist_state(self) -> None:
        self.state["updated_at"] = utc_now()
        self.state["sources"] = clone(self.sources)
        atomic_write_json(self.paths.state, self.state)


def paths_from_args(args: argparse.Namespace) -> ManualReviewPaths:
    return ManualReviewPaths.from_values(
        manual_list=args.manual_list,
        non_review=args.non_review,
        state=args.state,
        output=args.output,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="polaris-manual-review",
        description="Polaris-owned manual-review state and export.",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    def add_paths(command: argparse.ArgumentParser) -> None:
        command.add_argument("--manual-list", required=True)
        command.add_argument("--non-review", required=True)
        command.add_argument("--state", required=True)
        command.add_argument("--output", required=True)

    bootstrap = commands.add_parser("bootstrap")
    add_paths(bootstrap)

    save = commands.add_parser("save")
    add_paths(save)
    save.add_argument("--record-id", required=True)
    save.add_argument("--status", required=True, choices=sorted(REVIEW_STATUSES))
    save.add_argument("--note", required=True)

    export = commands.add_parser("export")
    add_paths(export)

    complete = commands.add_parser("complete")
    add_paths(complete)
    complete.add_argument("--collection-output", required=True)

    workflow = commands.add_parser("review")
    workflow.add_argument("--input", required=True)
    workflow.add_argument("--output", required=True)
    return parser


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "review":
            request = read_json_object(Path(args.input), "review input")
            payload = request.get("input")
            if not isinstance(payload, dict):
                payload = request
            source = payload.get("capturedCollectionRef")
            if not isinstance(source, str) or not source.strip():
                if payload.get("reviewMode") == "auto-approve":
                    reviewed = {
                        "schema_version": request.get("schema_version"),
                        "reviewedCollectionRef": str(Path(args.output).resolve()),
                        "reviewStatus": "approved",
                        "status": "approved",
                        "records": [],
                        "pipeline": {"boundary": "manual-review", "status": "approved"},
                    }
                    atomic_write_json(Path(args.output), reviewed)
                    print(json.dumps({
                        "reviewedCollectionRef": str(Path(args.output).resolve()),
                        "reviewCount": 0,
                        "reviewStatus": "approved",
                    }, ensure_ascii=False, indent=2))
                    return 0
                raise ManualReviewError("review input requires capturedCollectionRef")
            collection = read_json_object(Path(source), "captured collection")
            records = require_object_list(collection, "records", "captured collection")
            reviewed_records = [{
                **record,
                "manual_review": {"status": "approved", "note": "", "updated_at": None},
            } for record in records]
            reviewed = {
                **collection,
                "reviewedCollectionRef": str(Path(args.output).resolve()),
                "reviewStatus": "approved",
                "status": "approved",
                "records": reviewed_records,
                "pipeline": {"boundary": "manual-review", "status": "approved"},
            }
            atomic_write_json(Path(args.output), reviewed)
            print(json.dumps({
                "reviewedCollectionRef": str(Path(args.output).resolve()),
                "reviewCount": len(reviewed_records),
                "reviewStatus": "approved",
            }, ensure_ascii=False, indent=2))
            return 0
        review = ManualReview(paths_from_args(args))
        if args.command == "bootstrap":
            print(json.dumps(review.bootstrap(), ensure_ascii=False, indent=2))
            return 0
        if args.command == "save":
            print(
                json.dumps(
                    review.save(args.record_id, args.status, args.note),
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
        if args.command == "export":
            print(json.dumps(review.export(), ensure_ascii=False, indent=2))
            return 0
        if args.command == "complete":
            exported = review.export()
            base_path = input_path(
                Path(args.collection_output), "pending collection output"
            )
            base_output = read_json_object(base_path, "pending collection output")
            if (
                base_output.get("status") == "final"
                and isinstance(base_output.get("pipeline"), dict)
                and base_output["pipeline"].get("manual_review") == "completed"
            ):
                print(
                    json.dumps(
                        {
                            **exported,
                            "status": "already_completed",
                            "collection_output": str(base_path),
                            "collection_status": base_output["status"],
                            "record_count": len(base_output.get("records") or []),
                        },
                        ensure_ascii=False,
                        indent=2,
                    )
                )
                return 0
            review_output = read_json_object(review.paths.output, "review output")
            final = review.finalize_collection_output(
                base_output,
                review_output=review_output,
            )
            atomic_write_json(base_path, final)
            print(
                json.dumps(
                    {
                        **exported,
                        "collection_output": str(base_path),
                        "collection_status": final["status"],
                        "record_count": len(final.get("records") or []),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
        raise ManualReviewError(f"unsupported command: {args.command}")
    except (ManualReviewError, OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
