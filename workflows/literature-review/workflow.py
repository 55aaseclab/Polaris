#!/usr/bin/env python3
"""Polaris-owned literature-review workflow runner.

This is the migrated orchestration boundary. It invokes only tools from the
Polaris common tool root and never imports or executes another application.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


WORKFLOW_RUN_SCHEMA = "polaris.literature-review.run.v1"
WORKFLOW_ROOT = Path(__file__).resolve().parent
REPO_ROOT = WORKFLOW_ROOT.parent.parent
TOOLS_ROOT = REPO_ROOT / "tools"
WORKSPACE_ID = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
REVIEW_MODES = {"auto-pass", "auto-approve", "manual-review"}
LITERATURE_METHODS = {"iterate", "batches", "propose"}
REPORT_MODES = {"fixed", "reviewed"}
LOCAL_MODE = "local"


class WorkflowError(Exception):
    """A bounded, user-facing workflow error."""


def definition_path() -> Path:
    return (WORKFLOW_ROOT / "main.ord").resolve()


def definition_digest() -> str:
    path = definition_path()
    if not path.is_file():
        raise WorkflowError(f"literature workflow definition is missing: {path}")
    return digest_file(path)


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def digest_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def digest_file(path: Path) -> str:
    try:
        return digest_bytes(path.read_bytes())
    except OSError as error:
        raise WorkflowError(f"cannot hash file {path}: {error}") from error


def digest_json(value: Any) -> str:
    return digest_bytes(canonical_json(value))


def read_json(path: Path, label: str) -> dict[str, Any]:
    path = path.expanduser().resolve()
    if not path.is_file():
        raise WorkflowError(f"{label} does not exist: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise WorkflowError(f"{label} is not valid UTF-8 JSON: {path}") from error
    if not isinstance(value, dict):
        raise WorkflowError(f"{label} must be a JSON object: {path}")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        temporary.write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise WorkflowError(f"{label} must be a non-empty string")
    return value.strip()


def configured_value(environment: dict[str, str], key: str) -> str:
    return (environment.get(key) or os.environ.get(key) or "").strip()


def require_workspace_root(environment: dict[str, str]) -> Path:
    configured = configured_value(environment, "POLARIS_LITERATURE_WORKSPACES_ROOT")
    if not configured:
        raise WorkflowError(
            "POLARIS_LITERATURE_WORKSPACES_ROOT is required; "
            "set it to the parent directory containing workspace directories"
        )
    root = Path(configured).expanduser().resolve()
    if not root.is_dir() or root.is_symlink():
        raise WorkflowError(f"literature workspace root is not a real directory: {root}")
    return root


def workspace_directory(workspace_id: str, environment: dict[str, str]) -> Path:
    workspace_id = require_string(workspace_id, "workspace")
    if not WORKSPACE_ID.fullmatch(workspace_id):
        raise WorkflowError("workspace must match ^[a-z][a-z0-9-]{0,62}$")
    root = require_workspace_root(environment)
    target = (root / workspace_id).resolve()
    if target.parent != root or target.is_symlink() or not target.is_dir():
        raise WorkflowError(f"workspace is not a real direct child: {target}")
    return target


def safe_run_id(value: str, label: str) -> str:
    value = require_string(value, label)
    if not RUN_ID.fullmatch(value):
        raise WorkflowError(
            f"{label} may contain only letters, numbers, dot, underscore and hyphen"
        )
    return value


def safe_collection_id(value: Any) -> str:
    """Validate the collection directory component before joining paths."""
    return safe_run_id(value, "collection_id")


def tool_path(*parts: str) -> Path:
    path = (TOOLS_ROOT.joinpath(*parts)).resolve()
    if path.parent != TOOLS_ROOT and not str(path).startswith(f"{TOOLS_ROOT}{os.sep}"):
        raise WorkflowError(f"tool path escapes the Polaris common tool root: {path}")
    if not path.is_file():
        raise WorkflowError(f"migrated tool is missing: {path}")
    return path


def load_tool_module(relative_path: tuple[str, ...], module_name: str) -> Any:
    """Load one fixed common-tool module without runner-name collisions."""
    path = tool_path(*relative_path)
    module_directory = str(path.parent)
    if module_directory not in sys.path:
        sys.path.insert(0, module_directory)
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise WorkflowError(f"cannot load migrated module: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def component_versions() -> dict[str, str]:
    result: dict[str, str] = {}
    for name, relative in (
        ("data_collection", ("data-collection", "VERSION")),
        ("collection_review", ("collection-review", "VERSION")),
        ("analysis_review", ("analysis-review", "VERSION")),
        ("intelligence_analysis", ("intelligence-analysis", "VERSION")),
        ("literature_review", ("intelligence-analysis", "literature-review", "VERSION")),
        ("report_writing", ("report-writing", "VERSION")),
        ("codex", ("codex", "VERSION")),
    ):
        result[name] = tool_path(*relative).read_text(encoding="utf-8").strip()
    return result


def command_environment(environment: dict[str, str]) -> dict[str, str]:
    result = dict(os.environ)
    for key in list(result):
        if key.startswith("WANGHAI_"):
            del result[key]
    result.update(environment)
    # All Python modules are imported from the Polaris common tool root, never
    # from a checkout selected by the caller.
    python_paths = [
        TOOLS_ROOT / "data-collection",
        TOOLS_ROOT / "intelligence-analysis",
        TOOLS_ROOT / "intelligence-analysis" / "literature-review",
        TOOLS_ROOT / "report-writing",
        TOOLS_ROOT / "crossref",
        TOOLS_ROOT / "semantic-scholar",
        TOOLS_ROOT / "deepsec",
        TOOLS_ROOT / "codex",
        TOOLS_ROOT / "image-review",
        TOOLS_ROOT / "video-review",
        TOOLS_ROOT / "social-media",
    ]
    prior = result.get("PYTHONPATH", "")
    result["PYTHONPATH"] = os.pathsep.join(
        [str(path) for path in python_paths] + ([prior] if prior else [])
    )
    # An explicitly selected env file must not reintroduce the retired
    # Wanghai namespace into a child process.
    for key in list(result):
        if key.startswith("WANGHAI_"):
            del result[key]
    return result


def parse_last_json(stdout: str) -> dict[str, Any]:
    try:
        value = json.loads(stdout)
    except json.JSONDecodeError:
        value = None
    if isinstance(value, dict):
        return value
    for line in reversed(stdout.splitlines()):
        candidate = line.strip()
        if not candidate:
            continue
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    try:
        value = json.loads(stdout)
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def run_child(
    label: str,
    command: list[str],
    *,
    environment: dict[str, str],
    log_dir: Path,
) -> dict[str, Any]:
    log_dir.mkdir(parents=True, exist_ok=True)
    started = utc_now()
    try:
        completed = subprocess.run(
            command,
            cwd=str(WORKFLOW_ROOT),
            env=command_environment(environment),
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError as error:
        raise WorkflowError(f"{label} could not start: {error}") from error
    (log_dir / f"{label}.stdout.log").write_text(
        completed.stdout or "", encoding="utf-8"
    )
    (log_dir / f"{label}.stderr.log").write_text(
        completed.stderr or "", encoding="utf-8"
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise WorkflowError(
            f"{label} failed with exit code {completed.returncode}"
            + (f": {detail[-1200:]}" if detail else "")
        )
    result = parse_last_json(completed.stdout or "")
    result["_runner"] = {
        "label": label,
        "started_at": started,
        "finished_at": utc_now(),
        "exit_code": completed.returncode,
    }
    return result


def collection_input(path: Path) -> dict[str, Any]:
    value = read_json(path, "collection input")
    if value.get("schema_version") != "clue.data-collection.input.v2":
        raise WorkflowError(
            "collection input must use clue.data-collection.input.v2"
        )
    if value.get("collection_kind") != "literature":
        raise WorkflowError("Polaris literature workflow accepts collection_kind=literature")
    collection_id = safe_collection_id(value.get("collection_id"))
    value["collection_id"] = collection_id
    require_string(value.get("question"), "question")
    require_string(value.get("decision_context"), "decision_context")
    scope = value.get("scope")
    if not isinstance(scope, dict):
        raise WorkflowError("scope must be an object")
    if not isinstance(value.get("source_tasks"), list) or not value["source_tasks"]:
        raise WorkflowError("collection input source_tasks must be a non-empty array")
    # Reuse the migrated collector's full contract validator. Importing from
    # this fixed workflow keeps the top-level CLI independent of any sibling
    # application checkout.
    try:
        collector_runner = load_tool_module(
            ("data-collection", "runner.py"),
            "polaris_literature_data_collection_runner",
        )
        collector_runner.input_version(value)
    except Exception as error:  # noqa: BLE001
        raise WorkflowError(f"collection input contract validation failed: {error}") from error
    return value


def validate_collection_output(
    document: dict[str, Any],
    *,
    expected_collection_id: str,
    label: str,
    allow_pending: bool = False,
) -> dict[str, Any]:
    """Validate a collection handoff before it crosses into analysis.

    The generic collector validator checks record/evidence shape.  The
    workflow boundary additionally binds the handoff to this run's collection
    and refuses a pending or failed review result.
    """
    try:
        collector_runner = load_tool_module(
            ("data-collection", "runner.py"),
            "polaris_literature_data_collection_validator",
        )
        collector_runner.validate_v2_output(document)
    except Exception as error:  # noqa: BLE001
        raise WorkflowError(f"{label} contract validation failed: {error}") from error
    if document.get("collection_id") != expected_collection_id:
        raise WorkflowError(
            f"{label} collection_id does not match input collection_id"
        )
    if document.get("collection_kind") != "literature":
        raise WorkflowError(f"{label} must use collection_kind=literature")
    allowed_statuses = {"final"}
    if allow_pending:
        allowed_statuses.add("pending_manual_review")
    if document.get("status") not in allowed_statuses:
        raise WorkflowError(
            f"{label} must use one of {sorted(allowed_statuses)} before analysis; "
            f"got {document.get('status')!r}"
        )
    return document


def validate_analysis_output(document: dict[str, Any], *, analysis_id: str) -> dict[str, Any]:
    """Validate the public IA v2 handoff emitted by the migrated shell."""
    try:
        analysis_runner = load_tool_module(
            ("intelligence-analysis", "runner.py"),
            "polaris_literature_intelligence_analysis_runner",
        )
        analysis_runner.validate_output(document)
    except Exception as error:  # noqa: BLE001
        raise WorkflowError(f"analysis output contract validation failed: {error}") from error
    if document.get("analysis_id") != analysis_id:
        raise WorkflowError("analysis output analysis_id does not match this run")
    if document.get("analysis_kind") != "literature-review":
        raise WorkflowError("analysis output must use analysis_kind=literature-review")
    return document


def normalized_review_mode(value: Any) -> str:
    if value is None:
        return "auto-pass"
    mode = require_string(value, "review mode")
    if mode not in REVIEW_MODES:
        raise WorkflowError(
            f"review mode must be one of: {', '.join(sorted(REVIEW_MODES))}"
        )
    return mode


def normalized_method(value: Any) -> str:
    if value is None:
        return "iterate"
    method = require_string(value, "literature method")
    if method not in LITERATURE_METHODS:
        raise WorkflowError(
            f"literature method must be one of: {', '.join(sorted(LITERATURE_METHODS))}"
        )
    return method


def normalized_report_mode(value: Any) -> str:
    mode = "fixed" if value is None else require_string(value, "report mode")
    if mode not in REPORT_MODES:
        raise WorkflowError(
            f"report mode must be one of: {', '.join(sorted(REPORT_MODES))}"
        )
    return mode


def paths_for(
    workspace: Path,
    run_id: str,
    collection_id: str,
    analysis_id: str,
    report_id: str,
) -> dict[str, Path]:
    run_root = workspace / "literature-review" / run_id
    # Keep the collector's stable per-collection namespace so its expansion,
    # PDF-cache, and resume artifacts retain their original lookup semantics.
    collection_root = workspace / "data-collections" / collection_id
    analysis_root = run_root / "intelligence-analysis"
    report_root = run_root / "report-writing"
    return {
        "run_root": run_root,
        "collection_root": collection_root,
        "collection_input": collection_root / "inputs" / "input.json",
        "collection_output": collection_root / "outputs" / "output.json",
        "collection_review_list": collection_root / "outputs" / "manual-review-list.json",
        "collection_non_review": collection_root / "outputs" / "non-review-results.json",
        "collection_review_state": collection_root / "work" / "review-state.json",
        "collection_review_result": collection_root / "outputs" / "review-output.json",
        "analysis_root": analysis_root,
        "analysis_input": analysis_root / "inputs" / "input.json",
        "analysis_output": analysis_root / "outputs" / "output.json",
        "analysis_review_list": analysis_root / "outputs" / "manual-review-list.json",
        "analysis_review_state": analysis_root / "work" / "manual-review" / "review-state.json",
        "analysis_review_result": analysis_root / "work" / "manual-review" / "review-result.json",
        "report_root": report_root,
        "report_input": report_root / "inputs" / "input.json",
        "report_draft": report_root / "work" / "draft.json",
        "report_reviews": report_root / "work" / "reviews.json",
        "report_revised_draft": report_root / "work" / "draft-revised.json",
        "report_markdown": report_root / "outputs" / "report.md",
        "report_manifest": report_root / "outputs" / "report.json",
        "report_tex": report_root / "outputs" / "report.tex",
        "report_bib": report_root / "outputs" / "references.bib",
        "report_pdf": report_root / "outputs" / "report.pdf",
        "run_manifest": run_root / "run.json",
        "logs": run_root / "runs",
        "collection_id": Path(collection_id),
        "analysis_id": Path(analysis_id),
        "report_id": Path(report_id),
    }


def ensure_run_root(paths: dict[str, Path]) -> None:
    assert_run_paths_safe(paths)
    for key in ("collection_root", "analysis_root", "report_root", "logs"):
        paths[key].mkdir(parents=True, exist_ok=True)
    assert_run_paths_safe(paths)


def assert_run_paths_safe(paths: dict[str, Path]) -> None:
    workspace = paths["collection_root"].parent.parent
    for candidate in (
        workspace / "data-collections",
        workspace / "literature-review",
        paths["collection_root"],
        paths["run_root"],
        paths["analysis_root"],
        paths["report_root"],
        paths["logs"],
    ):
        if candidate.exists() and candidate.is_symlink():
            raise WorkflowError(f"workflow path must not be a symbolic link: {candidate}")


def has_finished_collection_resume(
    workspace: Path,
    collection_id: str,
    run_id: str,
) -> bool:
    """Detect the collector's completed expansion checkpoint without I/O side effects."""
    expansion_dir = (
        workspace
        / "data-collections"
        / collection_id
        / "work"
        / f"{run_id}-expand"
    )
    state_path = expansion_dir / "expand-state.json"
    output_path = expansion_dir / "expanded-collection.json"
    if not state_path.is_file() or not output_path.is_file():
        return False
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
        output = json.loads(output_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return False
    return (
        isinstance(state, dict)
        and isinstance(state.get("frontier"), list)
        and len(state["frontier"]) == 0
        and isinstance(output, dict)
        and output.get("collection_id") == collection_id
        and isinstance(output.get("records"), list)
        and len(output["records"]) > 0
    )


def build_analysis_input(
    source: dict[str, Any],
    *,
    analysis_id: str,
    collection_output: Path,
    method: str,
    review_mode: str,
    paths: dict[str, Path],
) -> dict[str, Any]:
    policy = source.get("review_policy", {})
    if not isinstance(policy, dict):
        raise WorkflowError("review_policy must be an object when provided")
    analysis: dict[str, Any] = {
        "schema_version": "clue.intelligence-analysis.input.v2",
        "analysis_id": analysis_id,
        "analysis_kind": "literature-review",
        "question": require_string(source.get("question"), "question"),
        "decision_context": require_string(
            source.get("decision_context"), "decision_context"
        ),
        "audience": require_string(source.get("audience", "research"), "audience"),
        "model": str(source.get("model") or "gpt-5.4"),
        "model_reasoning_effort": str(
            source.get("model_reasoning_effort")
            or source.get("reasoning_effort")
            or "medium"
        ),
        "literature_method": method,
        "collection_ref": {
            "collection_id": require_string(
                source.get("collection_id"), "collection_id"
            ),
            "collection_output_sha256": digest_file(collection_output),
            "collection_output_path": str(collection_output),
        },
        "review_policy": {
            "minimum_confidence": policy.get("minimum_confidence", 0.75),
            "review_all_claims": bool(policy.get("review_all_claims", False)),
            "mode": review_mode,
        },
    }
    for key in (
        "question_prompt",
        "decision_context_prompt",
        "audience_prompt",
        "minimum_distinct_sources",
        "seed_paper_ids",
        "seed_record_ids",
        "max_papers",
        "batch_size",
    ):
        if key in source:
            analysis[key] = source[key]
    # Preserve the full source scope as an auditable, tool-consumed extension.
    if isinstance(source.get("scope"), dict):
        analysis["scope"] = source["scope"]
    write_json(paths["analysis_input"], analysis)
    return analysis


def copy_file_atomically(source_path: Path, destination: Path, label: str) -> None:
    expanded_source = source_path.expanduser()
    if expanded_source.is_symlink():
        raise WorkflowError(f"{label} must not be a symbolic link: {expanded_source}")
    source_path = expanded_source.resolve()
    if not source_path.is_file():
        raise WorkflowError(f"{label} does not exist: {source_path}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.tmp-{os.getpid()}")
    try:
        shutil.copyfile(source_path, temporary)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def copy_collection_input(source_path: Path, destination: Path) -> None:
    copy_file_atomically(source_path, destination, "collection input")


def collection_review_command_args(paths: dict[str, Path], command: str) -> list[str]:
    return [
        str(tool_path("collection-review", "clue-collection-review")),
        command,
        "--manual-list",
        str(paths["collection_review_list"]),
        "--non-review",
        str(paths["collection_non_review"]),
        "--state",
        str(paths["collection_review_state"]),
        "--output",
        str(paths["collection_review_result"]),
    ]


def run_collection_review_command(
    paths: dict[str, Path],
    command: str,
    *,
    environment: dict[str, str],
    label: str,
    extra: list[str] | None = None,
) -> dict[str, Any]:
    return run_child(
        label,
        [*collection_review_command_args(paths, command), *(extra or [])],
        environment=environment,
        log_dir=paths["logs"] / label,
    )


def collection_review_manifest_refs(paths: dict[str, Path]) -> dict[str, str]:
    return {
        "manual_list": str(paths["collection_review_list"]),
        "non_review": str(paths["collection_non_review"]),
        "state": str(paths["collection_review_state"]),
        "result": str(paths["collection_review_result"]),
    }


def analysis_review_command_args(paths: dict[str, Path], command: str) -> list[str]:
    return [
        str(tool_path("analysis-review", "clue-analysis-review")),
        command,
        "--manual-list",
        str(paths["analysis_review_list"]),
        "--state",
        str(paths["analysis_review_state"]),
        "--output",
        str(paths["analysis_review_result"]),
    ]


def run_analysis_review_command(
    paths: dict[str, Path],
    command: str,
    *,
    environment: dict[str, str],
    label: str,
    extra: list[str] | None = None,
) -> dict[str, Any]:
    return run_child(
        label,
        [*analysis_review_command_args(paths, command), *(extra or [])],
        environment=environment,
        log_dir=paths["logs"] / label,
    )


def analysis_review_manifest_refs(paths: dict[str, Path]) -> dict[str, str]:
    return {
        "list": str(paths["analysis_review_list"]),
        "state": str(paths["analysis_review_state"]),
        "result": str(paths["analysis_review_result"]),
    }


def run_fixed_report(
    paths: dict[str, Path],
    *,
    environment: dict[str, str],
    template: str,
    report_id: str,
    claim_filter: str | None = None,
) -> dict[str, Any]:
    return run_child(
        "report-fixed",
        [
            str(tool_path("report-writing", "clue-report-writing")),
            "run",
            "--analysis-output",
            str(paths["analysis_output"]),
            "--template",
            template,
            "--report-id",
            report_id,
            "--report-input",
            str(paths["report_input"]),
            "--draft",
            str(paths["report_draft"]),
            "--tex",
            str(paths["report_tex"]),
            "--bib",
            str(paths["report_bib"]),
            "--output",
            str(paths["report_pdf"]),
            "--run-dir",
            str(paths["logs"] / "report"),
            *(("--claim-filter", claim_filter) if claim_filter else ()),
        ],
        environment=environment,
        log_dir=paths["logs"] / "report-fixed",
    )


def run_reviewed_report(
    paths: dict[str, Path],
    *,
    environment: dict[str, str],
    template: str,
    report_id: str,
    max_revisions: int,
    claim_filter: str | None = None,
) -> dict[str, Any]:
    run_child(
        "report-prepare",
        [
            str(tool_path("report-writing", "clue-report-writing")),
            "prepare",
            "--analysis-output",
            str(paths["analysis_output"]),
            "--template",
            template,
            "--report-id",
            report_id,
            "--output",
            str(paths["report_input"]),
            *(("--claim-filter", claim_filter) if claim_filter else ()),
        ],
        environment=environment,
        log_dir=paths["logs"] / "report-prepare",
    )
    run_child(
        "report-draft",
        [
            str(tool_path("report-writing", "clue-report-writing")),
            "draft",
            "--input",
            str(paths["report_input"]),
            "--output",
            str(paths["report_draft"]),
            "--run-dir",
            str(paths["logs"] / "report-draft"),
        ],
        environment=environment,
        log_dir=paths["logs"] / "report-draft",
    )
    current_draft = paths["report_draft"]
    review_count = 0
    revision_count = 0
    while True:
        review_count += 1
        run_child(
            f"report-review-{review_count}",
            [
                str(tool_path("report-writing", "clue-report-writing")),
                "review",
                "--input",
                str(paths["report_input"]),
                "--draft",
                str(current_draft),
                "--output",
                str(paths["report_reviews"]),
                "--run-dir",
                str(paths["logs"] / f"report-review-{review_count}"),
            ],
            environment=environment,
            log_dir=paths["logs"] / f"report-review-{review_count}",
        )
        review_doc = read_json(paths["report_reviews"], "report reviews")
        review_items = review_doc.get("reviews")
        passed = (
            isinstance(review_items, list)
            and len(review_items) == 4
            and all(
                isinstance(item, dict) and item.get("status") == "pass"
                for item in review_items
            )
        )
        if passed:
            break
        if revision_count >= max_revisions:
            raise WorkflowError(
                f"report review did not pass after {max_revisions} revisions"
            )
        revision_count += 1
        output = paths["report_revised_draft"]
        run_child(
            f"report-revise-{revision_count}",
            [
                str(tool_path("report-writing", "clue-report-writing")),
                "revise",
                "--input",
                str(paths["report_input"]),
                "--draft",
                str(current_draft),
                "--reviews",
                str(paths["report_reviews"]),
                "--output",
                str(output),
                "--run-dir",
                str(paths["logs"] / f"report-revise-{revision_count}"),
            ],
            environment=environment,
            log_dir=paths["logs"] / f"report-revise-{revision_count}",
        )
        current_draft = output
    run_child(
        "report-publish",
        [
            str(tool_path("report-writing", "clue-report-writing")),
            "publish",
            "--input",
            str(paths["report_input"]),
            "--draft",
            str(current_draft),
            "--reviews",
            str(paths["report_reviews"]),
            "--output",
            str(paths["report_markdown"]),
            "--manifest",
            str(paths["report_manifest"]),
        ],
        environment=environment,
        log_dir=paths["logs"] / "report-publish",
    )
    run_child(
        "report-latex",
        [
            str(tool_path("report-writing", "clue-report-writing")),
            "latex",
            "--input",
            str(paths["report_input"]),
            "--draft",
            str(current_draft),
            "--tex",
            str(paths["report_tex"]),
            "--bib",
            str(paths["report_bib"]),
            "--output",
            str(paths["report_pdf"]),
        ],
        environment=environment,
        log_dir=paths["logs"] / "report-latex",
    )
    return {
        "status": "succeeded",
        "draft": str(current_draft),
        "reviews": str(paths["report_reviews"]),
        "markdown": str(paths["report_markdown"]),
        "manifest": str(paths["report_manifest"]),
        "pdf": str(paths["report_pdf"]),
        "review_count": review_count,
        "revision_count": revision_count,
    }


def run_report_stage(
    manifest: dict[str, Any],
    paths: dict[str, Path],
    *,
    environment: dict[str, str],
    report_mode: str,
    template: str,
    report_id: str,
    max_revisions: int,
    claim_filter: str | None,
) -> dict[str, Any]:
    """Run the report stage and persist its durable manifest checkpoint."""
    if report_mode == "fixed":
        report_result = run_fixed_report(
            paths,
            environment=environment,
            template=template,
            report_id=report_id,
            claim_filter=claim_filter,
        )
    else:
        report_result = run_reviewed_report(
            paths,
            environment=environment,
            template=template,
            report_id=report_id,
            max_revisions=max(0, max_revisions),
            claim_filter=claim_filter,
    )
    manifest["report_mode"] = report_mode
    manifest["report_template"] = template
    manifest["stages"].append(
        {
            "stage": "report-writing",
            "status": report_result.get("status", "succeeded"),
            **{key: value for key, value in report_result.items() if key != "status"},
        }
    )
    manifest["status"] = "succeeded"
    manifest.pop("pending_stage", None)
    manifest.pop("resumable", None)
    if isinstance(manifest.get("analysis_review"), dict):
        manifest["analysis_review"]["status"] = "completed"
    manifest["finished_at"] = utc_now()
    write_json(paths["run_manifest"], manifest)
    return report_result


def run_analysis_stage(
    manifest: dict[str, Any],
    source: dict[str, Any],
    paths: dict[str, Path],
    *,
    environment: dict[str, str],
    analysis_id: str,
    method: str,
    review_mode: str,
) -> dict[str, Any] | None:
    """Run analysis after a final collection handoff.

    ``None`` means the analysis entered its own human-review wait.  The
    manifest is saved before the caller decides whether to enter reporting.
    """
    build_analysis_input(
        source,
        analysis_id=analysis_id,
        collection_output=paths["collection_output"],
        method=method,
        review_mode=review_mode,
        paths=paths,
    )
    # A collection-review continuation may be retried after analysis has
    # already committed and reporting failed. Reuse only an exact final
    # analysis checkpoint; otherwise a changed handoff must be analyzed again.
    existing_analysis = None
    if paths["analysis_output"].is_file() and not paths["analysis_output"].is_symlink():
        try:
            candidate = validate_analysis_output(
                read_json(paths["analysis_output"], "existing analysis output"),
                analysis_id=analysis_id,
            )
            provenance = candidate.get("provenance")
            if (
                candidate.get("status") == "final"
                and isinstance(provenance, dict)
                and provenance.get("analysis_input_sha256")
                == digest_json(
                    read_json(paths["analysis_input"], "existing analysis input")
                )
            ):
                existing_analysis = candidate
        except WorkflowError:
            existing_analysis = None
    if existing_analysis is not None:
        analysis_stage = {
            "stage": "analysis",
            "status": "final",
            "input": str(paths["analysis_input"]),
            "output": str(paths["analysis_output"]),
            "literature_method": method,
            "judgment_count": len(existing_analysis.get("judgments") or []),
            "resumed": True,
        }
        for index, stage in enumerate(manifest.get("stages") or []):
            if isinstance(stage, dict) and stage.get("stage") == "analysis":
                manifest["stages"][index] = analysis_stage
                break
        else:
            manifest["stages"].append(analysis_stage)
        write_json(paths["run_manifest"], manifest)
        return existing_analysis
    analysis_result = run_child(
        "analysis",
        [
            str(tool_path("intelligence-analysis", "clue-intelligence-analysis")),
            "run",
            "--input",
            str(paths["analysis_input"]),
            "--analysis-root",
            str(paths["analysis_root"]),
        ],
        environment=environment,
        log_dir=paths["logs"] / "analysis",
    )
    analysis_doc = validate_analysis_output(
        read_json(paths["analysis_output"], "analysis output"),
        analysis_id=analysis_id,
    )
    manifest["stages"].append(
        {
            "stage": "analysis",
            "status": analysis_doc.get(
                "status", analysis_result.get("status", "succeeded")
            ),
            "input": str(paths["analysis_input"]),
            "output": str(paths["analysis_output"]),
            "literature_method": method,
            "judgment_count": len(analysis_doc.get("judgments") or []),
        }
    )
    write_json(paths["run_manifest"], manifest)
    if analysis_doc.get("status") != "final":
        manifest["pending_stage"] = "analysis"
        manifest["resumable"] = True
        manifest["analysis_review"] = {
            "status": "pending",
            **analysis_review_manifest_refs(paths),
        }
        manifest["status"] = analysis_doc.get("status", "failed")
        manifest["finished_at"] = utc_now()
        write_json(paths["run_manifest"], manifest)
        return None
    return analysis_doc


def run_analysis_and_report(
    manifest: dict[str, Any],
    source: dict[str, Any],
    paths: dict[str, Path],
    *,
    environment: dict[str, str],
    analysis_id: str,
    report_id: str,
    method: str,
    review_mode: str,
    report_mode: str,
    template: str,
    max_revisions: int,
    claim_filter: str | None,
) -> dict[str, Any]:
    analysis_doc = run_analysis_stage(
        manifest,
        source,
        paths,
        environment=environment,
        analysis_id=analysis_id,
        method=method,
        review_mode=review_mode,
    )
    if analysis_doc is None:
        return manifest
    run_report_stage(
        manifest,
        paths,
        environment=environment,
        report_mode=report_mode,
        template=template,
        report_id=report_id,
        max_revisions=max_revisions,
        claim_filter=claim_filter,
    )
    return manifest


def persist_failed_manifest(args: argparse.Namespace, error: Exception) -> None:
    """Record a bounded failure when a run manifest was already created."""
    try:
        run_id = safe_run_id(args.run_id, "run-id")
        workspace_id = require_string(args.workspace, "workspace")
        if not WORKSPACE_ID.fullmatch(workspace_id):
            return
        environment = {
            key: value
            for key, value in (
                ("POLARIS_LITERATURE_WORKSPACES_ROOT", args.workspaces_root),
            )
            if value
        }
        workspace = workspace_directory(workspace_id, environment)
        manifest_path = workspace / "literature-review" / run_id / "run.json"
        if not manifest_path.is_file() or manifest_path.is_symlink():
            return
        manifest = read_json(manifest_path, "run manifest")
        if manifest.get("status") in {"succeeded", "planned", "cancelled"}:
            return
        manifest["status"] = "failed"
        manifest["finished_at"] = utc_now()
        manifest["error"] = {"message": str(error)[:2000]}
        write_json(manifest_path, manifest)
    except (AttributeError, OSError, ValueError, WorkflowError, TypeError):
        # Failure recording must never mask the original workflow error.
        return


def _run_workflow(args: argparse.Namespace) -> dict[str, Any]:
    runtime_mode = args.runtime_mode or os.environ.get("POLARIS_LITERATURE_RUNTIME_MODE") or LOCAL_MODE
    environment = {
        key: value
        for key, value in (
            ("POLARIS_LITERATURE_WORKSPACES_ROOT", args.workspaces_root),
            ("POLARIS_LITERATURE_CACHE_ROOT", args.cache_root),
            ("POLARIS_LITERATURE_RUNTIME_MODE", runtime_mode),
        )
        if value
    }
    if args.env_file:
        environment["POLARIS_LITERATURE_ENV_FILE"] = args.env_file
    if args.codex_bin:
        environment["POLARIS_LITERATURE_CODEX_BIN"] = args.codex_bin
    if args.codex_model:
        environment["POLARIS_LITERATURE_CODEX_MODEL"] = args.codex_model
    if args.reasoning_effort:
        environment["POLARIS_LITERATURE_REASONING_EFFORT"] = args.reasoning_effort
        environment["POLARIS_LITERATURE_REPORT_REASONING_EFFORT"] = args.reasoning_effort
    if args.network == "allow":
        environment["POLARIS_LITERATURE_NETWORK_ALLOWED"] = "1"
    if runtime_mode == "polaris":
        raise WorkflowError(
            "POLARIS_LITERATURE_RUNTIME_MODE=polaris requires a Polaris durable job; "
            "the local workflow CLI will not execute tools directly"
        )
    workspace = workspace_directory(args.workspace, environment)
    run_id = safe_run_id(args.run_id, "run-id")
    source_path = Path(args.input).expanduser().resolve()
    source = copy.deepcopy(collection_input(source_path))
    original_source = copy.deepcopy(source)
    if args.skip_augmentation:
        pipeline = dict(source.get("pipeline") or {})
        pipeline["skip_augmentation"] = True
        source["pipeline"] = pipeline
    if args.seed_ids:
        source["seed_paper_ids"] = [
            item.strip() for item in args.seed_ids.split(",") if item.strip()
        ]
    if args.max_papers is not None:
        source["max_papers"] = args.max_papers
    if args.batch_size is not None:
        source["batch_size"] = args.batch_size
    if args.codex_model:
        source["model"] = args.codex_model
    if args.reasoning_effort:
        source["model_reasoning_effort"] = args.reasoning_effort
    collection_id = safe_collection_id(source.get("collection_id"))
    source["collection_id"] = collection_id
    analysis_id = safe_run_id(
        args.analysis_id or f"{run_id}-analysis",
        "analysis-id",
    )
    report_id = safe_run_id(args.report_id or f"{run_id}-report", "report-id")
    paths = paths_for(workspace, run_id, collection_id, analysis_id, report_id)
    ensure_run_root(paths)
    copy_collection_input(source_path, paths["collection_input"])
    if source != original_source:
        write_json(paths["collection_input"], source)
    source_pipeline = source.get("pipeline")
    configured_review_mode = (
        source.get("review_mode")
        or source_pipeline.get("review_mode")
        if isinstance(source_pipeline, dict)
        else source.get("review_mode")
    )
    review_mode = normalized_review_mode(args.review_mode or configured_review_mode)
    method = normalized_method(args.literature_method or source.get("literature_method"))
    report_mode = normalized_report_mode(args.report_mode)
    template = args.template or str(source.get("report_template") or "auto")
    if (
        not args.collection_output
        and args.network != "allow"
        and not args.dry_run
        and not has_finished_collection_resume(workspace, collection_id, run_id)
    ):
        raise WorkflowError(
            "collection requires --network allow; use --collection-output or a "
            "completed expansion checkpoint for a network-free resume; use "
            "--dry-run to inspect the plan"
        )

    manifest: dict[str, Any] = {
        "schema_version": WORKFLOW_RUN_SCHEMA,
        "run_id": run_id,
        "workflow": "LiteratureReviewExecution",
        "definition": {
            "path": str(definition_path()),
            "digest": definition_digest(),
            "language_version": "0.4-trial",
        },
        "status": "running",
        "started_at": utc_now(),
        "workspace": args.workspace,
        "collection_id": collection_id,
        "analysis_id": analysis_id,
        "report_id": report_id,
        "review_mode": review_mode,
        "literature_method": method,
        "report_mode": report_mode,
        "report_template": template,
        "max_revisions": max(0, args.max_revisions),
        "claim_filter": args.claim_filter,
        "network": args.network,
        "skip_augmentation": bool(
            (source.get("pipeline") or {}).get("skip_augmentation", False)
        ),
        "components": component_versions(),
        "paths": {key: str(value) for key, value in paths.items() if value.suffix},
        "stages": [],
    }
    write_json(paths["run_manifest"], manifest)

    collection_output = paths["collection_output"]
    if args.dry_run:
        manifest["status"] = "planned"
        manifest["finished_at"] = utc_now()
        manifest["stages"] = [
            {
                "stage": "collection",
                "operation": "clue-data-collection run",
                "status": "planned",
            },
            {
                "stage": "analysis",
                "operation": "clue-intelligence-analysis run",
                "status": "planned",
                "literature_method": method,
            },
            {
                "stage": "report-writing",
                "operation": "clue-report-writing run" if report_mode == "fixed" else "prepare -> draft -> review -> revise -> publish -> latex",
                "status": "planned",
            },
        ]
        write_json(paths["run_manifest"], manifest)
        return manifest

    if args.collection_output:
        supplied = Path(args.collection_output).expanduser().resolve()
        copied_output = supplied
        if supplied != collection_output:
            collection_output.parent.mkdir(parents=True, exist_ok=True)
            temporary = collection_output.with_name(
                f".{collection_output.name}.tmp-{os.getpid()}"
            )
            try:
                shutil.copyfile(supplied, temporary)
                temporary.replace(collection_output)
            finally:
                temporary.unlink(missing_ok=True)
        else:
            copied_output = collection_output
        collection_doc = validate_collection_output(
            read_json(copied_output, "collection output"),
            expected_collection_id=collection_id,
            label="supplied collection output",
            allow_pending=True,
        )
        manifest["stages"].append({
            "stage": "collection",
            "status": "resumed",
            "output": str(collection_output),
            "record_count": len(collection_doc.get("records") or []),
            **(
                {"review": collection_review_manifest_refs(paths)}
                if collection_doc.get("status") == "pending_manual_review"
                else {}
            ),
        })
    else:
        collection_result = run_child(
            "collection",
            [
                str(tool_path("data-collection", "clue-data-collection")),
                "run",
                "--input",
                str(paths["collection_input"]),
                "--workspace",
                args.workspace,
                "--run-prefix",
                run_id,
                "--output",
                str(collection_output),
                "--review-mode",
                review_mode,
            ],
            environment=environment,
            log_dir=paths["logs"] / "collection",
        )
        collection_doc = validate_collection_output(
            read_json(collection_output, "collection output"),
            expected_collection_id=collection_id,
            label="generated collection output",
            allow_pending=True,
        )
        manifest["stages"].append({
            "stage": "collection",
            "status": collection_doc.get("status", collection_result.get("status", "succeeded")),
            "output": str(collection_output),
            "record_count": len(collection_doc.get("records") or []),
            "pipeline": collection_doc.get("pipeline"),
            **(
                {"review": collection_review_manifest_refs(paths)}
                if collection_doc.get("status") == "pending_manual_review"
                else {}
            ),
        })
    write_json(paths["run_manifest"], manifest)

    if collection_doc.get("status") == "pending_manual_review":
        manifest["collection_review"] = {
            "status": "pending",
            **collection_review_manifest_refs(paths),
        }
        manifest["pending_stage"] = "collection"
        manifest["resumable"] = True
        manifest["status"] = "pending_manual_review"
        manifest["finished_at"] = utc_now()
        write_json(paths["run_manifest"], manifest)
        return manifest

    run_analysis_and_report(
        manifest,
        source,
        paths,
        environment=environment,
        analysis_id=analysis_id,
        report_id=report_id,
        method=method,
        review_mode=review_mode,
        report_mode=report_mode,
        template=template,
        max_revisions=args.max_revisions,
        claim_filter=args.claim_filter,
    )
    return manifest


def run_workflow(args: argparse.Namespace) -> dict[str, Any]:
    try:
        return _run_workflow(args)
    except Exception as error:
        persist_failed_manifest(args, error)
        raise


def completion_environment(args: argparse.Namespace) -> dict[str, str]:
    runtime_mode = (
        getattr(args, "runtime_mode", None)
        or os.environ.get("POLARIS_LITERATURE_RUNTIME_MODE")
        or LOCAL_MODE
    )
    if runtime_mode == "polaris":
        raise WorkflowError(
            "POLARIS_LITERATURE_RUNTIME_MODE=polaris requires a Polaris durable job; "
            "the local workflow CLI will not complete reviews directly"
        )
    environment = {
        key: value
        for key, value in (
            ("POLARIS_LITERATURE_WORKSPACES_ROOT", getattr(args, "workspaces_root", None)),
            ("POLARIS_LITERATURE_CACHE_ROOT", getattr(args, "cache_root", None)),
            ("POLARIS_LITERATURE_RUNTIME_MODE", runtime_mode),
        )
        if value
    }
    if getattr(args, "env_file", None):
        environment["POLARIS_LITERATURE_ENV_FILE"] = args.env_file
    if getattr(args, "codex_bin", None):
        environment["POLARIS_LITERATURE_CODEX_BIN"] = args.codex_bin
    if getattr(args, "codex_model", None):
        environment["POLARIS_LITERATURE_CODEX_MODEL"] = args.codex_model
    if getattr(args, "reasoning_effort", None):
        environment["POLARIS_LITERATURE_REASONING_EFFORT"] = args.reasoning_effort
        environment["POLARIS_LITERATURE_REPORT_REASONING_EFFORT"] = args.reasoning_effort
    return environment


def completion_paths(
    manifest_path: Path,
    manifest: dict[str, Any],
    environment: dict[str, str],
) -> tuple[dict[str, Path], str, str, str, str]:
    if manifest.get("schema_version") != WORKFLOW_RUN_SCHEMA:
        raise WorkflowError("run manifest has an unsupported schema_version")
    if manifest.get("workflow") != "LiteratureReviewExecution":
        raise WorkflowError("run manifest does not belong to LiteratureReviewExecution")
    workspace_id = require_string(manifest.get("workspace"), "run manifest workspace")
    collection_id = safe_collection_id(manifest.get("collection_id"))
    run_id = safe_run_id(manifest.get("run_id"), "run manifest run_id")
    analysis_id = safe_run_id(manifest.get("analysis_id"), "run manifest analysis_id")
    report_id = safe_run_id(manifest.get("report_id"), "run manifest report_id")
    workspace = workspace_directory(workspace_id, environment)
    paths = paths_for(workspace, run_id, collection_id, analysis_id, report_id)
    assert_run_paths_safe(paths)
    if manifest_path != paths["run_manifest"].resolve():
        raise WorkflowError("run manifest path does not match its workspace/run identity")
    return paths, workspace_id, run_id, analysis_id, report_id


def manifest_path_for_completion(value: str) -> Path:
    expanded = Path(value).expanduser()
    if expanded.is_symlink():
        raise WorkflowError("run manifest must not be a symbolic link")
    return expanded.resolve()


def restore_pending_manifest(
    manifest_path: Path,
    error: Exception,
    pending_stage: str,
) -> None:
    """Keep a human gate retryable when continuation fails after a checkpoint."""
    try:
        if not manifest_path.is_file() or manifest_path.is_symlink():
            return
        manifest = read_json(manifest_path, "run manifest")
        if manifest.get("workflow") != "LiteratureReviewExecution":
            return
        if manifest.get("status") not in {"running", "pending_manual_review"}:
            return
        manifest["status"] = "pending_manual_review"
        manifest["pending_stage"] = pending_stage
        manifest["resumable"] = True
        manifest["updated_at"] = utc_now()
        manifest["error"] = {"message": str(error)[:2000]}
        write_json(manifest_path, manifest)
    except (OSError, ValueError, WorkflowError, TypeError):
        # Failure recording must never mask the original continuation error.
        return


def completion_report_options(
    args: argparse.Namespace,
    manifest: dict[str, Any],
) -> tuple[str, str, str | None, int]:
    report_mode = normalized_report_mode(
        getattr(args, "report_mode", None) or manifest.get("report_mode")
    )
    template = getattr(args, "template", None) or manifest.get("report_template") or "auto"
    if not isinstance(template, str) or not template.strip():
        raise WorkflowError("run manifest report_template must be a non-empty string")
    claim_filter = getattr(args, "claim_filter", None) or manifest.get("claim_filter")
    if claim_filter is not None and not isinstance(claim_filter, str):
        raise WorkflowError("run manifest claim_filter must be a string when set")
    max_revisions = getattr(args, "max_revisions", None)
    if max_revisions is None:
        max_revisions = manifest.get("max_revisions", 2)
    if isinstance(max_revisions, bool) or not isinstance(max_revisions, int):
        raise WorkflowError("max revisions must be an integer")
    return report_mode, template, claim_filter, max_revisions


def _complete_collection_review(args: argparse.Namespace) -> dict[str, Any]:
    environment = completion_environment(args)
    manifest_path = manifest_path_for_completion(args.run_manifest)
    manifest = read_json(manifest_path, "run manifest")
    paths, _workspace_id, _run_id, analysis_id, report_id = completion_paths(
        manifest_path,
        manifest,
        environment,
    )
    if manifest.get("status") != "pending_manual_review" or manifest.get("pending_stage") != "collection":
        raise WorkflowError(
            "complete-collection-review requires a pending collection review manifest"
        )

    manifest["status"] = "running"
    manifest["resumed_at"] = utc_now()
    manifest.pop("error", None)
    write_json(paths["run_manifest"], manifest)

    collection_doc = read_json(paths["collection_output"], "pending collection output")
    if collection_doc.get("status") == "pending_manual_review":
        run_collection_review_command(
            paths,
            "complete",
            environment=environment,
            label="collection-complete-review",
            extra=["--collection-output", str(paths["collection_output"])],
        )
        collection_doc = read_json(
            paths["collection_output"], "completed collection output"
        )
    collection_doc = validate_collection_output(
        collection_doc,
        expected_collection_id=require_string(
            manifest.get("collection_id"), "run manifest collection_id"
        ),
        label="completed collection output",
    )

    for stage in manifest.get("stages") or []:
        if isinstance(stage, dict) and stage.get("stage") == "collection":
            stage["status"] = "final"
            stage["output"] = str(paths["collection_output"])
            stage["record_count"] = len(collection_doc.get("records") or [])
            stage["pipeline"] = collection_doc.get("pipeline")
            review = stage.get("review")
            if isinstance(review, dict):
                review["status"] = "completed"
                review["result"] = str(paths["collection_review_result"])
    manifest.setdefault("stages", []).append(
        {
            "stage": "collection-review",
            "status": "completed",
            "manual_review_result": str(paths["collection_review_result"]),
            "collection_output": str(paths["collection_output"]),
        }
    )
    manifest["collection_review"] = {
        "status": "completed",
        **collection_review_manifest_refs(paths),
    }
    # Keep the collection checkpoint until analysis/report continuation has
    # also committed. If reporting fails, retrying this command is idempotent
    # because the collection output is already final.
    manifest["collection_review"]["continuation"] = "analysis-and-report"
    write_json(paths["run_manifest"], manifest)

    source = collection_input(paths["collection_input"])
    method = normalized_method(manifest.get("literature_method"))
    review_mode = normalized_review_mode(manifest.get("review_mode"))
    report_mode, template, claim_filter, max_revisions = completion_report_options(
        args, manifest
    )
    if manifest.get("network") == "allow":
        environment["POLARIS_LITERATURE_NETWORK_ALLOWED"] = "1"
    return run_analysis_and_report(
        manifest,
        source,
        paths,
        environment=environment,
        analysis_id=analysis_id,
        report_id=report_id,
        method=method,
        review_mode=review_mode,
        report_mode=report_mode,
        template=template,
        max_revisions=max_revisions,
        claim_filter=claim_filter,
    )


def _complete_analysis_review(args: argparse.Namespace) -> dict[str, Any]:
    environment = completion_environment(args)
    manifest_path = manifest_path_for_completion(args.run_manifest)
    manifest = read_json(manifest_path, "run manifest")
    paths, _workspace_id, _run_id, analysis_id, report_id = completion_paths(
        manifest_path,
        manifest,
        environment,
    )
    if (
        manifest.get("status") != "pending_manual_review"
        or manifest.get("pending_stage") != "analysis"
    ):
        raise WorkflowError(
            "complete-analysis-review requires a pending analysis review manifest"
        )
    manifest["status"] = "running"
    manifest["resumed_at"] = utc_now()
    manifest.pop("error", None)
    write_json(paths["run_manifest"], manifest)
    review_result_arg = getattr(args, "review_result", None)
    if review_result_arg:
        external_review_result = Path(review_result_arg).expanduser()
        if external_review_result.is_symlink():
            raise WorkflowError("review result must not be a symbolic link")
        external_review_result = external_review_result.resolve()
        if not external_review_result.is_file() or external_review_result.is_symlink():
            raise WorkflowError(
                f"review result is not a real file: {external_review_result}"
            )
        copy_file_atomically(
            external_review_result,
            paths["analysis_review_result"],
            "review result",
        )
    else:
        run_analysis_review_command(
            paths,
            "export",
            environment=environment,
            label="analysis-review-export",
        )
    review_result = paths["analysis_review_result"]
    analysis_doc: dict[str, Any]
    existing_analysis = None
    if paths["analysis_output"].is_file() and not paths["analysis_output"].is_symlink():
        try:
            existing_analysis = validate_analysis_output(
                read_json(paths["analysis_output"], "existing analysis output"),
                analysis_id=analysis_id,
            )
        except WorkflowError:
            existing_analysis = None
    if existing_analysis and existing_analysis.get("status") == "final":
        analysis_doc = existing_analysis
    else:
        run_child(
            "analysis-complete-review",
            [
                str(tool_path("intelligence-analysis", "clue-intelligence-analysis")),
                "complete-review",
                "--analysis-root",
                str(paths["analysis_root"]),
                "--review-result",
                str(review_result),
            ],
            environment=environment,
            log_dir=paths["logs"] / "analysis-complete-review",
        )
        analysis_doc = validate_analysis_output(
            read_json(paths["analysis_output"], "completed analysis output"),
            analysis_id=analysis_id,
        )
    if analysis_doc.get("status") != "final":
        raise WorkflowError("completed analysis review did not produce a final output")

    for stage in manifest.get("stages") or []:
        if isinstance(stage, dict) and stage.get("stage") == "analysis":
            stage["status"] = "final"
            stage["output"] = str(paths["analysis_output"])
            stage["judgment_count"] = len(analysis_doc.get("judgments") or [])
    manifest.setdefault("stages", []).append(
        {
            "stage": "analysis-review",
            "status": "completed",
            "review_result": str(review_result),
            "output": str(paths["analysis_output"]),
        }
    )
    report_mode, template, claim_filter, max_revisions = completion_report_options(
        args, manifest
    )
    if manifest.get("network") == "allow":
        environment["POLARIS_LITERATURE_NETWORK_ALLOWED"] = "1"
    run_report_stage(
        manifest,
        paths,
        environment=environment,
        report_mode=report_mode,
        template=template,
        report_id=report_id,
        max_revisions=max_revisions,
        claim_filter=claim_filter,
    )
    return manifest


def complete_analysis_review(args: argparse.Namespace) -> dict[str, Any]:
    try:
        return _complete_analysis_review(args)
    except Exception as error:
        restore_pending_manifest(
            manifest_path_for_completion(args.run_manifest),
            error,
            "analysis",
        )
        raise


def complete_collection_review(args: argparse.Namespace) -> dict[str, Any]:
    try:
        return _complete_collection_review(args)
    except Exception as error:
        restore_pending_manifest(
            manifest_path_for_completion(args.run_manifest),
            error,
            "collection",
        )
        raise


def collection_review_cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="polaris-literature-review collection-review",
        description="Inspect or update a pending Polaris collection review.",
    )
    sub = parser.add_subparsers(dest="review_command", required=True)

    def add_manifest(command: argparse.ArgumentParser) -> None:
        command.add_argument("--run-manifest", required=True)
        command.add_argument("--workspaces-root")
        command.add_argument("--cache-root")
        command.add_argument("--env-file")
        command.add_argument(
            "--runtime-mode", default=None, choices=("local", "polaris")
        )

    add_manifest(sub.add_parser("bootstrap"))
    add_manifest(sub.add_parser("export"))
    save = sub.add_parser("save")
    add_manifest(save)
    save.add_argument("--record-id", required=True)
    save.add_argument(
        "--status",
        required=True,
        choices=("pending", "approved", "rejected"),
    )
    save.add_argument("--note", required=True)
    args = parser.parse_args(argv)
    environment = completion_environment(args)
    manifest_path = manifest_path_for_completion(args.run_manifest)
    manifest = read_json(manifest_path, "run manifest")
    paths, _workspace_id, _run_id, _analysis_id, _report_id = completion_paths(
        manifest_path,
        manifest,
        environment,
    )
    if (
        manifest.get("status") != "pending_manual_review"
        or manifest.get("pending_stage") != "collection"
    ):
        raise WorkflowError(
            "collection-review requires a pending collection review manifest"
        )
    if args.review_command == "bootstrap":
        result = run_collection_review_command(
            paths,
            "bootstrap",
            environment=environment,
            label="collection-review-bootstrap",
        )
    elif args.review_command == "save":
        result = run_collection_review_command(
            paths,
            "save",
            environment=environment,
            label="collection-review-save",
            extra=[
                "--record-id",
                args.record_id,
                "--status",
                args.status,
                "--note",
                args.note,
            ],
        )
        manifest["collection_review"] = {
            "status": "pending",
            **collection_review_manifest_refs(paths),
            "last_action": "save",
            "updated_at": utc_now(),
        }
        write_json(paths["run_manifest"], manifest)
    elif args.review_command == "export":
        result = run_collection_review_command(
            paths,
            "export",
            environment=environment,
            label="collection-review-export",
        )
        manifest["collection_review"] = {
            "status": "exported",
            **collection_review_manifest_refs(paths),
            "last_action": "export",
            "updated_at": utc_now(),
            "pending_count": result.get("pending_manual_review_count"),
        }
        write_json(paths["run_manifest"], manifest)
    else:
        raise WorkflowError(f"unsupported collection review command: {args.review_command}")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def analysis_review_cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="polaris-literature-review analysis-review",
        description="Inspect or update a pending Polaris analysis review.",
    )
    sub = parser.add_subparsers(dest="review_command", required=True)

    def add_manifest(command: argparse.ArgumentParser) -> None:
        command.add_argument("--run-manifest", required=True)
        command.add_argument("--workspaces-root")
        command.add_argument("--cache-root")
        command.add_argument("--env-file")
        command.add_argument(
            "--runtime-mode", default=None, choices=("local", "polaris")
        )

    add_manifest(sub.add_parser("bootstrap"))
    add_manifest(sub.add_parser("export"))
    save = sub.add_parser("save")
    add_manifest(save)
    save.add_argument("--record-id", required=True)
    save.add_argument(
        "--status", required=True, choices=("pending", "approved", "rejected")
    )
    save.add_argument("--note", required=True)
    args = parser.parse_args(argv)
    environment = completion_environment(args)
    manifest_path = manifest_path_for_completion(args.run_manifest)
    manifest = read_json(manifest_path, "run manifest")
    paths, _workspace_id, _run_id, _analysis_id, _report_id = completion_paths(
        manifest_path,
        manifest,
        environment,
    )
    if (
        manifest.get("status") != "pending_manual_review"
        or manifest.get("pending_stage") != "analysis"
    ):
        raise WorkflowError(
            "analysis-review requires a pending analysis review manifest"
        )
    if args.review_command == "bootstrap":
        result = run_analysis_review_command(
            paths,
            "bootstrap",
            environment=environment,
            label="analysis-review-bootstrap",
        )
    elif args.review_command == "save":
        result = run_analysis_review_command(
            paths,
            "save",
            environment=environment,
            label="analysis-review-save",
            extra=[
                "--record-id",
                args.record_id,
                "--status",
                args.status,
                "--note",
                args.note,
            ],
        )
        manifest["analysis_review"] = {
            "status": "pending",
            **analysis_review_manifest_refs(paths),
            "last_action": "save",
            "updated_at": utc_now(),
        }
        write_json(paths["run_manifest"], manifest)
    elif args.review_command == "export":
        result = run_analysis_review_command(
            paths,
            "export",
            environment=environment,
            label="analysis-review-export",
        )
        manifest["analysis_review"] = {
            "status": "exported",
            **analysis_review_manifest_refs(paths),
            "last_action": "export",
            "updated_at": utc_now(),
            "pending_count": result.get("pending_count"),
        }
        write_json(paths["run_manifest"], manifest)
    else:
        raise WorkflowError(f"unsupported analysis review command: {args.review_command}")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def version_payload() -> dict[str, Any]:
    return {
        "workflow_definition": json.loads((WORKFLOW_ROOT / "workflow.json").read_text(encoding="utf-8")),
        "components": component_versions(),
        "workflow": "LiteratureReviewExecution",
        "definition": {
            "path": str(definition_path()),
            "digest": definition_digest(),
            "language_version": "0.4-trial",
        },
    }


def tools_payload() -> dict[str, Any]:
    inventory = read_json(TOOLS_ROOT / "tool-inventory.json", "tool inventory")
    for item in inventory.get("tools", []):
        if isinstance(item, dict) and isinstance(item.get("entrypoint"), str):
            version_parts = Path(item["version_file"]).parts
            if version_parts and version_parts[0] == "tools":
                version_parts = version_parts[1:]
            item["version"] = tool_path(*version_parts).read_text(
                encoding="utf-8"
            ).strip()
    return inventory


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="polaris-literature-review",
        description="Run the Polaris-owned migrated literature-review workflow.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("version", help="Print workflow and component versions.")
    sub.add_parser("tools", help="List Polaris common tool entrypoints.")

    validate = sub.add_parser("validate", help="Validate a literature collection input.")
    validate.add_argument("--input", required=True)

    status = sub.add_parser("status", help="Read a durable local run manifest.")
    status.add_argument("--run-manifest", required=True)

    collection_complete = sub.add_parser(
        "complete-collection-review",
        help="Complete a pending collection review and continue the workflow.",
    )
    collection_complete.add_argument("--run-manifest", required=True)
    collection_complete.add_argument("--workspaces-root")
    collection_complete.add_argument("--cache-root")
    collection_complete.add_argument("--env-file")
    collection_complete.add_argument(
        "--runtime-mode", default=None, choices=("local", "polaris")
    )

    complete = sub.add_parser(
        "complete-analysis-review",
        help="Complete a pending analysis review and continue report production.",
    )
    complete.add_argument("--run-manifest", required=True)
    complete.add_argument(
        "--review-result",
        help="Optional external result; otherwise use the Polaris analysis-review export.",
    )
    complete.add_argument("--workspaces-root")
    complete.add_argument("--cache-root")
    complete.add_argument("--env-file")
    complete.add_argument("--runtime-mode", default=None, choices=("local", "polaris"))
    complete.add_argument("--report-mode", choices=sorted(REPORT_MODES))
    complete.add_argument("--template")
    complete.add_argument("--claim-filter")
    complete.add_argument("--max-revisions", type=int)
    complete.add_argument("--codex-bin")
    complete.add_argument("--codex-model")
    complete.add_argument("--reasoning-effort")

    run = sub.add_parser("run", help="Run collection, analysis, and report stages.")
    run.add_argument("--input", required=True, help="clue.data-collection.input.v2 JSON")
    run.add_argument("--workspace", required=True)
    run.add_argument("--run-id", required=True)
    run.add_argument("--analysis-id")
    run.add_argument("--report-id")
    run.add_argument("--workspaces-root")
    run.add_argument("--cache-root")
    run.add_argument("--env-file")
    run.add_argument("--runtime-mode", default=None, choices=("local", "polaris"))
    run.add_argument("--network", default="deny", choices=("deny", "allow"))
    run.add_argument("--dry-run", action="store_true", help="Validate and emit the stage plan without executing tools.")
    run.add_argument("--review-mode", choices=sorted(REVIEW_MODES))
    run.add_argument("--literature-method", choices=sorted(LITERATURE_METHODS))
    run.add_argument("--report-mode", choices=sorted(REPORT_MODES), default="fixed")
    run.add_argument("--template", default="auto")
    run.add_argument("--collection-output", help="Resume from a validated collection output.")
    run.add_argument("--skip-augmentation", action="store_true")
    run.add_argument("--seed-ids", help="Comma-separated seed paper ids.")
    run.add_argument("--max-papers", type=int)
    run.add_argument("--batch-size", type=int)
    run.add_argument("--claim-filter", help="Optional claim-filter JSON path.")
    run.add_argument("--max-revisions", type=int, default=2)
    run.add_argument("--codex-bin")
    run.add_argument("--codex-model")
    run.add_argument("--reasoning-effort")
    return parser


def main(argv: list[str]) -> int:
    if argv and argv[0] == "collection-review":
        try:
            return collection_review_cli(argv[1:])
        except (WorkflowError, OSError, ValueError) as error:
            print(f"error: {error}", file=sys.stderr)
            return 2
    if argv and argv[0] == "analysis-review":
        try:
            return analysis_review_cli(argv[1:])
        except (WorkflowError, OSError, ValueError) as error:
            print(f"error: {error}", file=sys.stderr)
            return 2
    args = build_parser().parse_args(argv)
    try:
        if args.command == "version":
            print(json.dumps(version_payload(), ensure_ascii=False, indent=2))
            return 0
        if args.command == "tools":
            print(json.dumps(tools_payload(), ensure_ascii=False, indent=2))
            return 0
        if args.command == "validate":
            value = collection_input(Path(args.input))
            print(json.dumps({
                "status": "valid",
                "schema": value["schema_version"],
                "collection_id": value["collection_id"],
                "source_task_count": len(value["source_tasks"]),
            }, ensure_ascii=False, indent=2))
            return 0
        if args.command == "status":
            print(json.dumps(read_json(Path(args.run_manifest), "run manifest"), ensure_ascii=False, indent=2))
            return 0
        if args.command == "complete-collection-review":
            print(json.dumps(complete_collection_review(args), ensure_ascii=False, indent=2))
            return 0
        if args.command == "complete-analysis-review":
            print(json.dumps(complete_analysis_review(args), ensure_ascii=False, indent=2))
            return 0
        if args.command == "run":
            print(json.dumps(run_workflow(args), ensure_ascii=False, indent=2))
            return 0
        raise WorkflowError(f"unsupported command: {args.command}")
    except (WorkflowError, OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
