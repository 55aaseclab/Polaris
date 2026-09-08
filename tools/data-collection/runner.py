#!/usr/bin/env python3
"""Validate versioned generic data-collection contracts."""

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
from urllib.parse import urlparse

TOOL_NAME = "clue-data-collection"
INPUT_V2 = "clue.data-collection.input.v2"
OUTPUT_V2 = "clue.data-collection.output.v2"
KINDS = {"customer-leads", "literature", "ad-content-intel"}
SOURCE_CATALOG_SCHEMA = "clue.data-collection.source-catalog.v1"
# Intermediate / phase artifacts (unified under clue.data-collection.*; not main IO).
REVIEW_LIST_SCHEMA = "clue.data-collection.review-list.v1"
NON_REVIEW_SCHEMA = "clue.data-collection.non-review.v1"
CUSTOMER_LEADS_RESULT_SCHEMA = "clue.data-collection.customer-leads-result.v1"
PROMPT_METHODS = {"generate-text", "generate-file", "derive", "copy-file"}
PROMPT_OUTPUT_KINDS = {"text", "markdown", "json", "string_array"}


def repo_root() -> Path:
    """tools/data-collection/runner.py → repository root."""
    return Path(__file__).resolve().parents[2]


def contract_schema_path(name: str) -> Path:
    """Canonical contracts live in repository `schemas/`."""
    return repo_root() / "schemas" / name

# Fixed three-phase run order (do not reorder).
PHASE_COLLECTION = 1
PHASE_AUGMENTATION = 2
PHASE_MANUAL_REVIEW = 3
PIPELINE_PHASES = (
    (PHASE_COLLECTION, "collection"),
    (PHASE_AUGMENTATION, "augmentation"),
    (PHASE_MANUAL_REVIEW, "manual-review"),
)


# Literature package re-exports (phase 1 helpers used by tests + phase_collection).
from literature.phase1 import (  # noqa: E402
    apply_seed_literature_scope,
    collect_paper_links,
    normalize_crossref,
    normalize_deepsec,
    normalize_semantic_scholar,
    record_candidate_links,
)
from literature.support import LiteratureError  # noqa: E402

# Ad-content-intel package re-exports.
from ad_content.phase1 import (  # noqa: E402
    AD_CONTENT_SOURCE_TYPES,
    normalize_social_media,
    normalize_web_search,
    run_social_media_task,
    run_web_search_task,
)
from ad_content.support import AdContentError  # noqa: E402



class CliError(Exception):
    pass


def read_json(path: str, label: str) -> dict[str, Any]:
    target = Path(path).expanduser().resolve()
    if not target.is_file():
        raise CliError(f"{label} does not exist: {target}")
    try:
        value = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CliError(f"{label} is not valid JSON: {target}") from error
    if not isinstance(value, dict):
        raise CliError(f"{label} must be a JSON object")
    return value


def required_string(value: dict[str, Any], key: str, label: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result.strip():
        raise CliError(f"{label} requires non-empty {key}")
    return result


def required_list(value: dict[str, Any], key: str, label: str) -> list[Any]:
    result = value.get(key)
    if not isinstance(result, list):
        raise CliError(f"{label} requires {key} array")
    return result


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
    for key in ("instruction", "source_path", "output_path"):
        field = value.get(key)
        if field is not None and (not isinstance(field, str) or not field.strip()):
            raise CliError(f"{label}.{key} must be a non-empty string when set")
    output_kind = value.get("output_kind")
    if output_kind is not None and output_kind not in PROMPT_OUTPUT_KINDS:
        raise CliError(
            f"{label}.output_kind must be one of: {', '.join(sorted(PROMPT_OUTPUT_KINDS))}"
        )
    return dict(value)


def source_catalog_path() -> Path:
    return Path(__file__).with_name("source-catalog.json")


def load_source_catalog() -> dict[str, Any]:
    catalog = read_json(str(source_catalog_path()), "source catalog")
    if catalog.get("schema_version") != SOURCE_CATALOG_SCHEMA:
        raise CliError(f"source catalog must use {SOURCE_CATALOG_SCHEMA}")
    topics = required_list(catalog, "topics", "source catalog")
    sources = required_list(catalog, "sources", "source catalog")
    topic_ids = {required_string(item, "topic_id", "source catalog topic") for item in topics if isinstance(item, dict)}
    if len(topic_ids) != len(topics):
        raise CliError("source catalog topics must be objects with unique topic_id values")
    source_ids: set[str] = set()
    for source in sources:
        if not isinstance(source, dict):
            raise CliError("source catalog sources must be objects")
        source_id = required_string(source, "source_id", "source catalog source")
        if source_id in source_ids:
            raise CliError(f"source catalog has duplicate source_id: {source_id}")
        source_ids.add(source_id)
        source_topics = required_list(source, "topic_ids", "source catalog source")
        if not source_topics or not all(isinstance(item, str) and item in topic_ids for item in source_topics):
            raise CliError(f"source catalog source {source_id} has an unknown topic")
        domains = required_list(source, "search_domains", "source catalog source")
        if not domains or not all(isinstance(item, str) and item.strip() for item in domains):
            raise CliError(f"source catalog source {source_id} needs search_domains")
    return catalog


def selected_catalog_sources(config: dict[str, Any]) -> list[dict[str, Any]]:
    topic = required_string(config, "topic", "curated-web-search config")
    catalog = load_source_catalog()
    topics = {item["topic_id"] for item in catalog["topics"]}
    if topic not in topics:
        raise CliError(f"unknown source catalog topic: {topic}")
    requested = config.get("source_ids")
    if requested is not None and (
        not isinstance(requested, list)
        or not requested
        or not all(isinstance(item, str) and item.strip() for item in requested)
    ):
        raise CliError("curated-web-search config source_ids must be a non-empty string array")
    candidates = [item for item in catalog["sources"] if topic in item["topic_ids"]]
    by_id = {item["source_id"]: item for item in candidates}
    if requested is None:
        return candidates
    unknown = sorted(set(requested) - set(by_id))
    if unknown:
        raise CliError(f"source_ids are not available for topic {topic}: {', '.join(unknown)}")
    return [by_id[item] for item in requested]


def catalog_search_tasks(
    parent_task_id: str,
    query: str,
    locale: str,
    sources: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    """Build unique site-restricted search tasks for selected catalog sources."""
    tasks: list[dict[str, Any]] = []
    source_by_task_id: dict[str, dict[str, Any]] = {}
    for source in sources:
        for index, domain in enumerate(source["search_domains"], start=1):
            search_task_id = f"{parent_task_id}--{source['source_id']}--{index}"
            tasks.append(
                {
                    "task_id": search_task_id,
                    "query": f"site:{domain} {query}",
                    "locale": locale,
                    "buyer_type_ids": [],
                }
            )
            source_by_task_id[search_task_id] = source
    return tasks, source_by_task_id


def validate_evidence_policy(policy: Any) -> None:
    if not isinstance(policy, dict):
        raise CliError("input evidence_policy must be an object")
    fields = required_list(policy, "required_fields", "evidence_policy")
    required = {"source_url", "quote", "observed_at", "content_hash"}
    if not required.issubset(set(fields)):
        raise CliError("evidence_policy.required_fields must include source_url, quote, observed_at, content_hash")


def validate_v2_input(value: dict[str, Any]) -> None:
    for key in ("collection_id", "question", "decision_context"):
        required_string(value, key, "v2 input")
    for key in ("question_prompt", "decision_context_prompt"):
        if key in value and value[key] is not None:
            validate_prompt_spec(value[key], f"v2 input {key}")
    if value.get("collection_kind") not in KINDS:
        raise CliError(f"v2 input collection_kind must be one of {sorted(KINDS)}")
    if not isinstance(value.get("scope"), dict):
        raise CliError("v2 input requires scope object")
    scope = value["scope"]
    for key in ("include_prompt", "exclude_prompt", "topic_criteria_prompt"):
        if key in scope and scope[key] is not None:
            validate_prompt_spec(scope[key], f"scope.{key}")
    validate_evidence_policy(value.get("evidence_policy"))
    tasks = required_list(value, "source_tasks", "v2 input")
    if not tasks:
        raise CliError("v2 input source_tasks must not be empty")
    for index, task in enumerate(tasks, 1):
        if not isinstance(task, dict):
            raise CliError(f"source_tasks[{index}] must be an object")
        required_string(task, "task_id", f"source_tasks[{index}]")
        required_string(task, "source_type", f"source_tasks[{index}]")
        if not isinstance(task.get("config"), dict):
            raise CliError(f"source_tasks[{index}] requires config object")
    if not isinstance(value.get("payload"), dict):
        raise CliError("v2 input requires payload object")
    payload = value["payload"]
    literature_scope = payload.get("literature_scope")
    if isinstance(literature_scope, dict):
        for key in ("topic_keywords_prompt", "topic_criteria_prompt"):
            if key in literature_scope and literature_scope[key] is not None:
                validate_prompt_spec(literature_scope[key], f"payload.literature_scope.{key}")
    pdf_links = payload.get("pdf_links")
    if pdf_links is not None:
        if value["collection_kind"] != "literature":
            raise CliError("payload.pdf_links is supported only for literature collections")
        if not isinstance(pdf_links, dict) or pdf_links.get("enabled") is not True:
            raise CliError("payload.pdf_links must be an object with enabled: true")
    ad_scope = payload.get("ad_content_scope")
    if ad_scope is not None:
        if value["collection_kind"] != "ad-content-intel":
            raise CliError(
                "payload.ad_content_scope is supported only for ad-content-intel collections"
            )
        if not isinstance(ad_scope, dict):
            raise CliError("payload.ad_content_scope must be an object")
    pipeline_options(value, None)


def input_version(value: dict[str, Any]) -> str:
    if value.get("schema_version") == INPUT_V2:
        validate_v2_input(value)
        return "v2"
    raise CliError(f"input must use {INPUT_V2}")


def validate_v2_output(value: dict[str, Any]) -> None:
    for key in ("collection_id", "collection_kind", "status"):
        required_string(value, key, "v2 output")
    if value["collection_kind"] not in KINDS:
        raise CliError(f"v2 output collection_kind must be one of {sorted(KINDS)}")
    for key in ("records", "rejected_records", "run_artifacts", "information_gaps"):
        required_list(value, key, "v2 output")
    for index, record in enumerate(value["records"], 1):
        if not isinstance(record, dict):
            raise CliError(f"records[{index}] must be an object")
        for key in ("record_id", "record_kind", "source_url", "observed_at", "content_hash"):
            required_string(record, key, f"records[{index}]")
        evidence = required_list(record, "evidence", f"records[{index}]")
        if not evidence or not all(isinstance(item, dict) and isinstance(item.get("quote"), str) and item["quote"].strip() for item in evidence):
            raise CliError(f"records[{index}] requires evidence with non-empty quote")
        payload = record.get("payload")
        if not isinstance(payload, dict):
            raise CliError(f"records[{index}] requires payload object")
        pdf_links = payload.get("pdf_links")
        if pdf_links is not None:
            if value["collection_kind"] != "literature":
                raise CliError("payload.pdf_links is supported only for literature collections")
            validate_pdf_links(pdf_links, f"records[{index}].payload.pdf_links")


def validate_pdf_links(value: Any, label: str) -> None:
    if not isinstance(value, dict):
        raise CliError(f"{label} must be an object")
    if value.get("status") != "listed":
        raise CliError(f"{label}.status must be listed")
    allowed_overall = {"not_downloaded", "partial", "retrieved", "failed"}
    if value.get("validation") not in allowed_overall:
        raise CliError(
            f"{label}.validation must be one of: {', '.join(sorted(allowed_overall))}"
        )
    candidates = required_list(value, "candidates", label)
    allowed_candidate = {"not_downloaded", "retrieved", "failed"}
    seen: set[str] = set()
    for index, candidate in enumerate(candidates, start=1):
        candidate_label = f"{label}.candidates[{index}]"
        if not isinstance(candidate, dict):
            raise CliError(f"{candidate_label} must be an object")
        url = required_string(candidate, "url", candidate_label)
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise CliError(f"{candidate_label}.url must be an HTTP(S) URL")
        if url in seen:
            raise CliError(f"{label} has duplicate candidate URL: {url}")
        seen.add(url)
        required_string(candidate, "link_kind", candidate_label)
        if candidate.get("validation") not in allowed_candidate:
            raise CliError(
                f"{candidate_label}.validation must be one of: "
                f"{', '.join(sorted(allowed_candidate))}"
            )


def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2), flush=True)


def log(message: str, **fields: Any) -> None:
    """Progress line to stderr (does not pollute final JSON stdout)."""
    payload: dict[str, Any] = {
        "ts": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "level": "info",
        "msg": message,
    }
    payload.update(fields)
    print(json.dumps(payload, ensure_ascii=False), file=sys.stderr, flush=True)


REVIEW_MODES = {"auto-pass", "auto-approve", "manual-review"}


def pipeline_options(
    input_value: dict[str, Any],
    review_mode_override: str | None,
) -> dict[str, Any]:
    """Resolve three-phase pipeline options from input + CLI flags.

    Phase order is fixed:
      1 = collection
      2 = augmentation
      3 = manual-review
    """
    pipeline = input_value.get("pipeline")
    if pipeline is None:
        pipeline = {}
    if not isinstance(pipeline, dict):
        raise CliError("input.pipeline must be an object when provided")
    legacy_fields = {"auto_approve", "auto_pass"} & set(pipeline)
    if legacy_fields:
        raise CliError(
            "pipeline.auto_approve and pipeline.auto_pass were replaced by "
            "pipeline.review_mode "
            "(auto-pass, auto-approve, or manual-review)"
        )
    unknown_fields = sorted(set(pipeline) - {"review_mode", "skip_augmentation"})
    if unknown_fields:
        raise CliError(
            "pipeline has unsupported field(s): "
            f"{', '.join(unknown_fields)}"
        )
    configured_mode = pipeline.get("review_mode", "auto-pass")
    review_mode = review_mode_override or configured_mode
    if not isinstance(review_mode, str) or review_mode not in REVIEW_MODES:
        choices = ", ".join(sorted(REVIEW_MODES))
        raise CliError(f"pipeline.review_mode must be one of: {choices}")
    # skip_augmentation affects phase 2 only (never phase 3).
    skip_augmentation = pipeline.get("skip_augmentation", False)
    if not isinstance(skip_augmentation, bool):
        raise CliError("pipeline.skip_augmentation must be a boolean")
    return {
        "review_mode": review_mode,
        "skip_augmentation": skip_augmentation,
    }


def _phase_record(phase_id: int, name: str, status: str, **extra: Any) -> dict[str, Any]:
    if (phase_id, name) not in PIPELINE_PHASES:
        raise CliError(f"invalid pipeline phase: {phase_id} {name}")
    return {"phase_id": phase_id, "phase": name, "status": status, **extra}


def phase_collection(
    input_value: dict[str, Any],
    workspace: str,
    run_prefix: str,
) -> tuple[dict[str, Any], list[dict[str, str]], Path]:
    """Phase 1 (collection): source tools + builtin normalize → candidate set."""
    log("phase_start", phase_id=PHASE_COLLECTION, phase="collection")
    result, sources = run_phase1_sources(input_value, workspace, run_prefix)
    log(
        "phase1_normalize_start",
        phase_id=PHASE_COLLECTION,
        phase="collection",
        source_artifacts=len(sources),
    )
    normalized_outputs = []
    for source_type, path, source_by_task_id in sources:
        if source_type == "curated-web-search":
            normalized_outputs.append(
                normalize_curated_web_search(input_value, path, source_by_task_id)
            )
        elif source_type == "web-search":
            normalized_outputs.append(normalize_web_search(input_value, path))
        elif source_type == "social_media":
            normalized_outputs.append(normalize_social_media(input_value, path))
        elif source_type == "deepsec-search":
            normalized_outputs.append(normalize_deepsec(input_value, path))
        elif source_type in {"crossref-doi", "crossref-search", "crossref"}:
            normalized_outputs.append(normalize_crossref(input_value, [path]))
        elif source_type in {"semantic-scholar-search", "semantic-scholar"}:
            normalized_outputs.append(normalize_semantic_scholar(input_value, path))
        else:
            normalized_outputs.append(normalize_crossref(input_value, [path]))
    if not normalized_outputs:
        # No successful sources: still emit an empty candidate set.
        normalized = {
            "schema_version": OUTPUT_V2,
            "collection_id": input_value["collection_id"],
            "collection_kind": input_value["collection_kind"],
            "status": "candidate_set",
            "records": [],
            "rejected_records": [],
            "run_artifacts": [],
            "information_gaps": ["No successful source tasks produced records."],
        }
    else:
        normalized = merge_normalized_outputs(normalized_outputs)

    # Seed literature candidates must pass literature_scope (CCF / years / arXiv).
    if input_value.get("collection_kind") == "literature":
        normalized = apply_seed_literature_scope(normalized, input_value)
        # Optional LLM topic-judge (tools/codex) after keyword/year/venue filter.
        try:
            from literature.topic_judge import apply_topic_judge

            root_for_judge = Path(os.environ["POLARIS_LITERATURE_WORKSPACES_ROOT"]).resolve()
            coll_base = (
                root_for_judge
                / workspace
                / "data-collections"
                / input_value["collection_id"]
            )
            normalized = apply_topic_judge(
                normalized,
                input_value,
                work_dir=coll_base / "work" / f"{run_prefix}-topic-judge",
                stage="seed",
                scope_path=coll_base / "inputs" / "input.json",
            )
        except Exception as error:  # noqa: BLE001
            log(
                "phase1_topic_judge_failed",
                phase_id=PHASE_COLLECTION,
                phase="collection",
                error=str(error)[:400],
            )

    if input_value.get("payload", {}).get("pdf_links") is not None:
        # Listing only; PDF retrieval is phase 2 (augmentation) via tools/browser.
        normalized = collect_paper_links(normalized)
        log(
            "phase1_pdf_links_listed",
            phase_id=PHASE_COLLECTION,
            phase="collection",
            records=len(normalized.get("records") or []),
        )

    root = Path(os.environ["POLARIS_LITERATURE_WORKSPACES_ROOT"]).resolve()
    collection_base = root / workspace / "data-collections" / input_value["collection_id"]
    work_dir = collection_base / "work"
    work_dir.mkdir(parents=True, exist_ok=True)
    intermediate = work_dir / "collection-output.json"
    intermediate.write_text(
        json.dumps(normalized, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    log(
        "phase_done",
        phase_id=PHASE_COLLECTION,
        phase="collection",
        status="succeeded",
        record_count=len(normalized.get("records") or []),
        rejected_count=len(normalized.get("rejected_records") or []),
        output=str(intermediate),
    )
    return normalized, result, intermediate


def phase_augmentation(
    input_value: dict[str, Any],
    collection_output: dict[str, Any],
    workspace: str,
    run_prefix: str,
    *,
    skip: bool,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Phase 2 (augmentation): post-collection enrich (not phase 3 manual-review).

    Literature: optional PDF capture via pdf_capture.py → tools/browser,
    then attach review-required flags for phase 3.
    Customer-leads: customer_leads.py (preprocess|augment).
    """
    kind = input_value.get("collection_kind")
    root = Path(os.environ["POLARIS_LITERATURE_WORKSPACES_ROOT"]).resolve()
    collection_base = root / workspace / "data-collections" / input_value["collection_id"]
    work_dir = collection_base / "work"
    work_dir.mkdir(parents=True, exist_ok=True)
    log(
        "phase_start",
        phase_id=PHASE_AUGMENTATION,
        phase="augmentation",
        skip=skip,
        kind=kind,
        input_records=len(collection_output.get("records") or []),
    )

    if skip:
        phase = _phase_record(
            PHASE_AUGMENTATION,
            "augmentation",
            "skipped",
            reason="pipeline.skip_augmentation",
        )
        log("phase_done", phase_id=PHASE_AUGMENTATION, phase="augmentation", status="skipped")
        return collection_output, phase

    if kind == "customer-leads":
        # Customer-leads phase 2 lives in customer_leads.py (preprocess|augment).
        # Full auto-dispatch still needs source-output paths from phase 1 runs.
        phase = _phase_record(
            PHASE_AUGMENTATION,
            "augmentation",
            "skipped",
            reason=(
                "customer-leads phase 2 is tools/data-collection/customer_leads.py "
                "(preprocess|augment|review-list); invoke those subcommands with "
                "source-output artifacts, or extend run to pass them"
            ),
            module="customer_leads",
        )
        log(
            "phase_done",
            phase_id=PHASE_AUGMENTATION,
            phase="augmentation",
            status="skipped",
            reason=phase.get("reason"),
        )
        return collection_output, phase

    if kind == "ad-content-intel":
        # See ad_content/phase2.py and ad_content/README.md
        from ad_content.phase2 import run_augmentation as run_ad_augmentation

        augmented, ad_phase = run_ad_augmentation(
            input_value=input_value,
            collection_output=collection_output,
            work_dir=work_dir,
            run_prefix=run_prefix,
        )
        phase = _phase_record(
            PHASE_AUGMENTATION,
            "augmentation",
            ad_phase.get("status", "succeeded"),
            **{
                key: value
                for key, value in ad_phase.items()
                if key not in {"phase_id", "phase", "status"}
            },
        )
        return augmented, phase

    # Literature phase 2 — see literature/phase2.py and literature/README.md
    from literature.phase2 import run_augmentation

    augmented, lit_phase = run_augmentation(
        input_value=input_value,
        collection_output=collection_output,
        work_dir=work_dir,
        run_prefix=run_prefix,
    )
    phase = _phase_record(
        PHASE_AUGMENTATION,
        "augmentation",
        lit_phase.get("status", "succeeded"),
        **{
            key: value
            for key, value in lit_phase.items()
            if key not in {"phase_id", "phase", "status"}
        },
    )
    return augmented, phase


def phase_manual_review(
    input_value: dict[str, Any],
    augmented_output: dict[str, Any],
    workspace: str,
    *,
    review_mode: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Phase 3: auto-pass, auto-approve, or a human manual-review queue.

    This is not phase 2. PDF capture and other enrichments belong in phase 2
    (augmentation) only.
    """
    if review_mode not in REVIEW_MODES:
        choices = ", ".join(sorted(REVIEW_MODES))
        raise CliError(f"review_mode must be one of: {choices}")
    log(
        "phase_start",
        phase_id=PHASE_MANUAL_REVIEW,
        phase="manual-review",
        review_mode=review_mode,
        record_count=len(augmented_output.get("records") or []),
    )
    root = Path(os.environ["POLARIS_LITERATURE_WORKSPACES_ROOT"]).resolve()
    collection_base = root / workspace / "data-collections" / input_value["collection_id"]
    outputs_dir = collection_base / "outputs"
    work_dir = collection_base / "work"
    outputs_dir.mkdir(parents=True, exist_ok=True)
    work_dir.mkdir(parents=True, exist_ok=True)
    observed = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    review_records = []
    non_review_records = []
    for record in augmented_output.get("records", []):
        payload = record.get("payload") or {}
        qualification = payload.get("qualification") or {}
        needs_review = bool(qualification.get("manual_review_required", True))
        if needs_review:
            review_records.append(record)
        else:
            non_review_records.append(record)

    review_list_path = outputs_dir / "manual-review-list.json"
    non_review_path = outputs_dir / "non-review-results.json"

    def write_review_artifacts() -> None:
        review_list_path.write_text(
            json.dumps(
                {
                    "schema_version": REVIEW_LIST_SCHEMA,
                    "collection_id": input_value["collection_id"],
                    "collection_kind": input_value["collection_kind"],
                    "generated_at": observed,
                    "phase_id": PHASE_MANUAL_REVIEW,
                    "phase": "manual-review",
                    "review_mode": review_mode,
                    "review_records": review_records,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        non_review_path.write_text(
            json.dumps(
                {
                    "schema_version": NON_REVIEW_SCHEMA,
                    "collection_id": input_value["collection_id"],
                    "collection_kind": input_value["collection_kind"],
                    "generated_at": observed,
                    "phase_id": PHASE_MANUAL_REVIEW,
                    "phase": "manual-review",
                    "review_mode": review_mode,
                    "qualified_without_manual_review": non_review_records,
                    "rejected_records": list(augmented_output.get("rejected_records") or []),
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    if review_mode in {"auto-pass", "auto-approve"}:
        automatic_status = "not_required" if review_mode == "auto-pass" else "approved"
        automatic_mode = review_mode.replace("-", "_")
        records: list[dict[str, Any]] = []
        for record in augmented_output.get("records", []):
            payload = dict(record.get("payload") or {})
            review = {
                "status": automatic_status,
                "mode": automatic_mode,
                "updated_at": observed,
                "note": (
                    "Automatically approved by data-collection phase 3."
                    if review_mode == "auto-approve"
                    else "Review bypassed by data-collection phase 3 auto-pass mode."
                ),
                "phase_id": PHASE_MANUAL_REVIEW,
                "phase": "manual-review",
            }
            payload["manual_review"] = review
            qualification = dict(payload.get("qualification") or {})
            qualification["manual_review_required"] = False
            payload["qualification"] = qualification
            records.append({**record, "payload": payload})
        final = {
            **augmented_output,
            "status": "final",
            "records": records,
            "pipeline": {
                "order": [
                    {"phase_id": PHASE_COLLECTION, "phase": "collection"},
                    {"phase_id": PHASE_AUGMENTATION, "phase": "augmentation"},
                    {"phase_id": PHASE_MANUAL_REVIEW, "phase": "manual-review"},
                ],
                "manual_review": automatic_mode,
                "review_mode": review_mode,
            },
        }
        if review_mode == "auto-approve":
            write_review_artifacts()
            final["pipeline"]["manual_review_list"] = str(review_list_path)
            final["pipeline"]["non_review_results"] = str(non_review_path)
        phase = _phase_record(
            PHASE_MANUAL_REVIEW,
            "manual-review",
            "auto_passed" if review_mode == "auto-pass" else "auto_approved",
            review_mode=review_mode,
            approved_count=len(records) if review_mode == "auto-approve" else 0,
            pending_count=0,
        )
        log(
            "phase_done",
            phase_id=PHASE_MANUAL_REVIEW,
            phase="manual-review",
            status=phase["status"],
            review_mode=review_mode,
            approved_count=phase["approved_count"],
        )
        return final, phase

    write_review_artifacts()

    pending = {
        **augmented_output,
        "status": "pending_manual_review",
        "pipeline": {
            "order": [
                {"phase_id": PHASE_COLLECTION, "phase": "collection"},
                {"phase_id": PHASE_AUGMENTATION, "phase": "augmentation"},
                {"phase_id": PHASE_MANUAL_REVIEW, "phase": "manual-review"},
            ],
            "manual_review": "pending",
            "review_mode": review_mode,
            "manual_review_list": str(review_list_path),
            "non_review_results": str(non_review_path),
            "hint": (
                "Phase 3 pending. Open manual-review-list.json in the admin portal, "
                "or re-run with --review-mode auto-pass or auto-approve."
            ),
        },
    }
    phase = _phase_record(
        PHASE_MANUAL_REVIEW,
        "manual-review",
        "pending",
        manual_review_list=str(review_list_path),
        non_review_results=str(non_review_path),
        pending_count=len(review_records),
        auto_count=len(non_review_records),
    )
    log(
        "phase_done",
        phase_id=PHASE_MANUAL_REVIEW,
        phase="manual-review",
        status="pending",
        pending_count=len(review_records),
        auto_count=len(non_review_records),
        manual_review_list=str(review_list_path),
    )
    return pending, phase


def run_three_phase_pipeline(
    input_value: dict[str, Any],
    workspace: str,
    run_prefix: str,
    *,
    review_mode: str | None = None,
) -> dict[str, Any]:
    """Run fixed order: phase 1 collection → phase 2 augmentation → phase 3 manual-review."""
    options = pipeline_options(input_value, review_mode)
    phases: list[dict[str, Any]] = []
    log(
        "pipeline_start",
        workspace=workspace,
        collection_id=input_value.get("collection_id"),
        collection_kind=input_value.get("collection_kind"),
        run_prefix=run_prefix,
        review_mode=options["review_mode"],
        skip_augmentation=options["skip_augmentation"],
        order=[{"phase_id": pid, "phase": name} for pid, name in PIPELINE_PHASES],
    )

    root = Path(os.environ["POLARIS_LITERATURE_WORKSPACES_ROOT"]).resolve()
    collection_base = root / workspace / "data-collections" / input_value["collection_id"]
    expand_dir = collection_base / "work" / f"{run_prefix}-expand"
    expand_path = expand_dir / "expanded-collection.json"
    expand_state_path = expand_dir / "expand-state.json"

    # Resume short-circuit: finished expand (frontier empty) → skip seed re-fetch
    # and re-expand; continue at phase 2 (PDF capture resumes per-record on disk).
    resume_from_expand = False
    collected: dict[str, Any] | None = None
    if (
        input_value.get("collection_kind") == "literature"
        and expand_path.is_file()
        and expand_state_path.is_file()
    ):
        try:
            st = json.loads(expand_state_path.read_text(encoding="utf-8"))
            if "frontier" in st and len(st.get("frontier") or []) == 0:
                resumed = json.loads(expand_path.read_text(encoding="utf-8"))
                if isinstance(resumed, dict) and isinstance(resumed.get("records"), list) and resumed["records"]:
                    collected = resumed
                    resume_from_expand = True
                    seed_path = collection_base / "work" / "collection-output.json"
                    phases.append(
                        _phase_record(
                            PHASE_COLLECTION,
                            "collection",
                            "resumed",
                            output=str(seed_path if seed_path.is_file() else expand_path),
                            record_count=len(collected.get("records") or []),
                            note="skipped seed re-fetch; using finished expand artifact",
                        )
                    )
                    phases.append(
                        {
                            "phase_id": 1,
                            "phase": "expansion",
                            "status": "resumed",
                            "record_count": len(collected.get("records") or []),
                            "output": str(expand_path),
                            "graph_dot": (collected.get("literature_expansion") or {}).get(
                                "graph_dot"
                            ),
                            "stats": (collected.get("literature_expansion") or {}).get("stats"),
                        }
                    )
                    log(
                        "pipeline_resume_from_expand",
                        record_count=len(collected.get("records") or []),
                        expand_output=str(expand_path),
                        round=st.get("round"),
                    )
        except (OSError, json.JSONDecodeError, TypeError, ValueError) as error:
            log("pipeline_resume_from_expand_failed", error=str(error)[:300])
            resume_from_expand = False
            collected = None

    if not resume_from_expand:
        # Phase 1 — collection (seed search / DOI tasks)
        collected, task_results, collection_path = phase_collection(
            input_value, workspace, run_prefix
        )
        phases.append(
            _phase_record(
                PHASE_COLLECTION,
                "collection",
                "succeeded",
                tasks=task_results,
                output=str(collection_path),
                record_count=len(collected.get("records") or []),
            )
        )

    # Phase 1.5 — expansion (kind-specific). See literature/phase15 or ad_content/phase15.
    if not resume_from_expand and input_value.get("collection_kind") == "literature":
        try:
            from literature.phase15 import run_expansion

            assert collected is not None
            collected, expand_phase = run_expansion(
                input_value=input_value,
                collected=collected,
                collection_base=collection_base,
                run_prefix=run_prefix,
                expand_dir=expand_dir,
            )
            phases.append(expand_phase)
        except Exception as error:  # noqa: BLE001
            log("expand_phase_failed", error=str(error))
            phases.append(
                {
                    "phase_id": 1,
                    "phase": "expansion",
                    "status": "failed",
                    "error": str(error),
                }
            )
    elif (
        not resume_from_expand
        and input_value.get("collection_kind") == "ad-content-intel"
    ):
        try:
            from ad_content.phase15 import run_expansion as run_ad_expansion

            assert collected is not None
            collected, expand_phase = run_ad_expansion(
                input_value=input_value,
                collected=collected,
                collection_base=collection_base,
                run_prefix=run_prefix,
                expand_dir=expand_dir,
            )
            phases.append(expand_phase)
        except Exception as error:  # noqa: BLE001
            log("expand_phase_failed", kind="ad-content-intel", error=str(error))
            phases.append(
                {
                    "phase_id": 1,
                    "phase": "expansion",
                    "status": "failed",
                    "error": str(error),
                }
            )

    if collected is None:
        raise CliError("pipeline has no collected corpus after phase 1 / expand")

    # Phase 2 — augmentation / PDF capture (never manual-review)
    augmented, aug_phase = phase_augmentation(
        input_value,
        collected,
        workspace,
        run_prefix,
        skip=options["skip_augmentation"],
    )
    phases.append(aug_phase)

    # Phase 3 — review mode decides whether the human gate is bypassed.
    final, review_phase = phase_manual_review(
        input_value,
        augmented,
        workspace,
        review_mode=options["review_mode"],
    )
    phases.append(review_phase)

    pipeline_meta = dict(final.get("pipeline") or {})
    pipeline_meta["order"] = [
        {"phase_id": phase_id, "phase": name} for phase_id, name in PIPELINE_PHASES
    ]
    pipeline_meta["phases"] = phases
    pipeline_meta["review_mode"] = options["review_mode"]
    pipeline_meta["skip_augmentation"] = options["skip_augmentation"]
    final = {**final, "pipeline": pipeline_meta}
    log(
        "pipeline_done",
        collection_status=final.get("status"),
        record_count=len(final.get("records") or []),
        phase_statuses=[
            {"phase_id": item.get("phase_id"), "phase": item.get("phase"), "status": item.get("status")}
            for item in phases
        ],
    )
    return final


def normalize_curated_web_search(
    input_value: dict[str, Any],
    source: str,
    source_by_task_id: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Normalize SearXNG discovery results from the curated source catalog."""
    document = read_json(source, "curated web-search source")
    task_results = required_list(document, "task_results", "curated web-search source")
    records: list[dict[str, Any]] = []
    for task in task_results:
        if not isinstance(task, dict) or task.get("status") != "succeeded":
            continue
        catalog_source = source_by_task_id.get(task.get("task_id"))
        if catalog_source is None:
            continue
        observed_at = task.get("searched_at")
        if not isinstance(observed_at, str) or not observed_at.strip():
            observed_at = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        for result in task.get("results", []):
            if not isinstance(result, dict):
                continue
            url = result.get("url")
            title = result.get("title")
            quote = result.get("content") if isinstance(result.get("content"), str) else title
            if not all(isinstance(item, str) and item.strip() for item in (url, title, quote)):
                continue
            payload = {
                "catalog_source": {
                    key: catalog_source[key]
                    for key in ("source_id", "title", "topic_ids", "seed_urls")
                },
                "search_result": result,
            }
            digest = "sha256:" + hashlib.sha256(
                json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
            ).hexdigest()
            records.append(
                {
                    "record_id": "url:" + hashlib.sha256(url.encode("utf-8")).hexdigest()[:24],
                    "record_kind": "web-candidate",
                    "source_url": url,
                    "observed_at": observed_at,
                    "content_hash": digest,
                    "evidence": [{"quote": quote, "locator": "search result snippet"}],
                    "payload": payload,
                }
            )
    unique = {record["record_id"]: record for record in records}
    return {
        "schema_version": OUTPUT_V2,
        "collection_id": input_value["collection_id"],
        "collection_kind": input_value["collection_kind"],
        "status": "candidate_set",
        "records": list(unique.values()),
        "rejected_records": [],
        "run_artifacts": [
            {
                "path": str(Path(source).expanduser().resolve()),
                "sha256": "sha256:" + hashlib.sha256(Path(source).read_bytes()).hexdigest(),
            }
        ],
        "information_gaps": [
            "Candidates are unreviewed; this output does not assert topical relevance or corpus-wide recall."
        ],
    }


def merge_normalized_outputs(outputs: list[dict[str, Any]]) -> dict[str, Any]:
    if not outputs:
        raise CliError("no source task produced a normalized output")
    records: dict[str, dict[str, Any]] = {}
    for output in outputs:
        for record in output["records"]:
            existing = records.get(record["record_id"])
            if existing is None:
                records[record["record_id"]] = record
                continue
            evidence = existing["evidence"] + [
                item for item in record["evidence"] if item not in existing["evidence"]
            ]
            records[record["record_id"]] = {
                **existing,
                "observed_at": record["observed_at"],
                "content_hash": record["content_hash"],
                "evidence": evidence,
                "payload": {**existing["payload"], **record["payload"]},
            }
    artifacts = [artifact for output in outputs for artifact in output["run_artifacts"]]
    gaps = [gap for output in outputs for gap in output["information_gaps"]]
    first = outputs[0]
    return {
        "schema_version": OUTPUT_V2,
        "collection_id": first["collection_id"],
        "collection_kind": first["collection_kind"],
        "status": "candidate_set",
        "records": list(records.values()),
        "rejected_records": [],
        "run_artifacts": artifacts,
        "information_gaps": list(dict.fromkeys(gaps)),
    }


LITERATURE_SOURCE_TYPES = frozenset(
    {
        "crossref-doi",
        "crossref-search",
        "crossref",
        "semantic-scholar-search",
        "semantic-scholar",
        "deepsec-search",
        "curated-web-search",
        # removed but recognized for skip messaging:
        "openalex-search",
        "google-scholar-search",
        "google-scholar-citations",
        "google_scholar",
    }
)


def run_phase1_sources(
    input_value: dict[str, Any], workspace: str, run_prefix: str
) -> tuple[list[dict[str, str]], list[tuple[str, str, dict[str, dict[str, Any]]]]]:
    """Dispatch phase-1 source tools for literature or ad-content-intel."""
    kind = input_value.get("collection_kind")
    if kind not in {"literature", "ad-content-intel"}:
        raise CliError(
            "run phase 1 supports collection_kind literature or ad-content-intel "
            "(customer-leads uses preprocess/augment subcommands)"
        )
    root = os.environ.get("POLARIS_LITERATURE_WORKSPACES_ROOT")
    if not root:
        raise CliError("POLARIS_LITERATURE_WORKSPACES_ROOT is required for --workspace")
    tools_root = Path(__file__).resolve().parents[1]
    collection_base = Path(root).resolve() / workspace / "data-collections" / input_value["collection_id"]
    for directory in ("case", "inputs", "work", "runs", "outputs"):
        (collection_base / directory).mkdir(parents=True, exist_ok=True)
    collection_root = collection_base / "runs"
    results = []
    sources: list[tuple[str, str, dict[str, dict[str, Any]]]] = []
    tasks = list(input_value["source_tasks"])
    log(
        "phase1_collection_start",
        phase_id=PHASE_COLLECTION,
        phase="collection",
        task_count=len(tasks),
        workspace=workspace,
        collection_id=input_value.get("collection_id"),
        collection_kind=kind,
        run_prefix=run_prefix,
    )
    for index, task in enumerate(tasks, start=1):
        source_type, task_id, config = task["source_type"], task["task_id"], task["config"]
        run_id = f"{run_prefix}-{task_id}"
        log(
            "phase1_task_start",
            phase_id=PHASE_COLLECTION,
            phase="collection",
            index=index,
            total=len(tasks),
            task_id=task_id,
            source_type=source_type,
        )
        if kind == "ad-content-intel" and source_type not in AD_CONTENT_SOURCE_TYPES:
            results.append(
                {
                    "task_id": task_id,
                    "status": "failed",
                    "reason": (
                        f"source_type {source_type!r} is not supported for "
                        f"ad-content-intel (allowed: {sorted(AD_CONTENT_SOURCE_TYPES)})"
                    ),
                }
            )
            log(
                "phase1_task_done",
                phase_id=PHASE_COLLECTION,
                phase="collection",
                index=index,
                total=len(tasks),
                task_id=task_id,
                source_type=source_type,
                status="failed",
                reason="unsupported source for ad-content-intel",
            )
            continue
        if kind == "literature" and source_type in {"social_media", "web-search"}:
            results.append(
                {
                    "task_id": task_id,
                    "status": "failed",
                    "reason": (
                        f"source_type {source_type!r} is for ad-content-intel; "
                        "use literature sources (crossref, semantic-scholar, deepsec, …)"
                    ),
                }
            )
            log(
                "phase1_task_done",
                phase_id=PHASE_COLLECTION,
                phase="collection",
                index=index,
                total=len(tasks),
                task_id=task_id,
                source_type=source_type,
                status="failed",
                reason="unsupported source for literature",
            )
            continue
        if source_type == "social_media":
            # See ad_content/phase1.py — JustOneAPI social-media batch.
            result_row, source = run_social_media_task(
                input_value=input_value,
                task_id=task_id,
                config=config,
                collection_root=collection_root,
                run_id=run_id,
                index=index,
                total=len(tasks),
            )
            results.append(result_row)
            if source is not None:
                sources.append(source)
            continue
        if source_type == "web-search":
            # See ad_content/phase1.py — web-search batch (ad default locale zh-CN).
            default_locale = "zh-CN" if kind == "ad-content-intel" else "en-US"
            result_row, source = run_web_search_task(
                input_value=input_value,
                task_id=task_id,
                config=config,
                collection_root=collection_root,
                run_id=run_id,
                index=index,
                total=len(tasks),
                default_locale=default_locale,
            )
            results.append(result_row)
            if source is not None:
                sources.append(source)
            continue
        if source_type == "openalex-search":
            results.append(
                {
                    "task_id": task_id,
                    "status": "skipped",
                    "reason": "openalex-search removed (noisy referenced_works expansion)",
                }
            )
            log(
                "phase1_task_done",
                phase_id=PHASE_COLLECTION,
                phase="collection",
                index=index,
                total=len(tasks),
                task_id=task_id,
                source_type=source_type,
                status="skipped",
                reason="openalex removed",
            )
            continue
        if source_type in {"google-scholar-search", "google-scholar-citations", "google_scholar"}:
            results.append(
                {
                    "task_id": task_id,
                    "status": "skipped",
                    "reason": "google-scholar removed; use crossref-search + semantic-scholar expand",
                }
            )
            log(
                "phase1_task_done",
                phase_id=PHASE_COLLECTION,
                phase="collection",
                index=index,
                total=len(tasks),
                task_id=task_id,
                source_type=source_type,
                status="skipped",
                reason="google-scholar removed",
            )
            continue
        if source_type == "crossref-doi":
            doi = config.get("doi") or config.get("DOI")
            if not isinstance(doi, str) or not doi.strip():
                raise CliError("crossref-doi config requires doi")
            output = collection_root / run_id / "seed.json"
            command = [
                str(tools_root / "crossref/clue-crossref-cli"),
                "doi",
                "--doi",
                doi.strip(),
                "--output",
                str(output),
            ]
            completed = subprocess.run(command, text=True, capture_output=True, check=False)
            status = "succeeded" if completed.returncode == 0 else "failed"
            results.append(
                {
                    "task_id": task_id,
                    "status": status,
                    "output": str(output),
                    "detail": completed.stderr.strip(),
                }
            )
            log(
                "phase1_task_done",
                phase_id=PHASE_COLLECTION,
                phase="collection",
                index=index,
                total=len(tasks),
                task_id=task_id,
                source_type=source_type,
                status=status,
                exit_code=completed.returncode,
            )
            if completed.returncode == 0:
                sources.append(("crossref-doi", str(output), {}))
            continue
        if source_type == "crossref-search":
            query = config.get("query") or config.get("keyword") or config.get("question")
            if not isinstance(query, str) or not query.strip():
                raise CliError("crossref-search config requires query")
            output = collection_root / run_id / "results.json"
            command = [
                str(tools_root / "crossref/clue-crossref-cli"),
                "search",
                "--query",
                query.strip(),
                "--output",
                str(output),
            ]
            rows = config.get("rows", config.get("limit", 20))
            try:
                rows = max(1, min(100, int(rows)))
            except (TypeError, ValueError):
                rows = 20
            command.extend(("--rows", str(rows)))
            for key, flag in (
                ("from_pub_date", "--from-pub-date"),
                ("until_pub_date", "--until-pub-date"),
            ):
                value = config.get(key)
                if isinstance(value, str) and value.strip():
                    command.extend((flag, value.strip()))
            # Default year window aligned with literature bounds when unset
            if not config.get("from_pub_date"):
                command.extend(("--from-pub-date", "2022-01-01"))
            if not config.get("until_pub_date"):
                command.extend(("--until-pub-date", "2026-12-31"))
            completed = subprocess.run(command, text=True, capture_output=True, check=False)
            status = "succeeded" if completed.returncode == 0 else "failed"
            results.append(
                {
                    "task_id": task_id,
                    "status": status,
                    "output": str(output),
                    "detail": completed.stderr.strip(),
                }
            )
            log(
                "phase1_task_done",
                phase_id=PHASE_COLLECTION,
                phase="collection",
                index=index,
                total=len(tasks),
                task_id=task_id,
                source_type=source_type,
                status=status,
                exit_code=completed.returncode,
            )
            if completed.returncode == 0:
                sources.append(("crossref-search", str(output), {}))
            continue
        if source_type == "semantic-scholar-search":
            query = config.get("query") or config.get("keyword") or config.get("question")
            if not isinstance(query, str) or not query.strip():
                raise CliError("semantic-scholar-search config requires query")
            output = collection_root / run_id / "results.json"
            limit = config.get("limit", 20)
            try:
                limit = max(1, min(100, int(limit)))
            except (TypeError, ValueError):
                limit = 20
            # Tutorial: prefer bulk/batch for larger result sets.
            use_bulk = config.get("bulk", True)
            command = [
                str(tools_root / "semantic-scholar/clue-semantic-scholar-cli"),
                "search",
                "--query",
                query.strip(),
                "--limit",
                str(limit),
                "--output",
                str(output),
            ]
            if use_bulk is not False:
                command.append("--bulk")
            completed = subprocess.run(command, text=True, capture_output=True, check=False)
            status = "succeeded" if completed.returncode == 0 else "failed"
            results.append(
                {
                    "task_id": task_id,
                    "status": status,
                    "output": str(output),
                    "detail": completed.stderr.strip(),
                }
            )
            log(
                "phase1_task_done",
                phase_id=PHASE_COLLECTION,
                phase="collection",
                index=index,
                total=len(tasks),
                task_id=task_id,
                source_type=source_type,
                status=status,
                exit_code=completed.returncode,
            )
            if completed.returncode == 0:
                sources.append(("semantic-scholar-search", str(output), {}))
            continue
        elif source_type == "curated-web-search":
            query = required_string(config, "query", "curated-web-search config")
            selected_sources = selected_catalog_sources(config)
            locale = config.get("locale", "en-US")
            if not isinstance(locale, str) or not locale.strip():
                raise CliError("curated-web-search config locale must be a non-empty string")
            search_tasks, source_by_task_id = catalog_search_tasks(
                task_id, query, locale, selected_sources
            )
            request = {
                "collection_id": input_value["collection_id"],
                "sources": [{
                    "source_type": "web_search",
                    "tasks": search_tasks,
                }],
            }
            request_path = collection_root / run_id / "request.json"
            request_path.parent.mkdir(parents=True, exist_ok=True)
            request_path.write_text(json.dumps(request, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            output = collection_root / run_id / "search" / "results.json"
            command = [
                str(tools_root / "web-search/clue-web-search-cli"),
                "batch",
                "--input",
                str(request_path),
                "--output",
                str(output.parent),
            ]
            completed = subprocess.run(command, text=True, capture_output=True, check=False)
            status = "succeeded" if completed.returncode == 0 else "failed"
            results.append({"task_id": task_id, "status": status, "output": str(output), "detail": completed.stderr.strip()})
            log(
                "phase1_task_done",
                phase_id=PHASE_COLLECTION,
                phase="collection",
                index=index,
                total=len(tasks),
                task_id=task_id,
                source_type=source_type,
                status=status,
                exit_code=completed.returncode,
            )
            if completed.returncode == 0:
                sources.append(("curated-web-search", str(output), source_by_task_id))
            continue
        elif source_type == "deepsec-search":
            keyword = config.get("keyword", config.get("question"))
            if not isinstance(keyword, str) or not keyword.strip():
                raise CliError("deepsec-search config requires keyword or question")
            # DeepSec API allows limit 1..100; page with offset until max_results or empty.
            page_limit = config.get("limit", 100)
            try:
                page_limit = max(1, min(100, int(page_limit)))
            except (TypeError, ValueError):
                page_limit = 100
            max_results = config.get("max_results", page_limit)
            try:
                max_results = max(1, int(max_results))
            except (TypeError, ValueError):
                max_results = page_limit
            search_in = config.get("search_in", ["title", "abstract"])
            if not isinstance(search_in, list) or not search_in or not all(
                isinstance(item, str) and item in {"title", "abstract", "full_text", "structured"}
                for item in search_in
            ):
                raise CliError("deepsec-search config search_in must contain supported search areas")
            merged_papers: list[dict[str, Any]] = []
            offset = int(config.get("offset") or 0)
            pages = 0
            ok = True
            detail = ""
            while len(merged_papers) < max_results and pages < 50:
                pages += 1
                take = min(page_limit, max_results - len(merged_papers))
                output = collection_root / run_id / f"results-offset-{offset}.json"
                command = [
                    str(tools_root / "deepsec/clue-deepsec-cli"),
                    "search",
                    "--keyword",
                    keyword,
                    "--output",
                    str(output),
                    "--limit",
                    str(take),
                    "--offset",
                    str(offset),
                ]
                for area in search_in:
                    command.extend(("--search-in", area))
                for field in ("conference", "year"):
                    value = config.get(field)
                    if value is not None:
                        command.extend((f"--{field.replace('_', '-')}", str(value)))
                completed = subprocess.run(command, text=True, capture_output=True, check=False)
                if completed.returncode != 0:
                    ok = False
                    detail = completed.stderr.strip()
                    break
                try:
                    page_doc = json.loads(output.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError) as error:
                    ok = False
                    detail = str(error)
                    break
                papers = page_doc.get("papers") if isinstance(page_doc, dict) else None
                if not isinstance(papers, list) or not papers:
                    break
                merged_papers.extend(item for item in papers if isinstance(item, dict))
                if len(papers) < take:
                    break
                offset += len(papers)
            merged_path = collection_root / run_id / "results.json"
            merged_path.parent.mkdir(parents=True, exist_ok=True)
            merged_path.write_text(
                json.dumps(
                    {
                        "schema_version": "clue.deepsec.search.v1",
                        "tool": {"name": "clue-deepsec-cli", "version": "merged"},
                        "request": {
                            "keyword": keyword,
                            "search_in": search_in,
                            "limit": page_limit,
                            "max_results": max_results,
                            "pages": pages,
                        },
                        "total": len(merged_papers),
                        "papers": merged_papers[:max_results],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            status = "succeeded" if ok else "failed"
            results.append(
                {
                    "task_id": task_id,
                    "status": status,
                    "output": str(merged_path),
                    "detail": detail,
                    "returned": len(merged_papers[:max_results]),
                }
            )
            log(
                "phase1_task_done",
                phase_id=PHASE_COLLECTION,
                phase="collection",
                index=index,
                total=len(tasks),
                task_id=task_id,
                source_type=source_type,
                status=status,
                returned=len(merged_papers[:max_results]),
            )
            if ok:
                sources.append(("deepsec-search", str(merged_path), {}))
            continue
        else:
            results.append({"task_id": task_id, "status": "skipped", "reason": f"unsupported source_type: {source_type}"})
            log(
                "phase1_task_done",
                phase_id=PHASE_COLLECTION,
                phase="collection",
                index=index,
                total=len(tasks),
                task_id=task_id,
                source_type=source_type,
                status="skipped",
                reason=f"unsupported source_type: {source_type}",
            )
            continue
    log(
        "phase1_collection_done",
        phase_id=PHASE_COLLECTION,
        phase="collection",
        succeeded=sum(1 for item in results if item.get("status") == "succeeded"),
        failed=sum(1 for item in results if item.get("status") == "failed"),
        skipped=sum(1 for item in results if item.get("status") == "skipped"),
        source_artifacts=len(sources),
    )
    return results, sources


def command_init() -> int:
    """Prepare local runtimes used by phase 2 (customer-leads email extract)."""
    root = Path(__file__).resolve().parent
    runtime_python = root / "runtime" / "python" / "bin" / "python"
    backend_dir = root / "backend" / "kichik-email-scraper"
    steps: list[dict[str, Any]] = []

    if not backend_dir.is_dir():
        emit({
            "status": "failed",
            "command": "init",
            "error": f"email backend checkout missing: {backend_dir}",
            "hint": "Vendor kichik/email-scraper under tools/data-collection/backend/kichik-email-scraper",
        })
        return 2

    import subprocess
    import venv

    runtime_root = root / "runtime" / "python"
    if not runtime_python.is_file():
        venv.create(runtime_root, with_pip=True)
        steps.append({"step": "create_venv", "path": str(runtime_root), "status": "created"})
    else:
        steps.append({"step": "create_venv", "path": str(runtime_root), "status": "exists"})

    pip = [
        str(runtime_python),
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
    ]
    install_backend = subprocess.run(
        [*pip, "--no-deps", str(backend_dir)],
        text=True,
        capture_output=True,
        check=False,
    )
    if install_backend.returncode != 0:
        emit({
            "status": "failed",
            "command": "init",
            "error": "failed to install email backend",
            "stderr": (install_backend.stderr or "")[-2000:],
            "steps": steps,
        })
        return 2
    steps.append({"step": "install_email_backend", "status": "succeeded"})

    install_tlds = subprocess.run(
        [*pip, "tlds==2026041800"],
        text=True,
        capture_output=True,
        check=False,
    )
    if install_tlds.returncode != 0:
        emit({
            "status": "failed",
            "command": "init",
            "error": "failed to install tlds pin",
            "stderr": (install_tlds.stderr or "")[-2000:],
            "steps": steps,
        })
        return 2
    steps.append({"step": "install_tlds", "status": "succeeded", "version": "2026041800"})

    smoke = subprocess.run(
        [
            str(runtime_python),
            "-c",
            (
                "from email_scraper import scrape_emails; "
                "assert scrape_emails("
                "'<a href=\"mailto:info@example.test\">Contact</a>') "
                "== {'info@example.test'}; "
                "print('ready')"
            ),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    if smoke.returncode != 0:
        emit({
            "status": "failed",
            "command": "init",
            "error": "email extractor smoke test failed",
            "stderr": (smoke.stderr or "")[-2000:],
            "steps": steps,
        })
        return 2
    steps.append({"step": "smoke_email_scraper", "status": "succeeded"})

    backend_ref = None
    git_dir = backend_dir / ".git"
    if git_dir.exists():
        ref = subprocess.run(
            ["git", "-C", str(backend_dir), "rev-parse", "HEAD"],
            text=True,
            capture_output=True,
            check=False,
        )
        if ref.returncode == 0:
            backend_ref = (ref.stdout or "").strip()

    emit({
        "status": "succeeded",
        "command": "init",
        "runtime_python": str(runtime_python),
        "email_backend": str(backend_dir),
        "email_backend_git": backend_ref,
        "steps": steps,
        "note": (
            "Phase 2 customer-leads augment can use the locked email extractor. "
            "Literature PDF capture uses tools/browser and does not need this runtime."
        ),
    })
    return 0


def main(argv: list[str]) -> int:
    # Phase 2 customer-leads commands live in customer_leads.py (former
    # tools/augmentation runner). Dispatch early so argparse stays split.
    customer_phase2 = {
        "preprocess",
        "augment",
        "review-list",
        "non-review-results",
    }
    if argv and argv[0] in customer_phase2:
        import customer_leads

        return int(customer_leads.main(argv))

    parser = argparse.ArgumentParser(prog=TOOL_NAME)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("version")
    sub.add_parser(
        "capture-xhs-post",
        help="Capture one public Xiaohongshu post; invoke through the shell entrypoint.",
    )
    sub.add_parser(
        "mine-xhs-knowledge",
        help="Mine captured XHS text into cited knowledge and a two-agent model.",
    )
    sub.add_parser(
        "init",
        help="Prepare local phase-2 runtime (locked email extractor venv).",
    )
    input_parser = sub.add_parser("validate-input")
    input_parser.add_argument("--input", required=True)
    output_parser = sub.add_parser("validate-output")
    output_parser.add_argument("--output", required=True)
    catalog_parser = sub.add_parser("list-sources")
    catalog_parser.add_argument("--topic")
    run_parser = sub.add_parser(
        "run",
        help=(
            "Three-phase pipeline: "
            "1=collection, 2=augmentation, 3=manual-review."
        ),
    )
    run_parser.add_argument("--input", required=True)
    run_parser.add_argument("--workspace", required=True)
    run_parser.add_argument("--run-prefix", required=True)
    run_parser.add_argument("--output")
    run_parser.add_argument(
        "--review-mode",
        choices=sorted(REVIEW_MODES),
        help="Override pipeline.review_mode for phase 3.",
    )
    # Document phase-2 customer commands (handled above).
    sub.add_parser("preprocess", help="Phase 2 customer-leads: see customer_leads module.")
    sub.add_parser("augment", help="Phase 2 customer-leads: see customer_leads module.")
    sub.add_parser("review-list", help="Phase 2 customer-leads: see customer_leads module.")
    sub.add_parser("non-review-results", help="Phase 2 customer-leads: see customer_leads module.")
    args = parser.parse_args(argv)
    try:
        if args.command == "version":
            emit({
                "tool": TOOL_NAME,
                "version": (Path(__file__).parent / "VERSION").read_text().strip(),
                "input_schema": INPUT_V2,
                "output_schema": OUTPUT_V2,
                "pipeline_phases": [
                    {"phase_id": phase_id, "phase": name}
                    for phase_id, name in PIPELINE_PHASES
                ],
                "phase2_modules": {
                    "literature_pdf": "literature/pdf_capture.py + tools/browser",
                    "literature_package": "tools/data-collection/literature/ (see README)",
                    "ad_content_package": "tools/data-collection/ad_content/ (see README)",
                    "customer_leads": "customer_leads.py + website.py",
                },
                "specialized_commands": {
                    "capture_xhs_post": "capture-xhs-post (explicit public URL; locked social-media SDK)",
                    "mine_xhs_knowledge": "mine-xhs-knowledge (cited knowledge + two-body simulation)",
                },
                "init": "prepares runtime/python for phase-2 email extraction",
            })
        elif args.command == "init":
            return command_init()
        elif args.command == "validate-input":
            value = read_json(args.input, "input")
            emit({"status": "valid", "contract": input_version(value), "collection_kind": value.get("collection_kind")})
        elif args.command == "validate-output":
            value = read_json(args.output, "output")
            if value.get("schema_version") != OUTPUT_V2:
                raise CliError(f"output must use {OUTPUT_V2}")
            validate_v2_output(value)
            emit({"status": "valid", "contract": "v2", "collection_kind": value["collection_kind"], "record_count": len(value["records"])})
        elif args.command == "list-sources":
            catalog = load_source_catalog()
            sources = catalog["sources"]
            if args.topic:
                if args.topic not in {item["topic_id"] for item in catalog["topics"]}:
                    raise CliError(f"unknown source catalog topic: {args.topic}")
                sources = [item for item in sources if args.topic in item["topic_ids"]]
            emit({"schema_version": SOURCE_CATALOG_SCHEMA, "topics": catalog["topics"], "sources": sources})
        elif args.command in {"capture-xhs-post", "mine-xhs-knowledge"}:
            raise CliError(
                f"{args.command} must be invoked through ./clue-data-collection so "
                "the required runtime is selected"
            )

        elif args.command in customer_phase2:
            import customer_leads

            return int(customer_leads.main(argv))
        else:
            input_value = read_json(args.input, "input")
            input_version(input_value)
            kind = input_value.get("collection_kind")
            if kind not in {"literature", "ad-content-intel"}:
                raise CliError(
                    "run implements the three-phase pipeline for literature and "
                    "ad-content-intel v2 inputs; customer-leads phase 2 uses "
                    "preprocess/augment subcommands (customer_leads.py)"
                )
            final = run_three_phase_pipeline(
                input_value,
                args.workspace,
                args.run_prefix,
                review_mode=getattr(args, "review_mode", None),
            )
            root = Path(os.environ["POLARIS_LITERATURE_WORKSPACES_ROOT"]).resolve()
            output = (
                Path(args.output).expanduser().resolve()
                if args.output
                else root
                / args.workspace
                / "data-collections"
                / input_value["collection_id"]
                / "outputs/output.json"
            )
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(
                json.dumps(final, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            validate_v2_output(final)
            phases = (final.get("pipeline") or {}).get("phases") or []
            emit({
                "status": "succeeded",
                "output": str(output),
                "record_count": len(final.get("records") or []),
                "collection_status": final.get("status"),
                "pipeline": phases,
            })
        return 0
    except (CliError, LiteratureError, AdContentError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
