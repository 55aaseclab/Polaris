#!/usr/bin/env python3
"""Structured local-Codex intelligence analysis with review-gated output."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


TOOL_NAME = "literature-review"
TASK_SCHEMA = "clue.intelligence.analysis-task.v2"
SNAPSHOT_SCHEMA = "clue.intelligence.collection-snapshot.v2"
INPUT_SCHEMA = "clue.intelligence.analysis-input.v2"
CANDIDATES_SCHEMA = "clue.intelligence.analysis-candidates.v2"
VALIDATED_SCHEMA = "clue.intelligence.analysis-validated.v2"
OUTPUT_SCHEMA = "clue.intelligence.analysis-output.v2"
MANUAL_REVIEW_SCHEMA = "clue.manual-review.v2"
MANUAL_REVIEW_RESULT_SCHEMA = "clue.manual-review.result.v2"
REVIEW_MODES = {"auto-pass", "auto-approve", "manual-review"}
PROMPT_METHODS = {"generate-text", "generate-file", "derive", "copy-file"}
PROMPT_OUTPUT_KINDS = {"text", "markdown", "json", "string_array"}
LOCAL_EXECUTOR = "local-codex"

CLASSIFICATIONS = {"identical", "contradictory", "new", "uncertain"}
CLAIM_STATUSES = {
    "supported",
    "contradicted",
    "inconclusive",
    "insufficient_evidence",
}
RISK_LEVELS = {"low", "medium", "high"}
EVIDENCE_RELATIONS = {"supports", "contradicts", "context"}


class CliError(Exception):
    """A safe, user-facing command or input error."""


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_version(root: Path) -> str:
    return (root / "VERSION").read_text(encoding="utf-8").strip()


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def object_digest(value: Any) -> str:
    return f"sha256:{hashlib.sha256(canonical_json(value)).hexdigest()}"


def read_json(path: Path, label: str) -> dict[str, Any]:
    path = path.expanduser().resolve()
    if not path.is_file():
        raise CliError(f"{label} does not exist: {path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CliError(f"{label} is not valid UTF-8 JSON: {path}") from error
    if not isinstance(payload, dict):
        raise CliError(f"{label} must be a JSON object: {path}")
    return payload


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def write_text(path: Path, text: str) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        temporary.write_text(text, encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def require_string(document: dict[str, Any], key: str, label: str) -> str:
    value = document.get(key)
    if not isinstance(value, str) or not value.strip():
        raise CliError(f"{label} must contain a non-empty '{key}' string")
    return value


def require_list(document: dict[str, Any], key: str, label: str) -> list[Any]:
    value = document.get(key)
    if not isinstance(value, list):
        raise CliError(f"{label} must contain a '{key}' array")
    return value


def require_object(document: dict[str, Any], key: str, label: str) -> dict[str, Any]:
    value = document.get(key)
    if not isinstance(value, dict):
        raise CliError(f"{label} must contain a '{key}' object")
    return value


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


def validate_task(task: dict[str, Any]) -> dict[str, Any]:
    label = "analysis task"
    if task.get("schema_version") != TASK_SCHEMA:
        raise CliError(f"{label} must use schema_version {TASK_SCHEMA}")
    for field in ("case_id", "question", "decision_context", "audience", "collection_snapshot_id"):
        require_string(task, field, label)
    for field in ("question_prompt", "decision_context_prompt", "audience_prompt"):
        if field in task and task[field] is not None:
            validate_prompt_spec(task[field], f"{label}.{field}")
    policy = task.get("review_policy", {})
    if not isinstance(policy, dict):
        raise CliError("analysis task review_policy must be an object")
    allowed_policy_fields = {"minimum_confidence", "review_all_claims", "mode"}
    unknown_policy_fields = sorted(set(policy) - allowed_policy_fields)
    if unknown_policy_fields:
        raise CliError(
            "analysis task review_policy has unsupported field(s): "
            + ", ".join(unknown_policy_fields)
        )
    confidence = policy.get("minimum_confidence", 0.75)
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        raise CliError("analysis task review_policy.minimum_confidence must be between 0 and 1")
    review_all = policy.get("review_all_claims", False)
    if not isinstance(review_all, bool):
        raise CliError("analysis task review_policy.review_all_claims must be a boolean")
    mode = policy.get("mode", "auto-pass")
    if mode not in REVIEW_MODES:
        choices = ", ".join(sorted(REVIEW_MODES))
        raise CliError(f"analysis task review_policy.mode must be one of: {choices}")
    coverage_mode = task.get("coverage_mode", "selected_evidence")
    if coverage_mode not in {"selected_evidence", "all_observations"}:
        raise CliError("analysis task coverage_mode must be selected_evidence or all_observations")
    normalized = deepcopy(task)
    normalized["review_policy"] = {
        "minimum_confidence": float(confidence),
        "review_all_claims": review_all,
        "mode": mode,
    }
    normalized["coverage_mode"] = coverage_mode
    # Optional. When omitted, no multi-source floor is required (analyze whatever
    # evidence the model cites from the supplied corpus).
    if "minimum_distinct_sources" in task and task["minimum_distinct_sources"] is not None:
        minimum_sources = task["minimum_distinct_sources"]
        if isinstance(minimum_sources, bool) or not isinstance(minimum_sources, int) or minimum_sources < 1:
            raise CliError("analysis task minimum_distinct_sources must be a positive integer when set")
        normalized["minimum_distinct_sources"] = minimum_sources
    else:
        normalized.pop("minimum_distinct_sources", None)
    return normalized


def validate_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    label = "collection snapshot"
    if snapshot.get("schema_version") != SNAPSHOT_SCHEMA:
        raise CliError(f"{label} must use schema_version {SNAPSHOT_SCHEMA}")
    for field in ("snapshot_id", "created_at"):
        require_string(snapshot, field, label)
    clues = require_list(snapshot, "clues", label)
    clue_ids: set[str] = set()
    observation_ids: set[tuple[str, str]] = set()
    for index, clue in enumerate(clues, start=1):
        if not isinstance(clue, dict):
            raise CliError(f"collection snapshot clues[{index}] must be an object")
        clue_label = f"collection snapshot clues[{index}]"
        clue_id = require_string(clue, "clue_id", clue_label)
        if clue_id in clue_ids:
            raise CliError(f"collection snapshot has duplicate clue_id: {clue_id}")
        clue_ids.add(clue_id)
        for field in ("source_url", "observed_at", "content_hash"):
            require_string(clue, field, clue_label)
        observations = require_list(clue, "observations", clue_label)
        if not observations:
            raise CliError(f"{clue_label} must contain at least one observation")
        for observation_index, observation in enumerate(observations, start=1):
            if not isinstance(observation, dict):
                raise CliError(f"{clue_label} observations[{observation_index}] must be an object")
            observation_label = f"{clue_label} observations[{observation_index}]"
            observation_id = require_string(observation, "observation_id", observation_label)
            if (clue_id, observation_id) in observation_ids:
                raise CliError(f"collection snapshot has duplicate observation ID: {clue_id}/{observation_id}")
            observation_ids.add((clue_id, observation_id))
            require_string(observation, "quote", observation_label)
    return deepcopy(snapshot)


def validate_analysis_input(document: dict[str, Any]) -> dict[str, Any]:
    if document.get("schema_version") != INPUT_SCHEMA:
        raise CliError(f"analysis input must use schema_version {INPUT_SCHEMA}")
    task = validate_task(require_object(document, "task", "analysis input"))
    snapshot = validate_snapshot(require_object(document, "snapshot", "analysis input"))
    if task["collection_snapshot_id"] != snapshot["snapshot_id"]:
        raise CliError("analysis input task.collection_snapshot_id does not match snapshot.snapshot_id")
    expected_id = analysis_input_id(task, snapshot)
    if document.get("input_id") != expected_id:
        raise CliError("analysis input input_id does not match its task and snapshot")
    if document.get("input_sha256") != analysis_input_digest(task, snapshot):
        raise CliError("analysis input input_sha256 does not match its task and snapshot")
    return {"task": task, "snapshot": snapshot}


def analysis_input_digest(task: dict[str, Any], snapshot: dict[str, Any]) -> str:
    return object_digest({"task": task, "snapshot": snapshot})


def analysis_input_id(task: dict[str, Any], snapshot: dict[str, Any]) -> str:
    return f"analysis-input:{task['case_id']}:{analysis_input_digest(task, snapshot).split(':', 1)[1][:16]}"


def build_analysis_input(task: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any]:
    task = validate_task(task)
    snapshot = validate_snapshot(snapshot)
    if task["collection_snapshot_id"] != snapshot["snapshot_id"]:
        raise CliError("task.collection_snapshot_id must match snapshot.snapshot_id")
    input_digest = analysis_input_digest(task, snapshot)
    return {
        "schema_version": INPUT_SCHEMA,
        "input_id": analysis_input_id(task, snapshot),
        "input_sha256": input_digest,
        "prepared_at": utc_now(),
        "task": task,
        "snapshot": snapshot,
    }


def evidence_index(snapshot: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    index: dict[tuple[str, str], dict[str, Any]] = {}
    for clue in snapshot["clues"]:
        for observation in clue["observations"]:
            index[(clue["clue_id"], observation["observation_id"])] = {
                "source_url": clue["source_url"],
                "observed_at": clue["observed_at"],
                "content_hash": clue["content_hash"],
            "quote": observation["quote"],
            "locator": observation.get("locator"),
            "source_metadata": clue.get("source_metadata", {}),
            }
    return index


def evidence_index_with_fulltext(
    snapshot: dict[str, Any],
) -> dict[tuple[str, str], dict[str, Any]]:
    """Snapshot observations plus optional PDF fulltext chunks from iterate.

    Iterate attaches ``{paper_id}:pdf-chunk-NN`` observations when a local PDF
    exists. Candidate export may cite those IDs; validate must rebuild the same
    index so post-iterate validation does not reject legitimate fulltext binds.
    """
    sources = evidence_index(snapshot)
    try:
        import iterate as iterate_mod
    except ImportError:
        return sources
    for clue in snapshot.get("clues") or []:
        if not isinstance(clue, dict):
            continue
        paper_id = str(clue.get("clue_id") or "").strip()
        if not paper_id:
            continue
        try:
            iterate_mod.attach_fulltext_observations(paper_id, clue, sources=sources)
        except Exception:
            # PDF extract failures must not block abstract-only validation.
            continue
    return sources


def resolve_candidate_evidence(
    *,
    clue_id: str,
    observation_id: str,
    quote: str,
    sources: dict[tuple[str, str], dict[str, Any]],
) -> tuple[str, str, str] | None:
    """Resolve (clue_id, observation_id, exact_quote) against the evidence index.

    Accepts exact id+quote, then flexible quote recovery (same rules as iterate
    fulltext binding) so truncated model quotes and mis-copied observation ids
    still bind when unique within the paper.
    """
    source = sources.get((clue_id, observation_id))
    if source is not None and quote == source["quote"]:
        return clue_id, observation_id, source["quote"]
    try:
        import iterate as iterate_mod
    except ImportError:
        if source is not None:
            # whitespace-only drift without iterate helpers
            if " ".join(quote.split()) == " ".join(str(source["quote"]).split()):
                return clue_id, observation_id, source["quote"]
        return None
    resolved = iterate_mod._resolve_observation(
        paper_id=clue_id,
        observation_id=observation_id,
        quote=quote,
        sources=sources,
    )
    if resolved is not None:
        obs_id, exact_quote, _ = resolved
        return clue_id, obs_id, exact_quote
    # Last resort: unique observation_id across the index (wrong clue_id copy).
    hits = [
        (cid, oid, src["quote"])
        for (cid, oid), src in sources.items()
        if oid == observation_id
    ]
    if len(hits) == 1:
        cid, oid, exact = hits[0]
        if quote == exact or " ".join(quote.split()) == " ".join(str(exact).split()):
            return cid, oid, exact
        # still allow unique id when quote is a substring of the observation
        nq = " ".join(quote.split())
        ns = " ".join(str(exact).split())
        if nq and (nq in ns or ns in nq):
            return cid, oid, exact
    return None


def candidate_prompt(root: Path) -> str:
    path = root / "prompts" / "candidate-claims.v1.md"
    if not path.is_file():
        raise CliError(f"candidate prompt is missing: {path}")
    return path.read_text(encoding="utf-8")


def model_request(system_prompt: str, analysis_input: dict[str, Any]) -> dict[str, Any]:
    user_payload = {
        "instruction": "Analyze only this immutable analysis input and return the required candidate JSON object.",
        "analysis_input": analysis_input,
    }
    request: dict[str, Any] = {
        "executor": LOCAL_EXECUTOR,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False, indent=2)},
        ],
    }
    return request


def request_completion(
    payload: dict[str, Any], session_path: Path, analysis_input_path: Path
) -> dict[str, Any]:
    """Use one persistent local Codex thread for structured model responses."""
    system_prompt = payload["messages"][0]["content"]
    analysis_input = read_json(analysis_input_path, "analysis input attachment")
    validate_analysis_input(analysis_input)
    prompt = (
        f"{system_prompt}\n\n"
        "The immutable analysis-input JSON is attached as a local file at "
        f"{analysis_input_path.resolve()}. You MUST use a read-only file or shell command to "
        "open that attachment. Do not browse or access any other source. Return exactly the "
        "required candidate JSON object, with no Markdown fences or prose."
    )
    session_id = None
    if session_path.is_file():
        session_id = read_json(session_path, "Codex session").get("session_id")
    with tempfile.NamedTemporaryFile(prefix="codex-response-", suffix=".json", delete=False) as handle:
        response_path = Path(handle.name)
    codex_bin = (
        os.environ.get("POLARIS_LITERATURE_CODEX_BIN")
        or os.environ.get("CODEX_BIN")
        or "codex"
    ).strip()
    command = [codex_bin, "exec"]
    if isinstance(session_id, str) and session_id:
        command.extend(["resume", session_id])
    else:
        command.extend(
            ["--skip-git-repo-check", "--sandbox", "read-only", "--add-dir", str(analysis_input_path.parent)]
        )
    command.extend(["--json", "--output-last-message", str(response_path), "-"])
    completed = subprocess.run(command, input=prompt, text=True, capture_output=True, check=False)
    if completed.returncode != 0 or not response_path.is_file():
        raise CliError("local Codex request failed")
    for line in completed.stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "thread.started" and isinstance(event.get("thread_id"), str):
            session_id = event["thread_id"]
    if not isinstance(session_id, str) or not session_id:
        raise CliError("local Codex response did not provide a session ID")
    session_path.parent.mkdir(parents=True, exist_ok=True)
    write_json(session_path, {"session_id": session_id})
    content = response_path.read_text(encoding="utf-8")
    response_path.unlink(missing_ok=True)
    return {"choices": [{"message": {"content": content}}]}


def extract_model_json(response: dict[str, Any]) -> dict[str, Any]:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise CliError("local Codex response has no choices[0]")
    message = choices[0].get("message")
    if not isinstance(message, dict) or not isinstance(message.get("content"), str):
        raise CliError("local Codex response choices[0].message.content must be a string")
    content = message["content"].strip()
    if content.startswith("```json") and content.endswith("```"):
        content = content[len("```json") : -3].strip()
    elif content.startswith("```") and content.endswith("```"):
        content = content[3:-3].strip()
    try:
        payload = json.loads(content)
    except json.JSONDecodeError as error:
        raise CliError("local Codex message content is not a JSON object") from error
    if not isinstance(payload, dict):
        raise CliError("local Codex message content must be a JSON object")
    return payload


def require_string_list(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
        raise CliError(f"{label} must be an array of non-empty strings")
    return list(value)


def validate_framework(framework: dict[str, Any], claim_ids: set[str], label: str) -> dict[str, Any]:
    """Validate an ordered, evidence-bound progression of claim viewpoints."""
    require_string(framework, "title", label)
    stages = require_list(framework, "stages", label)
    if claim_ids and len(stages) < min(2, len(claim_ids)):
        raise CliError(f"{label} must contain an ordered progression of claim viewpoints")
    if not claim_ids and stages:
        raise CliError(f"{label} cannot contain stages when there are no claims")
    stage_ids: set[str] = set()
    covered_claim_ids: set[str] = set()
    normalized_stages: list[dict[str, Any]] = []
    for expected_sequence, stage in enumerate(stages, start=1):
        if not isinstance(stage, dict):
            raise CliError(f"{label} stages[{expected_sequence}] must be an object")
        stage_label = f"{label} stages[{expected_sequence}]"
        stage_id = require_string(stage, "stage_id", stage_label)
        if stage_id in stage_ids:
            raise CliError(f"{label} has duplicate stage_id: {stage_id}")
        stage_ids.add(stage_id)
        if stage.get("sequence") != expected_sequence:
            raise CliError(f"{stage_label} sequence must be {expected_sequence}")
        for field in ("title", "explanation"):
            require_string(stage, field, stage_label)
        transition = stage.get("transition")
        if not isinstance(transition, str) or not transition.strip():
            transition = "No transition beyond the supplied evidence is supported."
        stage_claim_ids = require_string_list(stage.get("claim_ids"), f"{stage_label} claim_ids")
        if not stage_claim_ids:
            raise CliError(f"{stage_label} must bind at least one claim_id")
        unknown = set(stage_claim_ids) - claim_ids
        if unknown:
            raise CliError(f"{stage_label} references unknown claim IDs: {', '.join(sorted(unknown))}")
        covered_claim_ids.update(stage_claim_ids)
        normalized_stages.append(
            {
                "stage_id": stage_id,
                "sequence": expected_sequence,
                "title": stage["title"],
                "explanation": stage["explanation"],
                "transition": transition,
                "claim_ids": stage_claim_ids,
            }
        )
    if covered_claim_ids != claim_ids:
        missing = claim_ids - covered_claim_ids
        raise CliError(f"{label} must cover every claim_id; missing: {', '.join(sorted(missing))}")
    return {"title": framework["title"], "stages": normalized_stages}


def validate_observation_coverage(
    claims: list[dict[str, Any]],
    snapshot: dict[str, Any],
    coverage_mode: str,
    label: str,
) -> None:
    """Require full observation coverage once for a complete claim set."""
    if coverage_mode != "all_observations":
        return
    used_observations = {
        (evidence["clue_id"], evidence["observation_id"])
        for claim in claims
        for evidence in claim["evidence"]
    }
    missing = set(evidence_index(snapshot)) - used_observations
    if missing:
        formatted = ", ".join(
            f"{clue_id}/{observation_id}"
            for clue_id, observation_id in sorted(missing)
        )
        raise CliError(f"{label} must cover every observation; missing: {formatted}")


def validate_candidate_response(
    response: dict[str, Any],
    analysis_input: dict[str, Any],
    *,
    enforce_coverage: bool = True,
    enforce_minimum_sources: bool = True,
    sources: dict[tuple[str, str], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    normalized_input = validate_analysis_input(analysis_input)
    task = normalized_input["task"]
    snapshot = normalized_input["snapshot"]
    if response.get("schema_version") != CANDIDATES_SCHEMA:
        raise CliError(f"local Codex output must use schema_version {CANDIDATES_SCHEMA}")
    if response.get("case_id") != task["case_id"]:
        raise CliError("local Codex output case_id does not match analysis input")
    if response.get("snapshot_id") != snapshot["snapshot_id"]:
        raise CliError("local Codex output snapshot_id does not match analysis input")
    claims = require_list(response, "claims", "local Codex output")
    unresolved = require_string_list(response.get("unresolved"), "local Codex output unresolved")
    # Default: include PDF fulltext chunks for first-time model candidate binding.
    # Callers that already bound claims (validate_validated / auto-pass) should pass
    # a precomputed claim-bound index to avoid re-running pdftotext per claim.
    if sources is None:
        sources = evidence_index_with_fulltext(snapshot)
    claim_ids: set[str] = set()
    normalized_claims: list[dict[str, Any]] = []
    for index, claim in enumerate(claims, start=1):
        if not isinstance(claim, dict):
            raise CliError(f"local Codex output claims[{index}] must be an object")
        label = f"local Codex output claims[{index}]"
        claim_id = require_string(claim, "claim_id", label)
        if claim_id in claim_ids:
            raise CliError(f"local Codex output has duplicate claim_id: {claim_id}")
        claim_ids.add(claim_id)
        for field in ("title", "statement"):
            require_string(claim, field, label)
        if claim.get("classification") not in CLASSIFICATIONS:
            raise CliError(f"{label} classification must be one of: {', '.join(sorted(CLASSIFICATIONS))}")
        if claim.get("status") not in CLAIM_STATUSES:
            raise CliError(f"{label} status must be one of: {', '.join(sorted(CLAIM_STATUSES))}")
        if claim.get("risk_level") not in RISK_LEVELS:
            raise CliError(f"{label} risk_level must be one of: {', '.join(sorted(RISK_LEVELS))}")
        confidence = claim.get("confidence")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
            raise CliError(f"{label} confidence must be a number between 0 and 1")
        evidence_items = require_list(claim, "evidence", label)
        if not evidence_items:
            raise CliError(f"{label} must include at least one evidence item")
        repaired_evidence: list[dict[str, Any]] = []
        for evidence_index_value, evidence_item in enumerate(evidence_items, start=1):
            if not isinstance(evidence_item, dict):
                raise CliError(f"{label} evidence[{evidence_index_value}] must be an object")
            evidence_label = f"{label} evidence[{evidence_index_value}]"
            clue_id = require_string(evidence_item, "clue_id", evidence_label)
            observation_id = require_string(evidence_item, "observation_id", evidence_label)
            quote = require_string(evidence_item, "quote", evidence_label)
            if evidence_item.get("relation") not in EVIDENCE_RELATIONS:
                raise CliError(f"{evidence_label} relation must be one of: {', '.join(sorted(EVIDENCE_RELATIONS))}")
            known_source = sources.get((clue_id, observation_id))
            resolved = resolve_candidate_evidence(
                clue_id=clue_id,
                observation_id=observation_id,
                quote=quote,
                sources=sources,
            )
            if resolved is None:
                # Preserve distinct diagnostics: id known but quote wrong vs id unknown.
                if known_source is not None:
                    raise CliError(
                        f"{evidence_label} quote must exactly match the referenced observation"
                    )
                raise CliError(f"{evidence_label} references an unknown clue or observation")
            bound_clue, bound_obs, exact_quote = resolved
            repaired = deepcopy(evidence_item)
            repaired["clue_id"] = bound_clue
            repaired["observation_id"] = bound_obs
            repaired["quote"] = exact_quote
            repaired_evidence.append(repaired)
        repaired_claim = deepcopy(claim)
        repaired_claim["evidence"] = repaired_evidence
        require_string_list(repaired_claim.get("questions"), f"{label} questions")
        require_string_list(repaired_claim.get("limitations"), f"{label} limitations")
        normalized_claims.append(repaired_claim)
    if enforce_minimum_sources and isinstance(task.get("minimum_distinct_sources"), int):
        distinct_sources = {
            sources[(evidence_item["clue_id"], evidence_item["observation_id"])]["source_url"]
            for claim in normalized_claims
            for evidence_item in claim["evidence"]
        }
        required_sources = min(task["minimum_distinct_sources"], len(snapshot["clues"]))
        if required_sources >= 1 and len(distinct_sources) < required_sources:
            raise CliError(
                f"local Codex output must use evidence from at least {required_sources} distinct sources; "
                f"it uses {len(distinct_sources)}"
            )
    framework = validate_framework(
        require_object(response, "framework", "local Codex output"),
        claim_ids,
        "local Codex output framework",
    )
    if enforce_coverage:
        validate_observation_coverage(
            normalized_claims,
            snapshot,
            task["coverage_mode"],
            "local Codex output",
        )
    return {
        "schema_version": CANDIDATES_SCHEMA,
        "case_id": task["case_id"],
        "snapshot_id": snapshot["snapshot_id"],
        "claims": normalized_claims,
        "unresolved": unresolved,
        "framework": framework,
    }


def review_requirement(claim: dict[str, Any], policy: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    if policy["review_all_claims"]:
        reasons.append("task_policy")
    if claim["risk_level"] == "high":
        reasons.append("high_risk")
    if claim["classification"] in {"contradictory", "uncertain"}:
        reasons.append("conflict_or_uncertainty")
    if claim["status"] != "supported":
        reasons.append("not_directly_supported")
    if claim["confidence"] < policy["minimum_confidence"]:
        reasons.append("below_confidence_threshold")
    return reasons


def claim_revision_hash(claim: dict[str, Any]) -> str:
    """Hash a locally valid claim before its review decision is attached."""
    return object_digest(claim)


def validate_candidates(candidates: dict[str, Any], analysis_input: dict[str, Any]) -> dict[str, Any]:
    normalized_input = validate_analysis_input(analysis_input)
    sources = evidence_index_with_fulltext(normalized_input["snapshot"])
    candidate_shape = {
        "schema_version": candidates.get("schema_version"),
        "case_id": candidates.get("case_id"),
        "snapshot_id": candidates.get("snapshot_id"),
        "claims": candidates.get("claims"),
        "unresolved": candidates.get("unresolved"),
        "framework": candidates.get("framework"),
    }
    normalized_candidates = validate_candidate_response(
        candidate_shape,
        analysis_input,
        sources=sources,
    )
    policy = normalized_input["task"]["review_policy"]
    claims: list[dict[str, Any]] = []
    for claim in normalized_candidates["claims"]:
        reviewed = deepcopy(claim)
        reasons = review_requirement(reviewed, policy)
        reviewed["validation"] = {"status": "valid", "errors": []}
        reviewed["review"] = {
            "required": bool(reasons),
            "reasons": reasons,
            "review_key": f"claim:{normalized_candidates['case_id']}:{reviewed['claim_id']}",
            "revision_hash": claim_revision_hash(reviewed),
        }
        claims.append(reviewed)
    return {
        "schema_version": VALIDATED_SCHEMA,
        "case_id": normalized_candidates["case_id"],
        "snapshot_id": normalized_candidates["snapshot_id"],
        "analysis_input_sha256": object_digest(analysis_input),
        "collection_snapshot_sha256": object_digest(normalized_input["snapshot"]),
        "task": normalized_input["task"],
        "generated_at": utc_now(),
        "claims": claims,
        # Persist only evidence that was resolved against the frozen snapshot or
        # local PDF fulltext during this validation pass. Later commands can use
        # this trusted ledger without creating sources from claim-supplied text.
        "evidence_bindings": validated_evidence_bindings(
            normalized_candidates["claims"],
            sources,
        ),
        "unresolved": normalized_candidates["unresolved"],
        "framework": normalized_candidates["framework"],
        "summary": {
            "claim_total": len(claims),
            "manual_review_required": sum(1 for claim in claims if claim["review"]["required"]),
            "automatic_claims": sum(1 for claim in claims if not claim["review"]["required"]),
        },
    }


def validated_evidence_bindings(
    claims: list[dict[str, Any]],
    sources: dict[tuple[str, str], dict[str, Any]],
) -> list[dict[str, Any]]:
    """Record evidence resolved during validation for lightweight later stages."""
    bindings: dict[tuple[str, str], dict[str, Any]] = {}
    for claim in claims:
        for evidence in claim["evidence"]:
            key = (evidence["clue_id"], evidence["observation_id"])
            source = sources.get(key)
            if source is None:
                raise CliError(
                    "validated evidence binding is missing its trusted source: "
                    f"{key[0]}/{key[1]}"
                )
            bindings[key] = {
                "clue_id": key[0],
                "observation_id": key[1],
                "quote": source["quote"],
                "locator": source.get("locator"),
            }
    return [bindings[key] for key in sorted(bindings)]


def validated_evidence_index(
    document: dict[str, Any],
    snapshot: dict[str, Any],
) -> dict[tuple[str, str], dict[str, Any]]:
    """Return validated evidence without deriving new sources from claims.

    New validated documents carry a ledger produced from the real source index
    during ``validate``. Legacy documents fall back to one fulltext rebuild for
    compatibility, never one rebuild per claim.
    """
    bindings_value = document.get("evidence_bindings")
    if bindings_value is None:
        return evidence_index_with_fulltext(snapshot)
    bindings = require_list(document, "evidence_bindings", "validated analysis")
    sources = evidence_index(snapshot)
    clues = {
        clue["clue_id"]: clue
        for clue in snapshot["clues"]
        if isinstance(clue, dict) and isinstance(clue.get("clue_id"), str)
    }
    seen: set[tuple[str, str]] = set()
    for index, binding in enumerate(bindings, start=1):
        label = f"validated analysis evidence_bindings[{index}]"
        if not isinstance(binding, dict):
            raise CliError(f"{label} must be an object")
        clue_id = require_string(binding, "clue_id", label)
        observation_id = require_string(binding, "observation_id", label)
        quote = require_string(binding, "quote", label)
        locator = binding.get("locator")
        if locator is not None and not isinstance(locator, str):
            raise CliError(f"{label} locator must be a string or null")
        key = (clue_id, observation_id)
        if key in seen:
            raise CliError(f"validated analysis has duplicate evidence binding: {clue_id}/{observation_id}")
        seen.add(key)
        clue = clues.get(clue_id)
        if clue is None:
            raise CliError(f"{label} references an unknown clue: {clue_id}")
        source = sources.get(key)
        if source is not None:
            if quote != source["quote"] or locator != source.get("locator"):
                raise CliError(
                    f"{label} does not match the frozen snapshot observation"
                )
            continue
        match = re.fullmatch(rf"{re.escape(clue_id)}:pdf-chunk-(\d+)", observation_id)
        if match is None or int(match.group(1)) < 1:
            raise CliError(
                f"{label} must reference a snapshot observation or canonical PDF chunk"
            )
        expected_locator = f"pdf:chunk={int(match.group(1))}"
        if locator != expected_locator:
            raise CliError(f"{label} has an invalid PDF chunk locator")
        sources[key] = {
            "source_url": clue["source_url"],
            "observed_at": clue["observed_at"],
            "content_hash": clue["content_hash"],
            "quote": quote,
            "locator": locator,
            "source_metadata": clue.get("source_metadata", {}),
        }
    return sources


def validate_validated(document: dict[str, Any], analysis_input: dict[str, Any]) -> dict[str, Any]:
    if document.get("schema_version") != VALIDATED_SCHEMA:
        raise CliError(f"validated analysis must use schema_version {VALIDATED_SCHEMA}")
    normalized_input = validate_analysis_input(analysis_input)
    if document.get("case_id") != normalized_input["task"]["case_id"]:
        raise CliError("validated analysis case_id does not match analysis input")
    if document.get("snapshot_id") != normalized_input["snapshot"]["snapshot_id"]:
        raise CliError("validated analysis snapshot_id does not match analysis input")
    if document.get("analysis_input_sha256") != object_digest(analysis_input):
        raise CliError("validated analysis does not belong to this exact analysis input")
    claims = require_list(document, "claims", "validated analysis")
    shared_sources = validated_evidence_index(document, normalized_input["snapshot"])
    claim_ids: set[str] = set()
    for index, claim in enumerate(claims, start=1):
        if not isinstance(claim, dict):
            raise CliError(f"validated analysis claims[{index}] must be an object")
        claim_id = require_string(claim, "claim_id", f"validated analysis claims[{index}]")
        if claim_id in claim_ids:
            raise CliError(f"validated analysis has duplicate claim_id: {claim_id}")
        claim_ids.add(claim_id)
        validation = require_object(claim, "validation", f"validated analysis claims[{index}]")
        if validation.get("status") != "valid" or validation.get("errors") != []:
            raise CliError("validated analysis may contain only locally valid claims")
        review = require_object(claim, "review", f"validated analysis claims[{index}]")
        if not isinstance(review.get("required"), bool):
            raise CliError("validated analysis claim review.required must be a boolean")
        require_string(review, "review_key", "validated analysis claim review")
        require_string(review, "revision_hash", "validated analysis claim review")
        candidate_claim = deepcopy(claim)
        candidate_claim.pop("validation", None)
        candidate_claim.pop("review", None)
        validate_candidate_response(
            {
                "schema_version": CANDIDATES_SCHEMA,
                "case_id": document["case_id"],
                "snapshot_id": document["snapshot_id"],
                "claims": [candidate_claim],
                "unresolved": [],
                "framework": {
                    "title": "Single-claim validation framework",
                    "stages": [
                        {
                            "stage_id": "stage-001",
                            "sequence": 1,
                            "title": "Claim validation",
                            "explanation": "Validate one claim and its evidence binding.",
                            "transition": "This is the only claim in this validation call.",
                            "claim_ids": [claim_id],
                        }
                    ],
                },
            },
            analysis_input,
            enforce_coverage=False,
            enforce_minimum_sources=False,
            sources=shared_sources,
        )
        expected_reasons = review_requirement(candidate_claim, normalized_input["task"]["review_policy"])
        if review.get("reasons") != expected_reasons or review["required"] != bool(expected_reasons):
            raise CliError(f"validated analysis review requirements do not match claim: {claim_id}")
        if review["review_key"] != f"claim:{document['case_id']}:{claim_id}":
            raise CliError(f"validated analysis review key does not match claim: {claim_id}")
        revision_basis = deepcopy(claim)
        revision_basis.pop("review", None)
        if review["revision_hash"] != claim_revision_hash(revision_basis):
            raise CliError(f"validated analysis review revision does not match claim: {claim_id}")
    validate_framework(
        require_object(document, "framework", "validated analysis"),
        claim_ids,
        "validated analysis framework",
    )
    validate_observation_coverage(
        claims,
        normalized_input["snapshot"],
        normalized_input["task"]["coverage_mode"],
        "validated analysis",
    )
    return deepcopy(document)


def manual_review_list(validated: dict[str, Any], analysis_input: dict[str, Any]) -> dict[str, Any]:
    validated = validate_validated(validated, analysis_input)
    normalized_input = validate_analysis_input(analysis_input)
    sources = validated_evidence_index(validated, normalized_input["snapshot"])
    records: list[dict[str, Any]] = []
    for claim in validated["claims"]:
        if not claim["review"]["required"]:
            continue
        record_evidence: list[dict[str, Any]] = []
        for evidence in claim["evidence"]:
            source = sources[(evidence["clue_id"], evidence["observation_id"])]
            record_evidence.append(
                {
                    "source_url": source["source_url"],
                    "source_excerpt": source["quote"],
                    "observed_at": source["observed_at"],
                    "evidence_role": evidence["relation"],
                    "clue_id": evidence["clue_id"],
                    "observation_id": evidence["observation_id"],
                    "locator": source["locator"],
                }
            )
        records.append(
            {
                "record_id": claim["claim_id"],
                "review_key": claim["review"]["review_key"],
                "revision_hash": claim["review"]["revision_hash"],
                "title": claim["title"],
                "summary": claim["statement"],
                "classification": claim["classification"],
                "confidence": claim["confidence"],
                "questions": claim["questions"] + claim["limitations"] + claim["review"]["reasons"],
                "evidence": record_evidence,
                "payload": {
                    "case_id": validated["case_id"],
                    "snapshot_id": validated["snapshot_id"],
                    "claim": claim,
                },
            }
        )
    return {
        "schema_version": MANUAL_REVIEW_SCHEMA,
        "review_set_id": f"analysis:{validated['case_id']}:{validated['snapshot_id']}",
        "review_kind": "intelligence_finding",
        "generated_at": utc_now(),
        "source": {
            "validated_analysis_sha256": object_digest(validated),
            "analysis_input_sha256": object_digest(analysis_input),
        },
        "review_records": records,
    }


def policy_allows_automatic_resolution(policy: dict[str, Any]) -> bool:
    """True when the configured mode does not require a human decision."""
    return policy.get("mode") in {"auto-pass", "auto-approve"}


def automatic_pass_result(validated: dict[str, Any], analysis_input: dict[str, Any]) -> dict[str, Any]:
    """Resolve required claims according to auto-pass or auto-approve mode."""
    normalized_input = validate_analysis_input(analysis_input)
    policy = normalized_input["task"]["review_policy"]
    if not policy_allows_automatic_resolution(policy):
        raise CliError("automatic resolution requires auto-pass or auto-approve mode")
    validated = validate_validated(validated, analysis_input)
    review_mode = policy["mode"]
    mode = review_mode.replace("-", "_")
    note = (
        f"Automatically resolved via {review_mode} policy; not human-reviewed. "
        "Lightweight path (no PDF re-extraction / no expanded review dossier)."
    )
    approved: list[dict[str, Any]] = []
    for claim in validated["claims"]:
        if not claim.get("review", {}).get("required"):
            continue
        review = claim["review"]
        approved.append(
            {
                "record_id": claim["claim_id"],
                "review_key": review["review_key"],
                "revision_hash": review["revision_hash"],
                "title": claim.get("title"),
                "summary": claim.get("statement"),
                "manual_review": {
                    "status": "approved",
                    "note": note,
                    "updated_at": utc_now(),
                    "revision_hash": review["revision_hash"],
                },
            }
        )
    return {
        "schema_version": MANUAL_REVIEW_RESULT_SCHEMA,
        "generated_at": utc_now(),
        "tool": {"name": TOOL_NAME, "version": read_version(Path(__file__).parent)},
        "review_set_id": f"analysis:{validated['case_id']}:{validated['snapshot_id']}",
        "review_kind": "intelligence_finding",
        "source": {
            "validated_analysis_sha256": object_digest(validated),
            "analysis_input_sha256": object_digest(analysis_input),
        },
        "approval_mode": mode,
        "summary": {
            "review_total": len(approved),
            "pending": 0,
            "approved": len(approved),
            "rejected": 0,
        },
        "approved_records": approved,
        "rejected_records": [],
        "pending_records": [],
    }


def automatic_approval_result(validated: dict[str, Any], analysis_input: dict[str, Any]) -> dict[str, Any]:
    """Create an auditable automatic review result for the configured mode."""
    return automatic_pass_result(validated, analysis_input)


def review_records_by_id(review_result: dict[str, Any], expected_set_id: str) -> dict[str, dict[str, Any]]:
    if review_result.get("schema_version") != MANUAL_REVIEW_RESULT_SCHEMA:
        raise CliError(f"manual review result must use schema_version {MANUAL_REVIEW_RESULT_SCHEMA}")
    if review_result.get("review_set_id") != expected_set_id:
        raise CliError("manual review result belongs to a different review_set_id")
    if review_result.get("review_kind") != "intelligence_finding":
        raise CliError("manual review result must use review_kind intelligence_finding")
    records: dict[str, dict[str, Any]] = {}
    for status, field in (("approved", "approved_records"), ("rejected", "rejected_records"), ("pending", "pending_records")):
        for index, record in enumerate(require_list(review_result, field, "manual review result"), start=1):
            if not isinstance(record, dict):
                raise CliError(f"manual review result {field}[{index}] must be an object")
            record_id = require_string(record, "record_id", f"manual review result {field}[{index}]")
            if record_id in records:
                raise CliError(f"manual review result has duplicate record_id: {record_id}")
            manual = require_object(record, "manual_review", f"manual review result {field}[{index}]")
            if manual.get("status") != status:
                raise CliError(f"manual review result {field}[{index}] has an inconsistent status")
            records[record_id] = record
    return records


def enriched_claim(claim: dict[str, Any], sources: dict[tuple[str, str], dict[str, Any]], review_status: str, note: str) -> dict[str, Any]:
    copied = deepcopy(claim)
    enriched_evidence: list[dict[str, Any]] = []
    for evidence in copied["evidence"]:
        source = sources[(evidence["clue_id"], evidence["observation_id"])]
        enriched_evidence.append(
            {
                **evidence,
                "source_url": source["source_url"],
                "observed_at": source["observed_at"],
                "locator": source["locator"],
                "source_metadata": source["source_metadata"],
            }
        )
    copied["evidence"] = enriched_evidence
    copied["review_decision"] = {"status": review_status, "note": note}
    return copied


def build_final_output(validated: dict[str, Any], review_result: dict[str, Any], analysis_input: dict[str, Any], report_path: Path) -> tuple[dict[str, Any], str]:
    validated = validate_validated(validated, analysis_input)
    normalized_input = validate_analysis_input(analysis_input)
    expected_set_id = f"analysis:{validated['case_id']}:{validated['snapshot_id']}"
    decisions = review_records_by_id(review_result, expected_set_id)
    approval_mode = review_result.get("approval_mode", "manual")
    if approval_mode not in {"manual", "auto_pass", "auto_approve"}:
        raise CliError("manual review result has an unsupported approval_mode")
    sources = validated_evidence_index(validated, normalized_input["snapshot"])
    judgments: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for claim in validated["claims"]:
        if not claim["review"]["required"]:
            judgments.append(enriched_claim(claim, sources, "not_required", ""))
            continue
        decision_record = decisions.get(claim["claim_id"])
        if decision_record is None:
            raise CliError(f"required manual review is missing: {claim['claim_id']}")
        if decision_record.get("review_key") != claim["review"]["review_key"]:
            raise CliError(f"manual review key does not match claim: {claim['claim_id']}")
        if decision_record.get("revision_hash") != claim["review"]["revision_hash"]:
            raise CliError(f"manual review revision does not match claim: {claim['claim_id']}")
        manual = decision_record["manual_review"]
        status = manual["status"]
        note = manual.get("note", "")
        if not isinstance(note, str):
            raise CliError(f"manual review note must be a string: {claim['claim_id']}")
        if status == "pending":
            raise CliError(f"required manual review is pending: {claim['claim_id']}")
        if status == "approved":
            judgments.append(enriched_claim(claim, sources, "approved", note))
        elif status == "rejected":
            rejected.append(enriched_claim(claim, sources, "rejected", note))
        else:
            raise CliError(f"manual review status is unsupported: {claim['claim_id']}")
    published_claim_ids = {claim["claim_id"] for claim in judgments}
    framework = validate_framework(
        require_object(validated, "framework", "validated analysis"),
        {claim["claim_id"] for claim in validated["claims"]},
        "validated analysis framework",
    )
    rejected_framework_claims = {
        claim_id
        for stage in framework["stages"]
        for claim_id in stage["claim_ids"]
        if claim_id not in published_claim_ids
    }
    if rejected_framework_claims:
        raise CliError(
            "framework references rejected claims; revise the analysis before finalizing: "
            + ", ".join(sorted(rejected_framework_claims))
        )
    output_seed = {
        "case_id": validated["case_id"],
        "analysis_input_sha256": object_digest(analysis_input),
        "validated_sha256": object_digest(validated),
        "review_result_sha256": object_digest(review_result),
    }
    output = {
        "schema_version": OUTPUT_SCHEMA,
        "output_id": f"analysis-output:{validated['case_id']}:{object_digest(output_seed).split(':', 1)[1][:16]}",
        "status": "final",
        "generated_at": utc_now(),
        "case_id": validated["case_id"],
        "task": {
            key: deepcopy(value)
            for key, value in validated["task"].items()
            if key in {
                "question",
                "question_prompt",
                "decision_context",
                "decision_context_prompt",
                "audience",
                "audience_prompt",
                "time_range",
            }
        },
        "collection_snapshot": {
            "snapshot_id": validated["snapshot_id"],
            "sha256": object_digest(normalized_input["snapshot"]),
        },
        "search_scope": deepcopy(normalized_input["snapshot"].get("collection_reproduction", {})),
        "review": {
            "status": "completed",
            "approval_mode": approval_mode,
            "review_set_id": expected_set_id,
            "review_result_sha256": object_digest(review_result),
            "summary": deepcopy(review_result.get("summary", {})),
        },
        "provenance": {
            "analysis_input_sha256": object_digest(analysis_input),
            "validated_analysis_sha256": object_digest(validated),
        },
        "judgments": judgments,
        "rejected_claims": rejected,
        "unresolved": deepcopy(validated.get("unresolved", [])),
        "framework": framework,
        "summary": {
            "judgment_total": len(judgments),
            "rejected_total": len(rejected),
            "unresolved_total": len(validated.get("unresolved", [])),
        },
    }
    return output, render_report(output)


def render_report(output: dict[str, Any]) -> str:
    task = output["task"]
    lines = [
        "# Literature Review Report",
        "",
        "## Research Task",
        "",
        task["question"],
        "",
        f"- Decision context: {task['decision_context']}",
        f"- Audience: {task['audience']}",
        f"- Collection snapshot: `{output['collection_snapshot']['snapshot_id']}`",
        f"- Review mode: {output['review']['approval_mode']}",
        "",
    ]
    # search_scope stays on the JSON output for report-writing; do not render it
    # here. Report-writing owns the human-facing Search Scope section.
    framework = output.get("framework")
    if isinstance(framework, dict) and isinstance(framework.get("stages"), list):
        lines.extend(["## Viewpoint Framework", ""])
        for stage in framework["stages"]:
            lines.extend(
                [
                    f"### {stage['sequence']}. {stage['title']}",
                    "",
                    stage["explanation"],
                    "",
                f"- Transition: {stage['transition']}",
                f"- Claims: {', '.join(f'`{claim_id}`' for claim_id in stage['claim_ids'])}",
                    "",
                ]
            )
    lines.extend(["## Confirmed Judgments", ""])
    if not output["judgments"]:
        lines.extend(["No confirmed judgments are available for delivery.", ""])
    for claim in output["judgments"]:
        lines.extend(
            [
                f"### {claim['title']} (`{claim['claim_id']}`)",
                "",
                claim["statement"],
                "",
                f"- Classification: {claim['classification']}",
                f"- Status: {claim['status']}",
                f"- Confidence: {claim['confidence']}",
                f"- Review: {claim['review_decision']['status']}",
                "- Evidence:",
            ]
        )
        for evidence in claim["evidence"]:
            quote = " ".join(re.sub(r"<[^>]+>", " ", evidence["quote"]).split())
            lines.append(f"  - <{evidence['source_url']}>: {quote}")
        if claim["limitations"]:
            lines.append(f"- Limitations: {'; '.join(claim['limitations'])}")
        lines.append("")
    lines.extend(["## Unresolved Items", ""])
    if output["unresolved"]:
        lines.extend(f"- {item}" for item in output["unresolved"])
    else:
        lines.append("None.")
    lines.extend(["", "## Rejected Claims", ""])
    if output["rejected_claims"]:
        for claim in output["rejected_claims"]:
            note = claim["review_decision"]["note"] or "No note provided"
            lines.append(f"- `{claim['claim_id']}`: {claim['title']} ({note})")
    else:
        lines.append("None.")
    lines.append("")
    return "\n".join(lines)


def write_run(run_dir: Path, request: dict[str, Any], response: dict[str, Any], result: dict[str, Any]) -> None:
    run_dir = run_dir.expanduser().resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    write_json(run_dir / "request.json", request)
    write_json(run_dir / "response.json", response)
    write_json(
        run_dir / "run.json",
        {
            "schema_version": "clue.intelligence.analysis-run.v1",
            "tool": {"name": TOOL_NAME},
            "created_at": utc_now(),
            "request_sha256": object_digest(request),
            "response_sha256": object_digest(response),
            "result_sha256": object_digest(result),
        },
    )


def command_prepare(args: argparse.Namespace) -> int:
    task = read_json(Path(args.task), "analysis task")
    snapshot = read_json(Path(args.snapshot), "collection snapshot")
    payload = build_analysis_input(task, snapshot)
    output = Path(args.output).expanduser().resolve()
    write_json(output, payload)
    print(json.dumps({"status": "succeeded", "output": str(output), "input_id": payload["input_id"]}, ensure_ascii=False, indent=2))
    return 0


def command_propose(args: argparse.Namespace, root: Path) -> int:
    analysis_input = read_json(Path(args.input), "analysis input")
    validate_analysis_input(analysis_input)
    request = model_request(candidate_prompt(root), analysis_input)
    response = request_completion(
        request,
        (Path(args.run_dir) if args.run_dir else Path(args.output).parent) / "codex-session.json",
        Path(args.input),
    )
    candidate_response = extract_model_json(response)
    candidate_response["case_id"] = analysis_input["task"]["case_id"]
    candidate_response["snapshot_id"] = analysis_input["snapshot"]["snapshot_id"]
    candidate = validate_candidate_response(candidate_response, analysis_input)
    candidate["generated_at"] = utc_now()
    candidate["provenance"] = {
        "analysis_input_sha256": object_digest(analysis_input),
        "prompt": "candidate-claims.v1.md",
        "executor": LOCAL_EXECUTOR,
    }
    output = Path(args.output).expanduser().resolve()
    write_json(output, candidate)
    if args.run_dir:
        write_run(Path(args.run_dir), request, response, candidate)
    print(json.dumps({"status": "succeeded", "output": str(output), "claim_count": len(candidate["claims"])}, ensure_ascii=False, indent=2))
    return 0


def command_propose_batches(args: argparse.Namespace, root: Path) -> int:
    """Propose cached, independently valid candidate claims for frozen batches."""
    analysis_input = read_json(Path(args.input), "analysis input")
    normalized = validate_analysis_input(analysis_input)
    clues = normalized["snapshot"]["clues"]
    batch_size = args.batch_size
    if not 1 <= batch_size <= 100:
        raise CliError("--batch-size must be between 1 and 100")
    if args.max_retries < 0:
        raise CliError("--max-retries must be zero or greater")
    if not 0 <= args.start_offset <= len(clues):
        raise CliError("--start-offset must be within the supplied clue range")
    cache_root = Path(args.cache_dir).expanduser().resolve()
    merged_claims: list[dict[str, Any]] = []
    unresolved: list[str] = []
    stages: list[dict[str, Any]] = []
    cache_hits = 0
    for batch_index, start in enumerate(range(args.start_offset, len(clues), batch_size), start=1):
        batch_clues = clues[start : start + batch_size]
        batch_task = deepcopy(normalized["task"])
        # Do not invent a per-batch source floor; inherit optional task value only.
        if "minimum_distinct_sources" not in batch_task:
            batch_task.pop("minimum_distinct_sources", None)
        batch_snapshot = deepcopy(normalized["snapshot"])
        batch_snapshot["clues"] = batch_clues
        batch_input = build_analysis_input(batch_task, batch_snapshot)
        cache_key = object_digest({"input_sha256": batch_input["input_sha256"], "prompt": candidate_prompt(root), "executor": LOCAL_EXECUTOR})
        cache_path = cache_root / cache_key.split(":", 1)[1] / "candidate.json"
        if cache_path.is_file():
            candidate = read_json(cache_path, "batch cache")
            candidate = validate_candidate_response(candidate, batch_input)
            cache_hits += 1
        else:
            request = model_request(candidate_prompt(root), batch_input)
            write_json(cache_path.with_name("input.json"), batch_input)
            attempts_root = cache_path.with_name("attempts")
            last_error: CliError | None = None
            for attempt in range(1, args.max_retries + 2):
                attempt_dir = attempts_root / f"attempt-{attempt:03d}"
                write_json(attempt_dir / "request.json", request)
                try:
                    response = request_completion(
                        request,
                        cache_root / "codex-session.json",
                        cache_path.with_name("input.json"),
                    )
                    write_json(attempt_dir / "response.json", response)
                    candidate_response = extract_model_json(response)
                    candidate_response["case_id"] = batch_input["task"]["case_id"]
                    candidate_response["snapshot_id"] = batch_input["snapshot"]["snapshot_id"]
                    candidate = validate_candidate_response(candidate_response, batch_input)
                    break
                except CliError as error:
                    last_error = error
                    write_json(
                        attempt_dir / "failure.json",
                        {"created_at": utc_now(), "error": str(error)},
                    )
            else:
                assert last_error is not None
                write_json(
                    cache_path.with_name("failure.json"),
                    {"created_at": utc_now(), "error": str(last_error)},
                )
                raise last_error
            write_json(cache_path.with_name("request.json"), request)
            candidate["generated_at"] = utc_now()
            candidate["provenance"] = {"analysis_input_sha256": object_digest(batch_input), "cache_key": cache_key, "executor": LOCAL_EXECUTOR}
            write_json(cache_path, candidate)
            write_json(cache_path.with_name("response.json"), response)
        rename: dict[str, str] = {}
        for claim_number, claim in enumerate(candidate["claims"], start=1):
            copied = deepcopy(claim)
            new_id = f"batch-{batch_index:03d}-claim-{claim_number:03d}"
            rename[copied["claim_id"]] = new_id
            copied["claim_id"] = new_id
            merged_claims.append(copied)
        for item in candidate["unresolved"]:
            if item not in unresolved:
                unresolved.append(item)
        stages.append({"stage_id": f"batch-{batch_index:03d}", "sequence": batch_index, "title": f"Batch {batch_index} findings", "explanation": "Evidence-bound findings from one frozen corpus batch.", "transition": "The next batch extends coverage to additional frozen sources.", "claim_ids": [rename[claim["claim_id"]] for claim in candidate["claims"]]})
    if args.cache_only:
        print(json.dumps({"status": "cached", "batch_count": len(stages), "cache_hits": cache_hits}, ensure_ascii=False, indent=2))
        return 0
    merged = {"schema_version": CANDIDATES_SCHEMA, "case_id": normalized["task"]["case_id"], "snapshot_id": normalized["snapshot"]["snapshot_id"], "claims": merged_claims, "unresolved": unresolved, "framework": {"title": "Batch-merged literature evidence", "stages": stages}}
    merged = validate_candidate_response(merged, analysis_input)
    output = Path(args.output).expanduser().resolve()
    write_json(output, merged)
    print(json.dumps({"status": "succeeded", "output": str(output), "claim_count": len(merged_claims), "batch_count": len(stages), "cache_hits": cache_hits}, ensure_ascii=False, indent=2))
    return 0


def command_merge_cache(args: argparse.Namespace) -> int:
    """Merge a non-overlapping, complete cover of valid cached batch candidates."""
    analysis_input = read_json(Path(args.input), "analysis input")
    normalized = validate_analysis_input(analysis_input)
    cache_root = Path(args.cache_dir).expanduser().resolve()
    available: list[tuple[set[str], dict[str, Any]]] = []
    for path in cache_root.rglob("candidate.json"):
        input_path = path.with_name("input.json")
        if not input_path.is_file():
            continue
        batch_input = read_json(input_path, "batch cache input")
        try:
            batch_normalized = validate_analysis_input(batch_input)
            if batch_normalized["task"]["case_id"] != normalized["task"]["case_id"]:
                continue
            candidate = validate_candidate_response(read_json(path, "batch cache"), batch_input)
        except CliError:
            continue
        available.append(({clue["clue_id"] for clue in batch_normalized["snapshot"]["clues"]}, candidate))
    required = [clue["clue_id"] for clue in normalized["snapshot"]["clues"]]
    selected: list[tuple[set[str], dict[str, Any]]] = []
    covered: set[str] = set()
    for clue_id in required:
        if clue_id in covered:
            continue
        options = [(ids, candidate) for ids, candidate in available if clue_id in ids and not ids & covered]
        if not options:
            raise CliError(f"batch cache does not cover clue: {clue_id}")
        ids, candidate = max(options, key=lambda item: len(item[0]))
        selected.append((ids, candidate))
        covered.update(ids)
    merged_claims: list[dict[str, Any]] = []
    unresolved: list[str] = []
    stages: list[dict[str, Any]] = []
    for batch_index, (_ids, candidate) in enumerate(selected, start=1):
        rename: dict[str, str] = {}
        for claim_number, claim in enumerate(candidate["claims"], start=1):
            copied = deepcopy(claim)
            new_id = f"batch-{batch_index:03d}-claim-{claim_number:03d}"
            rename[copied["claim_id"]] = new_id
            copied["claim_id"] = new_id
            merged_claims.append(copied)
        for item in candidate["unresolved"]:
            if item not in unresolved:
                unresolved.append(item)
        stages.append({"stage_id": f"batch-{batch_index:03d}", "sequence": batch_index, "title": f"Batch {batch_index} findings", "explanation": "Evidence-bound findings from one frozen corpus batch.", "transition": "The next batch extends coverage to additional frozen sources.", "claim_ids": [rename[claim["claim_id"]] for claim in candidate["claims"]]})
    merged = {"schema_version": CANDIDATES_SCHEMA, "case_id": normalized["task"]["case_id"], "snapshot_id": normalized["snapshot"]["snapshot_id"], "claims": merged_claims, "unresolved": unresolved, "framework": {"title": "Batch-merged literature evidence", "stages": stages}}
    merged = validate_candidate_response(merged, analysis_input)
    output = Path(args.output).expanduser().resolve()
    write_json(output, merged)
    print(json.dumps({"status": "succeeded", "output": str(output), "claim_count": len(merged_claims), "batch_count": len(stages)}, ensure_ascii=False, indent=2))
    return 0


def command_validate(args: argparse.Namespace) -> int:
    analysis_input = read_json(Path(args.input), "analysis input")
    candidates = read_json(Path(args.candidates), "candidate analysis")
    payload = validate_candidates(candidates, analysis_input)
    output = Path(args.output).expanduser().resolve()
    write_json(output, payload)
    print(json.dumps({"status": "succeeded", "output": str(output), "summary": payload["summary"]}, ensure_ascii=False, indent=2))
    return 0


def command_review_list(args: argparse.Namespace) -> int:
    analysis_input = read_json(Path(args.input), "analysis input")
    validated = read_json(Path(args.validated), "validated analysis")
    payload = manual_review_list(validated, analysis_input)
    output = Path(args.output).expanduser().resolve()
    write_json(output, payload)
    print(json.dumps({"status": "succeeded", "output": str(output), "review_count": len(payload["review_records"])}, ensure_ascii=False, indent=2))
    return 0


def command_auto_approve(args: argparse.Namespace) -> int:
    analysis_input = read_json(Path(args.input), "analysis input")
    validated = read_json(Path(args.validated), "validated analysis")
    if validate_analysis_input(analysis_input)["task"]["review_policy"]["mode"] != "auto-approve":
        raise CliError("auto-approve requires review_policy.mode=auto-approve")
    payload = automatic_approval_result(validated, analysis_input)
    output = Path(args.output).expanduser().resolve()
    write_json(output, payload)
    print(
        json.dumps(
            {
                "status": "succeeded",
                "output": str(output),
                "summary": payload["summary"],
                "review_mode": payload.get("approval_mode") or "automatic",
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def command_auto_pass(args: argparse.Namespace) -> int:
    """Explicit lightweight automatic pass."""
    analysis_input = read_json(Path(args.input), "analysis input")
    validated = read_json(Path(args.validated), "validated analysis")
    if validate_analysis_input(analysis_input)["task"]["review_policy"]["mode"] != "auto-pass":
        raise CliError("auto-pass requires review_policy.mode=auto-pass")
    payload = automatic_pass_result(validated, analysis_input)
    output = Path(args.output).expanduser().resolve()
    write_json(output, payload)
    print(
        json.dumps(
            {
                "status": "succeeded",
                "output": str(output),
                "summary": payload["summary"],
                "review_mode": "auto-pass",
                "approval_mode": payload.get("approval_mode"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def command_iterate(args: argparse.Namespace, root: Path) -> int:
    """Iterative claim-graph: seed cores, then absorb papers as identical/new/contradictory."""
    import iterate as iterate_mod

    analysis_input = read_json(Path(args.input), "analysis input")
    validate_analysis_input(analysis_input)
    work_dir = Path(args.work_dir).expanduser().resolve() if args.work_dir else Path(args.output).expanduser().resolve().parent / "iterate-work"
    seed_ids = None
    if args.seed_ids:
        seed_ids = [part.strip() for part in args.seed_ids.split(",") if part.strip()]
    elif args.seed_file:
        seed_doc = read_json(Path(args.seed_file), "seed ids file")
        raw = seed_doc.get("seed_paper_ids") or seed_doc.get("seeds") or seed_doc.get("record_ids")
        if not isinstance(raw, list):
            raise CliError("seed file must contain seed_paper_ids array")
        seed_ids = [str(x) for x in raw if str(x).strip()]
    corpus = iterate_mod.run_iteration(
        analysis_input,
        root=root,
        work_dir=work_dir,
        seed_ids=seed_ids,
        max_papers=args.max_papers,
        model=getattr(args, "model", None),
        reasoning_effort=getattr(args, "reasoning_effort", None),
    )
    output = Path(args.output).expanduser().resolve()
    write_json(output, corpus)
    result: dict[str, Any] = {
        "status": "succeeded",
        "output": str(output),
        "papers": corpus["stats"].get("papers_processed"),
        "nodes": len(corpus["claim_graph"]["nodes"]),
        "edges": len(corpus["claim_graph"]["edges"]),
        "stats": corpus["stats"],
    }
    if args.export_candidates:
        candidates = iterate_mod.export_candidates(corpus)
        # Drop provenance keys unknown to strict validators if needed — keep for audit.
        cand_path = Path(args.export_candidates).expanduser().resolve()
        write_json(cand_path, candidates)
        result["candidates"] = str(cand_path)
        result["claim_count"] = len(candidates.get("claims") or [])
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def command_finalize(args: argparse.Namespace) -> int:
    analysis_input = read_json(Path(args.input), "analysis input")
    validated = read_json(Path(args.validated), "validated analysis")
    review_result = read_json(Path(args.review_result), "manual review result")
    output_path = Path(args.output).expanduser().resolve()
    report_path = Path(args.report).expanduser().resolve()
    if output_path == report_path:
        raise CliError("--output and --report must be different paths")
    payload, report = build_final_output(validated, review_result, analysis_input, report_path)
    write_text(report_path, report)
    write_json(output_path, payload)
    print(json.dumps({"status": "succeeded", "output": str(output_path), "report": str(report_path), "summary": payload["summary"]}, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=TOOL_NAME,
        description="Structured local-Codex intelligence analysis with manual-review-gated output.",
    )
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("version", help="Print the tool and backend versions.")

    prepare = subcommands.add_parser("prepare", help="Validate a task and immutable collection snapshot.")
    prepare.add_argument("--task", required=True, help="clue.intelligence.analysis-task.v2 JSON path.")
    prepare.add_argument("--snapshot", required=True, help="clue.intelligence.collection-snapshot.v2 JSON path.")
    prepare.add_argument("--output", required=True, help="Formatted analysis-input JSON path.")

    propose = subcommands.add_parser("propose", help="Call local Codex and write structured candidate claims.")
    propose.add_argument("--input", required=True, help="Formatted analysis-input JSON path.")
    propose.add_argument("--output", required=True, help="Candidate analysis JSON path.")
    propose.add_argument("--run-dir", help="Optional audit directory for request, response and run manifests.")

    batches = subcommands.add_parser("propose-batches", help="Generate cached candidate claims from bounded frozen batches.")
    batches.add_argument("--input", required=True)
    batches.add_argument("--output", required=True)
    batches.add_argument("--cache-dir", required=True)
    batches.add_argument("--batch-size", type=int, default=20)
    batches.add_argument("--start-offset", type=int, default=0)
    batches.add_argument("--cache-only", action="store_true")
    batches.add_argument("--max-retries", type=int, default=2)

    merge_cache = subcommands.add_parser("merge-cache", help="Merge valid cached batches into a complete candidate analysis.")
    merge_cache.add_argument("--input", required=True)
    merge_cache.add_argument("--cache-dir", required=True)
    merge_cache.add_argument("--output", required=True)

    validate = subcommands.add_parser("validate", help="Validate evidence bindings and derive review requirements.")
    validate.add_argument("--input", required=True, help="Formatted analysis-input JSON path.")
    validate.add_argument("--candidates", required=True, help="Candidate analysis JSON path.")
    validate.add_argument("--output", required=True, help="Validated analysis JSON path.")

    review_list = subcommands.add_parser("review-list", help="Create a clue.manual-review.v2 finding list.")
    review_list.add_argument("--input", required=True, help="Formatted analysis-input JSON path.")
    review_list.add_argument("--validated", required=True, help="Validated analysis JSON path.")
    review_list.add_argument("--output", required=True, help="manual-review-list.json path.")

    auto_approve = subcommands.add_parser(
        "auto-approve",
        help="Automatically approve required reviews for auto-approve mode.",
    )
    auto_approve.add_argument("--input", required=True, help="Formatted analysis-input JSON path.")
    auto_approve.add_argument("--validated", required=True, help="Validated analysis JSON path.")
    auto_approve.add_argument("--output", required=True, help="Automatic review result JSON path.")
    auto_pass = subcommands.add_parser(
        "auto-pass",
        help="Bypass the review queue in auto-pass mode.",
    )
    auto_pass.add_argument("--input", required=True, help="Formatted analysis-input JSON path.")
    auto_pass.add_argument("--validated", required=True, help="Validated analysis JSON path.")
    auto_pass.add_argument("--output", required=True, help="Automatic review result JSON path.")

    finalize = subcommands.add_parser("finalize", help="Create final output.json and report.md after review completion.")
    finalize.add_argument("--input", required=True, help="Formatted analysis-input JSON path.")
    finalize.add_argument("--validated", required=True, help="Validated analysis JSON path.")
    finalize.add_argument("--review-result", required=True, help="clue.manual-review.result.v2 JSON path.")
    finalize.add_argument("--output", required=True, help="Final output.json path.")
    finalize.add_argument("--report", required=True, help="Final deterministic report.md path.")

    iterate = subcommands.add_parser(
        "iterate",
        help="Iterative claim graph: seed core claims, then absorb papers as identical/new/contradictory.",
    )
    iterate.add_argument("--input", required=True, help="Formatted analysis-input JSON path.")
    iterate.add_argument("--output", required=True, help="literature-iteration.v1 JSON path.")
    iterate.add_argument("--work-dir", help="Scratch dir for per-paper LLM I/O and checkpoints.")
    iterate.add_argument(
        "--seed-ids",
        help="Comma-separated seed paper/clue IDs (default: first clue).",
    )
    iterate.add_argument(
        "--seed-file",
        help="JSON with seed_paper_ids array (overrides --seed-ids).",
    )
    iterate.add_argument("--max-papers", type=int, default=None, help="Optional cap for dry runs.")
    iterate.add_argument(
        "--model",
        default=None,
        help="Codex model via tools/codex (default gpt-5.4; or LITERATURE_REVIEW_MODEL / CODEX_MODEL).",
    )
    iterate.add_argument(
        "--reasoning-effort",
        default=None,
        help='Codex model_reasoning_effort (default medium; or LITERATURE_REVIEW_REASONING_EFFORT).',
    )
    iterate.add_argument(
        "--export-candidates",
        help="Also write analysis-candidates.v2 for existing validate/finalize path.",
    )
    return parser


def main(argv: list[str]) -> int:
    root = Path(__file__).resolve().parent
    args = build_parser().parse_args(argv)
    try:
        if args.command == "version":
            print(
                json.dumps(
                    {
                        "tool": {"name": TOOL_NAME, "version": read_version(root)},
                        "backend_lock": json.loads((root / "backend.lock.json").read_text(encoding="utf-8")),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
        if args.command == "prepare":
            return command_prepare(args)
        if args.command == "propose":
            return command_propose(args, root)
        if args.command == "propose-batches":
            return command_propose_batches(args, root)
        if args.command == "merge-cache":
            return command_merge_cache(args)
        if args.command == "validate":
            return command_validate(args)
        if args.command == "review-list":
            return command_review_list(args)
        if args.command == "auto-approve":
            return command_auto_approve(args)
        if args.command == "auto-pass":
            return command_auto_pass(args)
        if args.command == "finalize":
            return command_finalize(args)
        if args.command == "iterate":
            return command_iterate(args, root)
        raise CliError(f"unsupported command: {args.command}")
    except CliError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
