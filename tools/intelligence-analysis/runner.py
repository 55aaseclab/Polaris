#!/usr/bin/env python3
"""clue-intelligence-analysis: product shell over intelligence analysis.

This tool is intentionally thin:
  - validates generic intelligence-analysis v2 input/output contracts
  - freezes a collection snapshot from data-collection output
  - orchestrates kind-specific analysis modules via subprocess only
  - publishes clue.intelligence-analysis.output.v2

Agents and users must call this tool, not executors directly.
literature-review and ad-content-review are internal modules under this
intelligence-analysis package. Agents and workflows use this shell only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

INPUT_SCHEMA = "clue.intelligence-analysis.input.v2"
OUTPUT_SCHEMA = "clue.intelligence-analysis.output.v2"
POLARIS_SAFE_COMMANDS = {"version", "validate-input", "validate-output", "workflow"}


def repo_root() -> Path:
    """tools/intelligence-analysis/runner.py → repository root."""
    return Path(__file__).resolve().parents[2]


def contract_schema_path(name: str) -> Path:
    """Canonical contracts live in repository `schemas/`."""
    return repo_root() / "schemas" / name
KINDS = {
    "literature-review",
    "ad-content-review",
    "business-analysis",
    "product-analysis",
}
# Wired kinds: full executor path today.
WIRED_KINDS = {"literature-review", "ad-content-review"}
# Reserved kinds without a full product path yet.
STUB_KINDS: set[str] = set()
# How literature-review is invoked for analysis_kind=literature-review.
# iterate = seed→absorb claim graph (preferred); batches|propose = legacy paths.
LITERATURE_METHODS = {"iterate", "batches", "propose"}
REVIEW_MODES = {"auto-pass", "auto-approve", "manual-review"}
PROMPT_METHODS = {"generate-text", "generate-file", "derive", "copy-file"}
PROMPT_OUTPUT_KINDS = {"text", "markdown", "json", "string_array"}


class CliError(Exception):
    pass


def assert_polaris_command_is_safe(command: str) -> None:
    """Keep executor work behind Polaris durable jobs in integrated mode."""
    if (
        os.environ.get("POLARIS_LITERATURE_RUNTIME_MODE", "").strip() == "polaris"
        and command not in POLARIS_SAFE_COMMANDS
    ):
        raise CliError(
            "Integrated intelligence-analysis execution requires the Polaris durable job service"
        )


def read(path: str) -> dict[str, Any]:
    try:
        value = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CliError(f"invalid JSON: {path}") from error
    if not isinstance(value, dict):
        raise CliError("document must be a JSON object")
    return value


def string(doc: dict[str, Any], key: str) -> None:
    if not isinstance(doc.get(key), str) or not doc[key].strip():
        raise CliError(f"missing non-empty {key}")


def array(doc: dict[str, Any], key: str) -> None:
    if not isinstance(doc.get(key), list):
        raise CliError(f"missing {key} array")


def validate_prompt_spec(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CliError(f"{label} must be an object")
    allowed = {"method", "instruction", "source_path", "output_kind", "output_path"}
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise CliError(f"{label} has unsupported field(s): {', '.join(unknown)}")
    method = value.get("method")
    if method not in PROMPT_METHODS:
        raise CliError(f"{label}.method must be one of: {', '.join(sorted(PROMPT_METHODS))}")
    normalized: dict[str, Any] = {"method": method}
    for key in ("instruction", "source_path", "output_path"):
        field = value.get(key)
        if field is None:
            continue
        if not isinstance(field, str) or not field.strip():
            raise CliError(f"{label}.{key} must be a non-empty string when set")
        normalized[key] = field.strip()
    output_kind = value.get("output_kind")
    if output_kind is not None:
        if output_kind not in PROMPT_OUTPUT_KINDS:
            raise CliError(
                f"{label}.output_kind must be one of: {', '.join(sorted(PROMPT_OUTPUT_KINDS))}"
            )
        normalized["output_kind"] = output_kind
    return normalized


def copy_prompt_fields(value: dict[str, Any]) -> dict[str, Any]:
    copied: dict[str, Any] = {}
    for key in ("question_prompt", "decision_context_prompt", "audience_prompt"):
        prompt = value.get(key)
        if prompt is None:
            continue
        copied[key] = validate_prompt_spec(prompt, key)
    return copied


def analysis_context_document(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "question": value["question"],
        "decision_context": value["decision_context"],
        "audience": value["audience"],
        **copy_prompt_fields(value),
    }


def normalize_review_policy(value: Any) -> dict[str, Any]:
    """Validate and normalize the public review policy contract."""
    if not isinstance(value, dict):
        raise CliError("missing review_policy object")
    allowed = {
        "minimum_confidence",
        "review_all_claims",
        "mode",
    }
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise CliError(f"review_policy has unsupported field(s): {', '.join(unknown)}")
    confidence = value.get("minimum_confidence", 0.75)
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        raise CliError("review_policy.minimum_confidence must be between 0 and 1")
    review_all = value.get("review_all_claims", False)
    if not isinstance(review_all, bool):
        raise CliError("review_policy.review_all_claims must be a boolean")
    mode = value.get("mode", "auto-pass")
    if mode not in REVIEW_MODES:
        choices = ", ".join(sorted(REVIEW_MODES))
        raise CliError(f"review_policy.mode must be one of: {choices}")
    return {
        "minimum_confidence": float(confidence),
        "review_all_claims": review_all,
        "mode": mode,
    }


def validate_input(doc: dict[str, Any]) -> None:
    if doc.get("schema_version") != INPUT_SCHEMA:
        raise CliError(f"input must use {INPUT_SCHEMA}")
    for key in ("analysis_id", "analysis_kind", "question", "decision_context", "audience"):
        string(doc, key)
    copy_prompt_fields(doc)
    if doc["analysis_kind"] not in KINDS:
        raise CliError(f"unsupported analysis_kind: {doc['analysis_kind']}")
    ref = doc.get("collection_ref")
    if not isinstance(ref, dict):
        raise CliError("missing collection_ref object")
    for key in ("collection_id", "collection_output_sha256"):
        string(ref, key)
    string(ref, "collection_output_path")
    screening = doc.get("screening")
    if screening is not None:
        if (
            not isinstance(screening, dict)
            or not isinstance(screening.get("included_record_ids"), list)
            or not screening["included_record_ids"]
        ):
            raise CliError(
                "screening.included_record_ids must be a non-empty array when screening is supplied"
            )
    normalize_review_policy(doc.get("review_policy"))
    method = doc.get("literature_method")
    if method is not None and method not in LITERATURE_METHODS:
        raise CliError(
            f"literature_method must be one of: {', '.join(sorted(LITERATURE_METHODS))}"
        )


def validate_output(doc: dict[str, Any]) -> None:
    if doc.get("schema_version") != OUTPUT_SCHEMA:
        raise CliError(f"output must use {OUTPUT_SCHEMA}")
    for key in ("analysis_id", "analysis_kind", "status"):
        string(doc, key)
    array(doc, "judgments")
    array(doc, "unresolved")
    array(doc, "run_artifacts")
    review = doc.get("review")
    if review is not None:
        if not isinstance(review, dict):
            raise CliError("review must be an object when provided")
        if review.get("approval_mode") not in {"manual", "auto_pass", "auto_approve"}:
            raise CliError("review.approval_mode must be manual, auto_pass, or auto_approve")
    context = doc.get("analysis_context")
    if context is not None:
        if not isinstance(context, dict):
            raise CliError("analysis_context must be an object when provided")
        for key in ("question", "decision_context", "audience"):
            string(context, key)
        copy_prompt_fields(context)


def final_output_document(
    analysis: dict[str, Any],
    literature_output: dict[str, Any],
    run_artifacts: list[dict[str, str]],
    literature_method: str | None = None,
) -> dict[str, Any]:
    """Map a completed literature-review output into the public IA contract."""
    if literature_output.get("status") != "final":
        raise CliError("literature output must be final")
    source_review = literature_output.get("review")
    if not isinstance(source_review, dict):
        raise CliError("literature output must include review provenance")
    task = analysis.get("task")
    if not isinstance(task, dict):
        raise CliError("analysis input must contain a task object")
    output = {
        "schema_version": OUTPUT_SCHEMA,
        "analysis_id": task["case_id"],
        "analysis_kind": "literature-review",
        "status": "final",
        "analysis_context": analysis_context_document(task),
        "collection_snapshot": literature_output["collection_snapshot"],
        "search_scope": literature_output.get("search_scope", {}),
        "judgments": literature_output["judgments"],
        "rejected_claims": literature_output.get("rejected_claims", []),
        "unresolved": literature_output["unresolved"],
        "review": source_review,
        "run_artifacts": run_artifacts,
    }
    if literature_method:
        output["literature_method"] = literature_method
    validate_output(output)
    return output


def digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def write(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def bibliography(record: dict[str, Any]) -> dict[str, Any]:
    payload = record.get("payload", {})
    if not isinstance(payload, dict):
        return {}
    return {
        key: payload[key]
        for key in (
            "title",
            "author",
            "authors",
            "container-title",
            "conference",
            "DOI",
            "doi",
            "issued",
            "published-print",
            "published-online",
            "year",
            "URL",
        )
        if key in payload
    }


def collection_records(source: dict[str, Any]) -> dict[str, dict[str, Any]]:
    records: dict[str, dict[str, Any]] = {}
    for index, record in enumerate(source.get("records", []), 1):
        if not isinstance(record, dict):
            raise CliError(f"collection record {index} must be an object")
        record_id = record.get("record_id")
        if not isinstance(record_id, str) or not record_id.strip():
            raise CliError(f"collection record {index} is missing record_id")
        payload = record.get("payload")
        if not isinstance(payload, dict):
            raise CliError(f"collection record {record_id} is missing payload")
        records[record_id] = record
    return records


def collection_reproduction(
    collection: Path, source: dict[str, Any], selected_count: int
) -> dict[str, Any]:
    input_path = collection.parents[1] / "inputs" / "input.json"
    if not input_path.is_file():
        return {
            "record_count": selected_count,
            "collection_output_sha256": digest(collection),
        }
    input_doc = read(str(input_path))
    return {
        "collection_id": input_doc.get("collection_id"),
        "record_count": selected_count,
        "collection_input_sha256": digest(input_path),
        "collection_output_sha256": digest(collection),
        "scope": input_doc.get("scope", {}),
        "evidence_policy": input_doc.get("evidence_policy", {}),
        "source_tasks": input_doc.get("source_tasks", []),
        "information_gaps": source.get("information_gaps", []),
        "rerun_command": (
            "clue-data-collection run --input input.json "
            "--workspace <workspace-id> --run-prefix <run-prefix>"
        ),
    }


def literature_review_bin() -> Path:
    path = Path(__file__).resolve().parent / "literature-review" / "literature-review"
    if not path.is_file():
        raise CliError(f"literature-review executor missing: {path}")
    return path


def run_lr(args: list[str]) -> None:
    """Invoke literature-review only through this shell."""
    completed = subprocess.run(
        [str(literature_review_bin()), *args],
        check=False,
        text=True,
        capture_output=True,
    )
    if completed.returncode != 0:
        err = (completed.stderr or completed.stdout or "").strip()
        raise CliError(
            f"literature-review {' '.join(args[:2])} failed ({completed.returncode}): {err[:1200]}"
        )


def literature_method(doc: dict[str, Any]) -> str:
    raw = doc.get("literature_method")
    if raw is None:
        # Preferred product path: iterative claim-graph absorption.
        return "iterate"
    return str(raw)


def ad_content_review_bin() -> Path:
    path = Path(__file__).resolve().parent / "ad-content-review" / "ad-content-review"
    if not path.is_file():
        raise CliError(f"ad-content-review executor missing: {path}")
    return path


def run_ad_content_synthesize(
    prepared: Path,
    snapshot: Path,
    output: Path,
    *,
    doc: dict[str, Any] | None = None,
    work_dir: Path | None = None,
) -> dict[str, Any]:
    cmd = [
        str(ad_content_review_bin()),
        "synthesize",
        "--input",
        str(prepared),
        "--snapshot",
        str(snapshot),
        "--output",
        str(output),
    ]
    model = None
    if isinstance(doc, dict):
        raw = doc.get("model") or doc.get("ad_content_model")
        if isinstance(raw, str) and raw.strip():
            model = raw.strip()
    if model:
        cmd.extend(["--model", model])
    if work_dir is not None:
        work_dir.mkdir(parents=True, exist_ok=True)
        cmd.extend(["--work-dir", str(work_dir)])
    completed = subprocess.run(cmd, check=False, text=True, capture_output=True)
    if completed.returncode != 0 or not output.is_file():
        err = (completed.stderr or completed.stdout or "").strip()[:1200]
        raise CliError(f"ad-content-review synthesize failed: {err}")
    return read(str(output))


def final_ad_content_output(
    doc: dict[str, Any],
    synth: dict[str, Any],
    *,
    run_artifacts: list[dict[str, str]],
    policy: dict[str, Any],
) -> dict[str, Any]:
    """Map synthesize result into clue.intelligence-analysis.output.v2."""
    mode = policy.get("mode", "auto-pass")
    if mode == "auto-pass":
        approval_mode = "auto_pass"
    elif mode == "auto-approve":
        approval_mode = "auto_approve"
    else:
        approval_mode = "manual"
    review = synth.get("review") if isinstance(synth.get("review"), dict) else {}
    review = {
        **review,
        "status": "completed",
        "approval_mode": approval_mode,
        "review_set_id": review.get("review_set_id")
        or f"{doc['analysis_id']}-ad-content",
        "review_result_sha256": review.get("review_result_sha256")
        or "sha256:ad-content-review",
        "summary": review.get("summary")
        if isinstance(review.get("summary"), dict)
        else {"executor": "ad-content-review"},
    }
    snap = synth.get("collection_snapshot") if isinstance(synth.get("collection_snapshot"), dict) else {}
    output = {
        "schema_version": OUTPUT_SCHEMA,
        "analysis_id": doc["analysis_id"],
        "analysis_kind": "ad-content-review",
        "status": "final",
        "analysis_context": analysis_context_document(doc),
        "collection_snapshot": {
            "snapshot_id": str(snap.get("snapshot_id") or f"{doc['analysis_id']}-snapshot"),
            "sha256": str(snap.get("sha256") or "sha256:unknown"),
        },
        "search_scope": synth.get("search_scope")
        if isinstance(synth.get("search_scope"), dict)
        else {},
        "judgments": list(synth.get("judgments") or []),
        "rejected_claims": list(synth.get("rejected_claims") or []),
        "unresolved": list(synth.get("unresolved") or []),
        "review": review,
        "run_artifacts": run_artifacts,
    }
    validate_output(output)
    return output


def freeze_collection_clues(
    doc: dict[str, Any], root: Path
) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]], Path]:
    """Shared prepare: verify collection_ref, build snapshot clues, layout dirs.

    Returns (source_collection, policy, clues, collection_path).
    """
    policy = normalize_review_policy(doc["review_policy"])
    for directory in ("case", "inputs", "work", "runs", "outputs"):
        (root / directory).mkdir(parents=True, exist_ok=True)

    ref = doc["collection_ref"]
    collection = Path(ref["collection_output_path"]).expanduser().resolve()
    if digest(collection) != ref["collection_output_sha256"]:
        raise CliError("collection output hash does not match collection_ref")

    published = root / "outputs" / "output.json"
    if published.exists():
        write(
            published,
            {
                "schema_version": OUTPUT_SCHEMA,
                "analysis_id": doc["analysis_id"],
                "analysis_kind": doc["analysis_kind"],
                "status": "stale",
                "judgments": [],
                "unresolved": [
                    "A new analysis run invalidated the previously published output."
                ],
                "run_artifacts": [],
            },
        )

    source = read(str(collection))
    records = collection_records(source)
    screening = doc.get("screening")
    wanted = set(screening["included_record_ids"]) if screening else set(records)
    if not wanted.issubset(records):
        raise CliError("screening references records absent from collection output")

    clues: list[dict[str, Any]] = []
    for record_id in sorted(wanted):
        record = records[record_id]
        evidence = record.get("evidence", [])
        usable = [
            item
            for item in evidence
            if isinstance(item, dict)
            and isinstance(item.get("quote"), str)
            and item["quote"].strip()
        ]
        if not usable:
            raise CliError(f"record has no quoted evidence: {record_id}")
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        pdf_links = payload.get("pdf_links") if isinstance(payload.get("pdf_links"), dict) else None
        meta = bibliography(record)
        for key in (
            "DOI",
            "doi",
            "title",
            "display_name",
            "platform",
            "note_id",
            "note_type",
            "author_handle",
            "author_id",
            "engagement",
            "text",
            "is_ad_like",
        ):
            if key in payload and key not in meta:
                meta[key] = payload[key]
        meta["record_kind"] = record.get("record_kind")
        clue: dict[str, Any] = {
            "clue_id": record_id,
            "source_url": record["source_url"],
            "observed_at": record["observed_at"],
            "content_hash": record["content_hash"],
            "source_metadata": meta,
            "observations": [
                {
                    "observation_id": f"{record_id}:evidence-{index}",
                    "quote": item["quote"],
                    "locator": item.get("locator", ""),
                }
                for index, item in enumerate(usable, 1)
            ],
        }
        if pdf_links is not None:
            clue["pdf_links"] = pdf_links
        clues.append(clue)
    return source, policy, clues, collection


def run_ad_content_review(doc: dict[str, Any], root: Path, propose: bool) -> dict[str, Any]:
    """Freeze ad-content clues and run synthesize-v0 judgments."""
    source, policy, clues, collection = freeze_collection_clues(doc, root)
    work = root / "work"
    snapshot = {
        "schema_version": "clue.intelligence.collection-snapshot.v2",
        "snapshot_id": f"{doc['analysis_id']}-snapshot",
        "created_at": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "collection_reproduction": collection_reproduction(collection, source, len(clues)),
        "clues": clues,
        "analysis_kind": "ad-content-review",
    }
    task: dict[str, Any] = {
        "schema_version": "clue.intelligence.analysis-task.v2",
        "case_id": doc["analysis_id"],
        "analysis_kind": "ad-content-review",
        "question": doc["question"],
        "decision_context": doc["decision_context"],
        "audience": doc["audience"],
        "collection_snapshot_id": snapshot["snapshot_id"],
        "coverage_mode": "selected_evidence",
        "review_policy": policy,
    }
    task.update(copy_prompt_fields(doc))
    write(work / "collection-snapshot.json", snapshot)
    write(work / "task.json", task)
    prepared = {
        "schema_version": "clue.intelligence.ad-content-analysis-input.v1",
        "analysis_kind": "ad-content-review",
        "task": task,
        "collection_snapshot": snapshot,
        "executor_status": "llm",
    }
    prepared_path = work / "analysis-input.json"
    snapshot_path = work / "collection-snapshot.json"
    write(prepared_path, prepared)
    result: dict[str, Any] = {
        "status": "prepared",
        "snapshot": str(snapshot_path),
        "task": str(work / "task.json"),
        "analysis_input": str(prepared_path),
        "clue_count": len(clues),
        "executor": "ad-content-review",
        "executor_status": "llm",
    }
    if not propose:
        return result

    synth_path = work / "ad-content-synthesize.json"
    synth = run_ad_content_synthesize(
        prepared_path,
        snapshot_path,
        synth_path,
        doc=doc,
        work_dir=work / "ad-content-codex",
    )
    artifacts = [
        {"path": str(snapshot_path)},
        {"path": str(work / "task.json")},
        {"path": str(prepared_path)},
        {"path": str(synth_path)},
    ]

    if policy["mode"] == "manual-review":
        pending = {
            "schema_version": OUTPUT_SCHEMA,
            "analysis_id": doc["analysis_id"],
            "analysis_kind": "ad-content-review",
            "status": "pending_manual_review",
            "judgments": list(synth.get("judgments") or []),
            "unresolved": list(synth.get("unresolved") or []),
            "run_artifacts": artifacts,
        }
        write(root / "outputs" / "output.json", pending)
        result.update(
            {
                "status": "pending_manual_review",
                "output": str(root / "outputs" / "output.json"),
                "judgment_count": len(pending["judgments"]),
            }
        )
        return result

    output = final_ad_content_output(
        doc, synth, run_artifacts=artifacts, policy=policy
    )
    out_path = root / "outputs" / "output.json"
    write(out_path, output)
    # Optional offline markdown (no Codex) for quick inspection.
    md_path = root / "outputs" / "report.md"
    subprocess.run(
        [
            str(ad_content_review_bin()),
            "render-markdown",
            "--input",
            str(out_path),
            "--output",
            str(md_path),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if md_path.is_file():
        artifacts = [*artifacts, {"path": str(md_path)}]
        output["run_artifacts"] = artifacts
        write(out_path, output)
    result.update(
        {
            "status": "final",
            "output": str(out_path),
            "report_markdown": str(md_path) if md_path.is_file() else None,
            "judgment_count": len(output.get("judgments") or []),
            "review_mode": output["review"]["approval_mode"],
            "executor_status": "llm",
        }
    )
    return result


def run(doc: dict[str, Any], root: Path, propose: bool) -> dict[str, Any]:
    kind = doc["analysis_kind"]
    if kind == "ad-content-review":
        return run_ad_content_review(doc, root, propose)
    if kind != "literature-review":
        raise CliError(
            f"analysis_kind {kind!r} is reserved; "
            "wired today: literature-review; stub: ad-content-review; "
            "not wired: business-analysis, product-analysis"
        )
    source, policy, clues, collection = freeze_collection_clues(doc, root)

    work = root / "work"
    snapshot = {
        "schema_version": "clue.intelligence.collection-snapshot.v2",
        "snapshot_id": f"{doc['analysis_id']}-snapshot",
        "created_at": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "collection_reproduction": collection_reproduction(collection, source, len(clues)),
        "clues": clues,
    }
    task: dict[str, Any] = {
        "schema_version": "clue.intelligence.analysis-task.v2",
        "case_id": doc["analysis_id"],
        "question": doc["question"],
        "decision_context": doc["decision_context"],
        "audience": doc["audience"],
        "collection_snapshot_id": snapshot["snapshot_id"],
        "coverage_mode": "selected_evidence",
        "review_policy": policy,
    }
    task.update(copy_prompt_fields(doc))
    if "minimum_distinct_sources" in doc and doc["minimum_distinct_sources"] is not None:
        try:
            task["minimum_distinct_sources"] = max(1, int(doc["minimum_distinct_sources"]))
        except (TypeError, ValueError) as error:
            raise CliError("minimum_distinct_sources must be a positive integer when set") from error

    write(work / "collection-snapshot.json", snapshot)
    write(work / "task.json", task)
    prepared = work / "analysis-input.json"
    run_lr(
        [
            "prepare",
            "--task",
            str(work / "task.json"),
            "--snapshot",
            str(work / "collection-snapshot.json"),
            "--output",
            str(prepared),
        ]
    )
    method = literature_method(doc)
    result: dict[str, Any] = {
        "status": "prepared",
        "snapshot": str(work / "collection-snapshot.json"),
        "task": str(work / "task.json"),
        "analysis_input": str(prepared),
        "clue_count": len(clues),
        "literature_method": method,
        "executor": "literature-review",
    }
    if not propose:
        return result

    candidates = work / "candidates.json"
    validated = work / "validated.json"
    reviews = root / "outputs" / "manual-review-list.json"
    try:
        if method == "iterate":
            iteration_out = work / "iteration-corpus.json"
            iterate_work = work / "iterate-runs"
            seed_ids = doc.get("seed_paper_ids") or doc.get("seed_record_ids")
            iterate_args = [
                "iterate",
                "--input",
                str(prepared),
                "--output",
                str(iteration_out),
                "--work-dir",
                str(iterate_work),
                "--export-candidates",
                str(candidates),
                "--model",
                str(doc.get("model") or "gpt-5.5"),
                "--reasoning-effort",
                str(doc.get("model_reasoning_effort") or doc.get("reasoning_effort") or "low"),
            ]
            if isinstance(seed_ids, list) and seed_ids:
                iterate_args.extend(
                    ["--seed-ids", ",".join(str(x) for x in seed_ids if str(x).strip())]
                )
            if doc.get("max_papers") is not None:
                iterate_args.extend(["--max-papers", str(int(doc["max_papers"]))])
            run_lr(iterate_args)
            result["iteration_corpus"] = str(iteration_out)
        elif method == "batches" or (method == "propose" and len(clues) > 1):
            # legacy batch path only when explicitly requested as batches,
            # or single propose for one-clue corpora under propose.
            if method == "batches":
                run_lr(
                    [
                        "propose-batches",
                        "--input",
                        str(prepared),
                        "--output",
                        str(candidates),
                        "--cache-dir",
                        str(work / "batch-cache"),
                        "--batch-size",
                        str(int(doc.get("batch_size") or 10)),
                    ]
                )
            else:
                run_lr(
                    [
                        "propose",
                        "--input",
                        str(prepared),
                        "--output",
                        str(candidates),
                        "--run-dir",
                        str(root / "runs" / "propose"),
                    ]
                )
        else:
            run_lr(
                [
                    "propose",
                    "--input",
                    str(prepared),
                    "--output",
                    str(candidates),
                    "--run-dir",
                    str(root / "runs" / "propose"),
                ]
            )
    except CliError as error:
        failed = {
            "schema_version": OUTPUT_SCHEMA,
            "analysis_id": doc["analysis_id"],
            "analysis_kind": doc["analysis_kind"],
            "status": "failed",
            "judgments": [],
            "unresolved": [str(error)],
            "run_artifacts": [{"path": str(prepared)}],
        }
        write(root / "outputs" / "output.json", failed)
        return {
            "status": "failed",
            "output": str(root / "outputs" / "output.json"),
            "error": str(error),
        }

    run_lr(
        [
            "validate",
            "--input",
            str(prepared),
            "--candidates",
            str(candidates),
            "--output",
            str(validated),
        ]
    )
    review_mode = policy["mode"]

    # Auto-pass bypasses the review queue. Auto-approve retains an auditable
    # review list while approving its required claims without human action.
    if review_mode != "auto-pass":
        run_lr(
            [
                "review-list",
                "--input",
                str(prepared),
                "--validated",
                str(validated),
                "--output",
                str(reviews),
            ]
        )

    if review_mode != "manual-review":
        automatic = work / "automatic-review-result.json"
        literature_output = work / "literature-output.json"
        literature_report = work / "literature-report.md"
        approve_cmd = "auto-pass" if review_mode == "auto-pass" else "auto-approve"
        run_lr(
            [
                approve_cmd,
                "--input",
                str(prepared),
                "--validated",
                str(validated),
                "--output",
                str(automatic),
            ]
        )
        run_lr(
            [
                "finalize",
                "--input",
                str(prepared),
                "--validated",
                str(validated),
                "--review-result",
                str(automatic),
                "--output",
                str(literature_output),
                "--report",
                str(literature_report),
            ]
        )
        generic_output = root / "outputs" / "output.json"
        source_out = read(str(literature_output))
        analysis = read(str(prepared))
        artifacts = [
            {"path": str(prepared)},
            {"path": str(candidates)},
            {"path": str(validated)},
            {"path": str(automatic)},
            {"path": str(literature_output)},
            {"path": str(literature_report)},
        ]
        if review_mode == "auto-approve":
            artifacts.append({"path": str(reviews)})
        if result.get("iteration_corpus"):
            artifacts.append({"path": result["iteration_corpus"]})
        output = final_output_document(analysis, source_out, artifacts, method)
        write(generic_output, output)
        result.update(
            {
                "status": "final",
                "output": str(generic_output),
                "review_mode": output["review"]["approval_mode"],
                "candidates": str(candidates),
            }
        )
        return result

    validated_doc = read(str(validated))
    pending = {
        "schema_version": OUTPUT_SCHEMA,
        "analysis_id": doc["analysis_id"],
        "analysis_kind": doc["analysis_kind"],
        "status": "pending_manual_review",
        "judgments": validated_doc.get("claims", []),
        "unresolved": validated_doc.get("unresolved", []),
        "run_artifacts": [
            {"path": str(prepared)},
            {"path": str(candidates)},
            {"path": str(validated)},
            {"path": str(reviews)},
        ],
        "literature_method": method,
    }
    write(root / "outputs" / "output.json", pending)
    result.update(
        {
            "status": "pending_manual_review",
            "candidates": str(candidates),
            "output": str(root / "outputs" / "output.json"),
        }
    )
    return result


def complete_manual_review(root: Path, review_result: Path | None = None) -> dict[str, Any]:
    """Finalize a manual-review run after the portal exports decisions."""
    root = root.expanduser().resolve()
    prepared = root / "work" / "analysis-input.json"
    validated = root / "work" / "validated.json"
    review_result = review_result or root / "work" / "manual-review" / "review-result.json"
    literature_output = root / "work" / "literature-output.json"
    literature_report = root / "work" / "literature-report.md"
    review_list = root / "outputs" / "manual-review-list.json"

    for file_path, label in (
        (prepared, "analysis input"),
        (validated, "validated analysis"),
        (review_result, "review result"),
        (review_list, "manual-review list"),
    ):
        if not file_path.is_file():
            raise CliError(f"{label} is missing: {file_path}")

    run_lr(
        [
            "finalize",
            "--input",
            str(prepared),
            "--validated",
            str(validated),
            "--review-result",
            str(review_result),
            "--output",
            str(literature_output),
            "--report",
            str(literature_report),
        ]
    )
    pending_output = read(root / "outputs" / "output.json")
    method = pending_output.get("literature_method")
    if not isinstance(method, str):
        method = None
    output = final_output_document(
        read(str(prepared)),
        read(str(literature_output)),
        [
            {"path": str(prepared)},
            {"path": str(validated)},
            {"path": str(review_list)},
            {"path": str(review_result)},
            {"path": str(literature_output)},
            {"path": str(literature_report)},
        ],
        method,
    )
    output_path = root / "outputs" / "output.json"
    write(output_path, output)
    return {
        "status": "succeeded",
        "output": str(output_path),
        "judgment_count": len(output["judgments"]),
        "review_mode": output["review"]["approval_mode"],
    }


def workflow_request(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any], Path]:
    request = read(args.input)
    values = request.get("input")
    if not isinstance(values, dict):
        raise CliError("workflow input requires an input object")
    workspace_root = request.get("workspaceRoot")
    if not isinstance(workspace_root, str) or not workspace_root.strip():
        raise CliError("workflow input requires workspaceRoot")
    return request, values, Path(workspace_root).expanduser().resolve()


def workflow_string(values: dict[str, Any], key: str, command: str) -> str:
    value = values.get(key)
    if not isinstance(value, str) or not value.strip():
        raise CliError(f"workflow {command} requires input.{key}")
    return value.strip()


def workflow_document(
    request: dict[str, Any],
    values: dict[str, Any],
    collection_output: Path,
) -> dict[str, Any]:
    run_id = workflow_string(request, "runId", "adapter")
    collection = read(str(collection_output))
    collection_id = collection.get("collection_id")
    if not isinstance(collection_id, str) or not collection_id.strip():
        raise CliError("collection output has no collection_id")
    return {
        "schema_version": INPUT_SCHEMA,
        "analysis_id": f"analysis-{run_id}",
        "analysis_kind": "literature-review",
        "question": workflow_string(values, "question", "prepare"),
        "decision_context": workflow_string(values, "decisionContext", "prepare"),
        "audience": workflow_string(values, "audience", "prepare"),
        "collection_ref": {
            "collection_id": collection_id,
            "collection_output_sha256": digest(collection_output),
            "collection_output_path": str(collection_output),
        },
        "review_policy": {"mode": "auto-pass"},
    }


def command_workflow(args: argparse.Namespace) -> int:
    request, values, workspace_root = workflow_request(args)
    output = Path(args.output).expanduser().resolve()
    analysis_root = workspace_root / "analysis"
    metadata_path = analysis_root / "inputs" / "workflow-request.json"

    if args.step_command == "prepare":
        collection_output = Path(
            workflow_string(values, "collectionOutputRef", args.step_command)
        ).expanduser().resolve()
        document = workflow_document(request, values, collection_output)
        validate_input(document)
        result = run(document, analysis_root, False)
        write(metadata_path, document)
        write(
            output,
            {
                "snapshotRef": result["snapshot"],
                "analysisInputRef": result["analysis_input"],
                "clueCount": result["clue_count"],
            },
        )
        return 0

    if args.step_command == "run":
        analysis_input = Path(
            workflow_string(values, "analysisInputRef", args.step_command)
        ).expanduser().resolve()
        if not analysis_input.is_file():
            raise CliError(f"analysis input does not exist: {analysis_input}")
        document = read(str(metadata_path))
        validate_input(document)
        result = run(document, analysis_root, True)
        result_status = result.get("status")
        if result_status != "final":
            raise CliError(f"analysis did not finish successfully: {result_status}")
        analysis_output = Path(str(result["output"])).expanduser().resolve()
        published = read(str(analysis_output))
        validate_output(published)
        write(
            output,
            {
                "analysisOutputRef": str(analysis_output),
                "claimCount": len(published["judgments"]),
                "analysisStatus": str(published["status"]),
            },
        )
        return 0

    if args.step_command == "validate-output":
        analysis_output = Path(
            workflow_string(values, "analysisOutputRef", args.step_command)
        ).expanduser().resolve()
        validate_output(read(str(analysis_output)))
        write(output, {"analysisValid": True})
        return 0

    raise CliError(f"unsupported workflow command: {args.step_command}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="clue-intelligence-analysis",
        description=(
            "Product shell for intelligence analysis. Orchestrates frozen collection "
            "evidence into kind-specific executors (literature-review wired; "
            "ad-content-review empty stub). Do not call executors directly from "
            "agents or workflows."
        ),
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("version")
    vin = sub.add_parser("validate-input")
    vin.add_argument("--input", required=True)
    vout = sub.add_parser("validate-output")
    vout.add_argument("--output", required=True)
    fin = sub.add_parser("finalize")
    fin.add_argument("--analysis-input", required=True)
    fin.add_argument("--literature-output", required=True)
    fin.add_argument("--output", required=True)
    complete = sub.add_parser(
        "complete-review",
        help="Finalize a manual-review result into the intelligence-analysis output.",
    )
    complete.add_argument("--analysis-root", required=True)
    complete.add_argument("--review-result")
    run_p = sub.add_parser(
        "run",
        help="Prepare snapshot + run literature-review executor end-to-end.",
    )
    run_p.add_argument("--input", required=True)
    run_p.add_argument("--analysis-root", required=True)
    prep = sub.add_parser("prepare", help="Freeze snapshot/task/analysis-input only.")
    prep.add_argument("--input", required=True)
    prep.add_argument("--analysis-root", required=True)
    workflow = sub.add_parser("workflow", help="Polaris workflow adapter.")
    workflow.add_argument("step_command")
    workflow.add_argument("--input", required=True)
    workflow.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        assert_polaris_command_is_safe(args.cmd)
        if args.cmd == "version":
            value = {
                "tool": "clue-intelligence-analysis",
                "version": (Path(__file__).parent / "VERSION").read_text().strip(),
                "input_schema": INPUT_SCHEMA,
                "output_schema": OUTPUT_SCHEMA,
                "role": "shell",
                "analysis_kinds": sorted(KINDS),
                "wired_kinds": sorted(WIRED_KINDS),
                "stub_kinds": sorted(STUB_KINDS),
                "executor": {
                    "literature-review": "tools/intelligence-analysis/literature-review",
                    "ad-content-review": "tools/intelligence-analysis/ad-content-review (LLM synthesize)",
                },
                "literature_methods": sorted(LITERATURE_METHODS),
                "default_literature_method": "iterate",
            }
        elif args.cmd == "validate-input":
            validate_input(read(args.input))
            value = {"status": "valid", "contract": "v2"}
        elif args.cmd == "validate-output":
            validate_output(read(args.output))
            value = {"status": "valid", "contract": "v2"}
        elif args.cmd == "finalize":
            source = read(args.literature_output)
            analysis = read(args.analysis_input)
            output = final_output_document(
                analysis,
                source,
                [{"path": str(Path(args.literature_output).resolve())}],
            )
            write(Path(args.output), output)
            value = {
                "status": "succeeded",
                "output": str(Path(args.output).resolve()),
                "judgment_count": len(output["judgments"]),
            }
        elif args.cmd == "complete-review":
            value = complete_manual_review(
                Path(args.analysis_root),
                Path(args.review_result) if args.review_result else None,
            )
        elif args.cmd == "prepare":
            doc = read(args.input)
            validate_input(doc)
            value = run(doc, Path(args.analysis_root).expanduser().resolve(), False)
        elif args.cmd == "workflow":
            return command_workflow(args)
        else:
            doc = read(args.input)
            validate_input(doc)
            value = run(doc, Path(args.analysis_root).expanduser().resolve(), True)
        print(json.dumps(value, ensure_ascii=False, indent=2))
        return 0
    except CliError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
