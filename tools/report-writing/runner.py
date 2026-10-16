#!/usr/bin/env python3
"""Evidence-bound local-Codex report writing from final intelligence output."""

from __future__ import annotations

import argparse
import contextlib
import html
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


TOOL_NAME = "clue-report-writing"
ANALYSIS_OUTPUT_SCHEMA = "clue.intelligence-analysis.output.v2"
INPUT_SCHEMA = "clue.report-writing.input.v2"
DRAFT_SCHEMA = "clue.report-writing.draft.v2"
REVIEW_SCHEMA = "clue.report-writing.review.v2"
REPORT_SCHEMA = "clue.report-writing.output.v2"
LOCAL_EXECUTOR = "local-codex"
REVIEW_DIMENSIONS = ("unity", "support", "coherence", "sentence_skills")
MAX_RENDERED_EVIDENCE_CHARS = 480
# Report drafting defaults are chosen for unattended workflow latency.
DEFAULT_REPORT_MODEL = "gpt-5.6-terra"
DEFAULT_REPORT_REASONING_EFFORT = "low"
# Inline literature citations in draft prose: [@claim-001] or [@claim-001;claim-002]
INLINE_CLAIM_CITE_RE = re.compile(r"\[@([A-Za-z0-9_.:\-]+(?:\s*;\s*[A-Za-z0-9_.:\-]+)*)\]")
LITERATURE_TEMPLATE_IDS = frozenset({"literature-report", "research-brief"})
# Literature expand pipeline: reject bulk citation dumps.
MAX_CITE_CLUSTER_SIZE = 5
PROMPT_METHODS = {"generate-text", "generate-file", "derive", "copy-file"}
PROMPT_OUTPUT_KINDS = {"text", "markdown", "json", "string_array"}


def resolve_report_model() -> str:
    for key in (
        "POLARIS_LITERATURE_REPORT_MODEL",
        "POLARIS_LITERATURE_CODEX_MODEL",
        "REPORT_WRITING_MODEL",
        "CODEX_MODEL",
    ):
        value = (os.environ.get(key) or "").strip()
        if value:
            return value
    return DEFAULT_REPORT_MODEL


def resolve_report_reasoning_effort() -> str:
    value = (
        os.environ.get("POLARIS_LITERATURE_REPORT_REASONING_EFFORT")
        or os.environ.get("POLARIS_LITERATURE_REASONING_EFFORT")
        or os.environ.get("REPORT_WRITING_REASONING_EFFORT")
        or ""
    ).strip()
    return value or DEFAULT_REPORT_REASONING_EFFORT


def resolve_codex_executable() -> str:
    """Resolve the Polaris-selected Codex executable without shell parsing."""
    configured = (
        os.environ.get("POLARIS_LITERATURE_CODEX_BIN")
        or os.environ.get("CODEX_BIN")
        or ""
    ).strip()
    if configured:
        return configured
    return shutil.which("codex") or "codex"


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
        value = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CliError(f"{label} is not valid UTF-8 JSON: {path}") from error
    if not isinstance(value, dict):
        raise CliError(f"{label} must be a JSON object: {path}")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def write_text(path: Path, value: str) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        temporary.write_text(value, encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def require_string(document: dict[str, Any], key: str, label: str) -> str:
    value = document.get(key)
    if not isinstance(value, str) or not value.strip():
        raise CliError(f"{label} must contain a non-empty '{key}' string")
    return value


def require_object(document: dict[str, Any], key: str, label: str) -> dict[str, Any]:
    value = document.get(key)
    if not isinstance(value, dict):
        raise CliError(f"{label} must contain a '{key}' object")
    return value


def require_list(document: dict[str, Any], key: str, label: str) -> list[Any]:
    value = document.get(key)
    if not isinstance(value, list):
        raise CliError(f"{label} must contain a '{key}' array")
    return value


def require_string_list(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
        raise CliError(f"{label} must be an array of non-empty strings")
    return list(value)


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
    for key in ("question_prompt", "decision_context_prompt", "audience_prompt", "template_prompt"):
        prompt = value.get(key)
        if prompt is None:
            continue
        copied[key] = validate_prompt_spec(prompt, key)
    return copied


def load_template(root: Path, template_id: str) -> dict[str, Any]:
    path = root / "templates" / f"{template_id}.v1.json"
    if not path.is_file():
        raise CliError(f"unknown report template: {template_id}")
    template = read_json(path, "report template")
    if template.get("template_id") != template_id:
        raise CliError(f"report template has an inconsistent template_id: {path}")
    for field in ("title", "description"):
        require_string(template, field, "report template")
    sections = require_list(template, "sections", "report template")
    if not sections:
        raise CliError("report template must contain sections")
    section_ids: set[str] = set()
    normalized_sections: list[dict[str, Any]] = []
    for index, section in enumerate(sections, start=1):
        if not isinstance(section, dict):
            raise CliError(f"report template sections[{index}] must be an object")
        section_id = require_string(section, "section_id", f"report template sections[{index}]")
        if section_id in section_ids:
            raise CliError(f"report template has duplicate section_id: {section_id}")
        section_ids.add(section_id)
        require_string(section, "heading", f"report template sections[{index}]")
        if not isinstance(section.get("claims_required"), bool):
            raise CliError("report template section claims_required must be a boolean")
        normalized_sections.append(
            {
                "section_id": section_id,
                "heading": section["heading"],
                "claims_required": section["claims_required"],
            }
        )
    normalized: dict[str, Any] = {
        "template_id": template_id,
        "title": template["title"],
        "description": template["description"],
        "sections": normalized_sections,
    }
    draft_prompt = template.get("draft_prompt", "draft.v1.md")
    if not isinstance(draft_prompt, str) or not draft_prompt.strip():
        raise CliError("report template draft_prompt must be a non-empty string when set")
    if not (root / "prompts" / draft_prompt).is_file():
        raise CliError(f"report template draft_prompt is missing: {draft_prompt}")
    normalized["draft_prompt"] = draft_prompt
    require_full = template.get("require_full_claim_coverage", False)
    if not isinstance(require_full, bool):
        raise CliError("report template require_full_claim_coverage must be a boolean when set")
    normalized["require_full_claim_coverage"] = require_full
    return normalized


def list_templates(root: Path) -> list[dict[str, str]]:
    templates: list[dict[str, str]] = []
    for path in sorted((root / "templates").glob("*.v1.json")):
        template_id = path.name.removesuffix(".v1.json")
        template = load_template(root, template_id)
        templates.append(
            {
                "template_id": template_id,
                "title": template["title"],
                "description": template["description"],
            }
        )
    return templates


def validate_framework(framework: dict[str, Any], claim_ids: set[str], label: str) -> dict[str, Any]:
    require_string(framework, "title", label)
    stages = require_list(framework, "stages", label)
    stage_ids: set[str] = set()
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
        for field in ("title", "explanation", "transition"):
            require_string(stage, field, stage_label)
        stage_claim_ids = require_string_list(stage.get("claim_ids"), f"{stage_label} claim_ids")
        if not stage_claim_ids:
            raise CliError(f"{stage_label} must bind at least one claim_id")
        unknown = set(stage_claim_ids) - claim_ids
        if unknown:
            raise CliError(f"{stage_label} references unknown claim IDs: {', '.join(sorted(unknown))}")
        normalized_stages.append(
            {
                "stage_id": stage_id,
                "sequence": expected_sequence,
                "title": stage["title"],
                "explanation": stage["explanation"],
                "transition": stage["transition"],
                "claim_ids": stage_claim_ids,
            }
        )
    return {"title": framework["title"], "stages": normalized_stages}


def validate_analysis_output(output: dict[str, Any]) -> dict[str, Any]:
    if output.get("schema_version") != ANALYSIS_OUTPUT_SCHEMA:
        raise CliError(f"analysis output must use schema_version {ANALYSIS_OUTPUT_SCHEMA}")
    if output.get("status") != "final":
        raise CliError("analysis output status must be final")
    for field in ("analysis_id", "analysis_kind"):
        require_string(output, field, "analysis output")
    task = require_object(output, "analysis_context", "analysis output")
    for field in ("question", "decision_context", "audience"):
        require_string(task, field, "analysis output task")
    copy_prompt_fields(task)
    snapshot = require_object(output, "collection_snapshot", "analysis output")
    for field in ("snapshot_id", "sha256"):
        require_string(snapshot, field, "analysis output collection_snapshot")
    judgments = require_list(output, "judgments", "analysis output")
    claim_ids: set[str] = set()
    for index, claim in enumerate(judgments, start=1):
        if not isinstance(claim, dict):
            raise CliError(f"analysis output judgments[{index}] must be an object")
        label = f"analysis output judgments[{index}]"
        claim_id = require_string(claim, "claim_id", label)
        if claim_id in claim_ids:
            raise CliError(f"analysis output has duplicate claim_id: {claim_id}")
        claim_ids.add(claim_id)
        for field in ("title", "statement", "classification", "status"):
            require_string(claim, field, label)
        confidence = claim.get("confidence")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
            raise CliError(f"{label} confidence must be a number between 0 and 1")
        review = require_object(claim, "review_decision", label)
        if review.get("status") not in {"approved", "not_required"}:
            raise CliError(f"{label} has a non-publishable review status")
        evidence = require_list(claim, "evidence", label)
        if not evidence:
            raise CliError(f"{label} must include evidence")
        for evidence_index, item in enumerate(evidence, start=1):
            if not isinstance(item, dict):
                raise CliError(f"{label} evidence[{evidence_index}] must be an object")
            for field in ("source_url", "quote", "clue_id", "observation_id"):
                require_string(item, field, f"{label} evidence[{evidence_index}]")
        require_string_list(claim.get("limitations"), f"{label} limitations")
    require_string_list(output.get("unresolved"), "analysis output unresolved")
    require_list(output, "rejected_claims", "analysis output")
    normalized = deepcopy(output)
    if "framework" in output:
        normalized["framework"] = validate_framework(
            require_object(output, "framework", "analysis output"),
            claim_ids,
            "analysis output framework",
        )
    return normalized


def choose_template(root: Path, output: dict[str, Any], requested: str) -> dict[str, Any]:
    if requested != "auto":
        return load_template(root, requested)
    if output.get("analysis_kind") == "literature-review":
        return load_template(root, "literature-report")
    if output.get("analysis_kind") == "ad-content-review":
        return load_template(root, "ad-content-report")
    framework = output.get("framework")
    if isinstance(framework, dict) and len(framework.get("stages", [])) >= 2:
        return load_template(root, "system-framework")
    if output["unresolved"] or any(
        claim["classification"] in {"contradictory", "uncertain"}
        or claim["status"] != "supported"
        for claim in output["judgments"]
    ):
        return load_template(root, "risk-brief")
    audience = output["analysis_context"]["audience"].casefold()
    if "management" in audience or "manager" in audience or "管理" in output["analysis_context"]["audience"]:
        return load_template(root, "decision-memo")
    return load_template(root, "intelligence-report")


def draft_prompt_name(report_input: dict[str, Any]) -> str:
    template = report_input.get("template") or {}
    name = template.get("draft_prompt") or "draft.v1.md"
    if not isinstance(name, str) or not name.strip():
        return "draft.v1.md"
    return name


def section_claim_ids(section: dict[str, Any]) -> list[str]:
    """Collect claim_ids from a section node and nested subsections (any depth)."""
    ids = list(section.get("claim_ids") or [])
    for subsection in section.get("subsections") or []:
        if isinstance(subsection, dict):
            ids.extend(section_claim_ids(subsection))
    return ids


def extract_inline_claim_ids(text: str) -> list[str]:
    found: list[str] = []
    for match in INLINE_CLAIM_CITE_RE.finditer(text or ""):
        for claim_id in match.group(1).split(";"):
            claim_id = claim_id.strip()
            if claim_id:
                found.append(claim_id)
    return found


def collect_node_prose(node: dict[str, Any]) -> list[str]:
    chunks: list[str] = []
    for paragraph in node.get("paragraphs") or []:
        if isinstance(paragraph, str):
            chunks.append(paragraph)
    for child in node.get("subsections") or []:
        if isinstance(child, dict):
            chunks.extend(collect_node_prose(child))
    return chunks


def collect_draft_prose(draft: dict[str, Any]) -> str:
    chunks: list[str] = []
    for section in draft.get("sections") or []:
        if not isinstance(section, dict):
            continue
        chunks.extend(collect_node_prose(section))
    return "\n".join(chunk for chunk in chunks if isinstance(chunk, str))


def claim_reference_ids(
    claim_id: str,
    claims: dict[str, dict[str, Any]],
    reference_by_url: dict[str, str],
) -> list[str]:
    claim = claims.get(claim_id)
    if not claim:
        return []
    ref_ids: list[str] = []
    for evidence in claim.get("evidence") or []:
        if not isinstance(evidence, dict):
            continue
        reference_id = reference_by_url.get(evidence.get("source_url", ""))
        if reference_id and reference_id not in ref_ids:
            ref_ids.append(reference_id)
    return ref_ids


def references_for_claim_ids(
    claim_ids: list[str],
    claims: dict[str, dict[str, Any]],
    reference_by_url: dict[str, str],
) -> list[str]:
    ref_ids: list[str] = []
    for claim_id in claim_ids:
        for reference_id in claim_reference_ids(claim_id, claims, reference_by_url):
            if reference_id not in ref_ids:
                ref_ids.append(reference_id)
    return ref_ids


def is_literature_template(report_input: dict[str, Any]) -> bool:
    template_id = (report_input.get("template") or {}).get("template_id")
    return template_id in LITERATURE_TEMPLATE_IDS


def allows_empty_evidence_report(report_input: dict[str, Any]) -> bool:
    """Allow a literature report to document a valid zero-result search."""
    return (
        is_literature_template(report_input)
        and not report_input.get("evidence_registry")
        and not report_input.get("references")
    )


def build_empty_evidence_draft(report_input: dict[str, Any]) -> dict[str, Any]:
    """Build a truthful report when collection returned no usable evidence."""
    no_findings = (
        "The collection produced no bibliographic references for this review. "
        "No evidence-bound findings are asserted."
    )
    sections: list[dict[str, Any]] = []
    for template_section in report_input["template"]["sections"]:
        section_id = template_section["section_id"]
        if section_id == "question":
            paragraphs = [
                report_input["question"],
                f"Decision context: {report_input['decision_context']}",
            ]
        elif section_id == "search_scope":
            paragraphs = [
                "The search completed without producing a bibliographic record "
                "that could be carried into evidence analysis.",
            ]
        else:
            paragraphs = [no_findings]
        sections.append(
            {
                "section_id": section_id,
                "paragraphs": paragraphs,
                "claim_ids": [],
                "subsections": [],
            }
        )
    return {
        "schema_version": DRAFT_SCHEMA,
        "report_id": report_input["report_id"],
        "template_id": report_input["template"]["template_id"],
        "title": "Literature Review",
        "sections": sections,
        "limitations": list(report_input["allowed_limitations"]),
    }


def render_prose_with_inline_cites(
    paragraph: str,
    claims: dict[str, dict[str, Any]],
    reference_by_url: dict[str, str],
    references_by_id: dict[str, dict[str, Any]],
    *,
    fmt: str,
) -> str:
    """Expand [@claim-id] markers into in-sentence citations; escape surrounding text."""

    def citation_token(claim_ids: list[str]) -> str:
        ref_ids = references_for_claim_ids(claim_ids, claims, reference_by_url)
        if not ref_ids:
            return ""
        if fmt == "latex":
            return r"\cite{" + ",".join(ref_ids) + "}"
        labels: list[str] = []
        for reference_id in ref_ids:
            reference = references_by_id.get(reference_id, {})
            authors = reference.get("authors") or []
            if authors:
                family = str(authors[0]).split()[-1]
                label = f"{family} et al." if len(authors) > 1 else family
            else:
                title = str(reference.get("title") or reference_id)
                label = title[:40] + ("…" if len(title) > 40 else "")
            year = reference.get("year")
            labels.append(f"{label}, {year}" if year else label)
        return "(" + "; ".join(labels) + ")"

    pieces: list[str] = []
    cursor = 0
    for match in INLINE_CLAIM_CITE_RE.finditer(paragraph):
        prefix = paragraph[cursor : match.start()]
        pieces.append(latex_escape(prefix) if fmt == "latex" else prefix)
        claim_ids = [part.strip() for part in match.group(1).split(";") if part.strip()]
        pieces.append(citation_token(claim_ids))
        cursor = match.end()
    tail = paragraph[cursor:]
    pieces.append(latex_escape(tail) if fmt == "latex" else tail)
    return "".join(pieces)


def normalize_subsections(
    raw: Any,
    label: str,
    available_claims: set[str],
    rejected: set[str],
    *,
    depth: int = 1,
    max_depth: int = 2,
) -> list[dict[str, Any]]:
    """Normalize nested subsection trees.

    depth=1 is LaTeX \\subsection; depth=2 is \\subsubsection. Deeper nesting is
    rejected so literature findings stay section → subsection → subsubsection.
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise CliError(f"{label} subsections must be an array")
    if not raw:
        return []
    if depth > max_depth:
        raise CliError(f"{label} subsections nest deeper than {max_depth} levels")
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            raise CliError(f"{label} subsections[{index}] must be an object")
        item_label = f"{label} subsections[{index}]"
        heading = require_string(item, "heading", item_label)
        raw_paragraphs = item.get("paragraphs")
        if raw_paragraphs is None:
            raw_paragraphs = []
        paragraphs = require_string_list(raw_paragraphs, f"{item_label} paragraphs")
        raw_claim_ids = item.get("claim_ids")
        if raw_claim_ids is None:
            raw_claim_ids = []
        claim_ids = require_string_list(raw_claim_ids, f"{item_label} claim_ids")
        if len(set(claim_ids)) != len(claim_ids):
            raise CliError(f"{item_label} has duplicate claim_ids")
        unknown = set(claim_ids) - available_claims
        if unknown:
            raise CliError(f"{item_label} references unknown claim IDs: {', '.join(sorted(unknown))}")
        forbidden = set(claim_ids) & rejected
        if forbidden:
            raise CliError(f"{item_label} references rejected claim IDs: {', '.join(sorted(forbidden))}")
        children = normalize_subsections(
            item.get("subsections"),
            item_label,
            available_claims,
            rejected,
            depth=depth + 1,
            max_depth=max_depth,
        )
        if not paragraphs and not children:
            raise CliError(f"{item_label} must include a paragraph or nested subsection")
        normalized.append(
            {
                "heading": heading,
                "paragraphs": paragraphs,
                "claim_ids": claim_ids,
                "subsections": children,
            }
        )
    return normalized


def unique_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def render_evidence_quote(quote: str) -> str:
    """Make source text readable without altering the evidence artifact.

    Collection metadata can contain JATS/XML markup.  The canonical quote stays
    untouched in the input and frozen analysis artifacts; this helper applies
    only to the human-facing Markdown renderer.
    """
    plain_text = re.sub(r"<[^>]+>", " ", quote)
    plain_text = " ".join(plain_text.split())
    if len(plain_text) <= MAX_RENDERED_EVIDENCE_CHARS:
        return plain_text
    return f"{plain_text[:MAX_RENDERED_EVIDENCE_CHARS - 1].rstrip()}…"


def bibliographic_reference(evidence: dict[str, Any]) -> dict[str, Any]:
    """Normalize source metadata into a stable, deduplicated citation record."""
    metadata = evidence.get("source_metadata", {})
    if not isinstance(metadata, dict):
        metadata = {}
    title_value = metadata.get("title", evidence["source_url"])
    title = title_value if isinstance(title_value, str) else next(
        (item for item in title_value if isinstance(item, str) and item.strip()),
        evidence["source_url"],
    ) if isinstance(title_value, list) else evidence["source_url"]
    authors = metadata.get("author", metadata.get("authors", []))
    if isinstance(authors, list):
        names = [
            " ".join(part for part in (item.get("given"), item.get("family")) if isinstance(part, str) and part)
            if isinstance(item, dict) else item
            for item in authors
        ]
        names = [name for name in names if isinstance(name, str) and name.strip()]
    else:
        names = []
    year = metadata.get("year")
    if not isinstance(year, int):
        for field in ("published-print", "published-online", "issued"):
            date_parts = metadata.get(field, {}).get("date-parts", []) if isinstance(metadata.get(field), dict) else []
            if date_parts and isinstance(date_parts[0], list) and date_parts[0] and isinstance(date_parts[0][0], int):
                year = date_parts[0][0]
                break
    venue_value = metadata.get("container-title", metadata.get("conference", ""))
    venue = venue_value if isinstance(venue_value, str) else next((item for item in venue_value if isinstance(item, str)), "") if isinstance(venue_value, list) else ""
    doi = metadata.get("DOI", metadata.get("doi", ""))
    doi = doi.removeprefix("https://doi.org/") if isinstance(doi, str) else ""
    reference_id = "ref-" + hashlib.sha256(evidence["source_url"].encode("utf-8")).hexdigest()[:16]
    return {"reference_id": reference_id, "title": title, "authors": names, "year": year, "venue": venue, "doi": doi, "url": evidence["source_url"]}


CLAIM_FILTER_SCHEMA = "clue.report-writing.claim-filter.v1"


def load_claim_filter(path: Path | None) -> dict[str, Any] | None:
    """Load an optional claim filter document used at prepare time."""
    if path is None:
        return None
    document = read_json(path, "claim filter")
    if document.get("schema_version") != CLAIM_FILTER_SCHEMA:
        raise CliError(f"claim filter must use schema_version {CLAIM_FILTER_SCHEMA}")
    mode = document.get("mode")
    if mode not in {"exclude", "include"}:
        raise CliError("claim filter mode must be exclude or include")
    rules = document.get("rules")
    if not isinstance(rules, list) or not rules:
        raise CliError("claim filter requires a non-empty rules array")
    normalized_rules: list[dict[str, Any]] = []
    for index, rule in enumerate(rules, start=1):
        if not isinstance(rule, dict):
            raise CliError(f"claim filter rules[{index}] must be an object")
        rule_id = rule.get("id")
        if not isinstance(rule_id, str) or not rule_id.strip():
            raise CliError(f"claim filter rules[{index}].id is required")
        patterns = rule.get("patterns")
        if not isinstance(patterns, list) or not patterns:
            raise CliError(f"claim filter rules[{index}].patterns must be a non-empty array")
        compiled: list[re.Pattern[str]] = []
        for pattern_index, pattern in enumerate(patterns, start=1):
            if not isinstance(pattern, str) or not pattern.strip():
                raise CliError(
                    f"claim filter rules[{index}].patterns[{pattern_index}] must be a non-empty string"
                )
            try:
                compiled.append(re.compile(pattern, re.IGNORECASE | re.DOTALL))
            except re.error as error:
                raise CliError(
                    f"claim filter rules[{index}].patterns[{pattern_index}] is invalid regex: {error}"
                ) from error
        normalized_rules.append(
            {
                "id": rule_id.strip(),
                "description": rule.get("description") if isinstance(rule.get("description"), str) else "",
                "patterns": [pattern.pattern for pattern in compiled],
                "_compiled": compiled,
            }
        )
    fields = document.get("fields")
    if fields is None:
        field_list = ["title", "statement"]
    else:
        if not isinstance(fields, list) or not all(isinstance(item, str) and item.strip() for item in fields):
            raise CliError("claim filter fields must be an array of non-empty strings")
        field_list = [item.strip() for item in fields]
    return {
        "schema_version": CLAIM_FILTER_SCHEMA,
        "mode": mode,
        "fields": field_list,
        "rules": normalized_rules,
        "question": document.get("question") if isinstance(document.get("question"), str) else None,
        "decision_context": (
            document.get("decision_context")
            if isinstance(document.get("decision_context"), str)
            else None
        ),
        "note": document.get("note") if isinstance(document.get("note"), str) else None,
    }


def claim_matches_filter_rules(
    claim: dict[str, Any],
    *,
    fields: list[str],
    rules: list[dict[str, Any]],
) -> str | None:
    """Return the first matching rule id, or None if no rule matches."""
    pieces: list[str] = []
    for field in fields:
        value = claim.get(field)
        if isinstance(value, str) and value.strip():
            pieces.append(value)
        elif isinstance(value, list):
            pieces.extend(str(item) for item in value if isinstance(item, str) and item.strip())
    haystack = "\n".join(pieces)
    if not haystack.strip():
        return None
    for rule in rules:
        for pattern in rule["_compiled"]:
            if pattern.search(haystack):
                return str(rule["id"])
    return None


def apply_claim_filter(
    analysis_output: dict[str, Any],
    claim_filter: dict[str, Any] | None,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Return (possibly filtered analysis output, filter provenance)."""
    if claim_filter is None:
        return analysis_output, None
    output = deepcopy(analysis_output)
    judgments = list(output.get("judgments") or [])
    mode = claim_filter["mode"]
    kept: list[dict[str, Any]] = []
    removed: list[dict[str, str]] = []
    by_rule: dict[str, int] = {}
    for claim in judgments:
        if not isinstance(claim, dict):
            continue
        rule_id = claim_matches_filter_rules(
            claim,
            fields=claim_filter["fields"],
            rules=claim_filter["rules"],
        )
        matched = rule_id is not None
        keep = (mode == "include" and matched) or (mode == "exclude" and not matched)
        if keep:
            kept.append(claim)
        else:
            claim_id = claim.get("claim_id") if isinstance(claim.get("claim_id"), str) else "unknown"
            removed.append(
                {
                    "claim_id": claim_id,
                    "rule_id": rule_id or ("unmatched" if mode == "include" else "unknown"),
                }
            )
            key = rule_id or ("unmatched" if mode == "include" else "unknown")
            by_rule[key] = by_rule.get(key, 0) + 1
    if not kept:
        raise CliError("claim filter removed every judgment; refine patterns or mode")
    output["judgments"] = kept
    # Drop framework if present — claim ids may no longer match.
    output.pop("framework", None)
    if claim_filter.get("question"):
        output.setdefault("analysis_context", {})
        if isinstance(output["analysis_context"], dict):
            output["analysis_context"]["question"] = claim_filter["question"]
    if claim_filter.get("decision_context"):
        output.setdefault("analysis_context", {})
        if isinstance(output["analysis_context"], dict):
            output["analysis_context"]["decision_context"] = claim_filter["decision_context"]
    provenance = {
        "schema_version": CLAIM_FILTER_SCHEMA,
        "mode": mode,
        "fields": claim_filter["fields"],
        "rules": [
            {
                "id": rule["id"],
                "description": rule.get("description") or "",
                "patterns": rule["patterns"],
            }
            for rule in claim_filter["rules"]
        ],
        "input_judgment_count": len(judgments),
        "kept_judgment_count": len(kept),
        "removed_judgment_count": len(removed),
        "removed_by_rule": by_rule,
        "removed_claim_ids": [item["claim_id"] for item in removed],
        "note": claim_filter.get("note"),
    }
    return output, provenance


def build_report_input(
    root: Path,
    analysis_output: dict[str, Any],
    requested_template: str,
    *,
    claim_filter: dict[str, Any] | None = None,
    report_id: str | None = None,
) -> dict[str, Any]:
    filtered_output, filter_provenance = apply_claim_filter(analysis_output, claim_filter)
    output = validate_analysis_output(filtered_output)
    template = choose_template(root, output, requested_template)
    registry: list[dict[str, Any]] = []
    references: dict[str, dict[str, Any]] = {}
    limitations = list(output["unresolved"])
    for claim in output["judgments"]:
        registry.append(
            {
                "claim_id": claim["claim_id"],
                "title": claim["title"],
                "statement": claim["statement"],
                "classification": claim["classification"],
                "status": claim["status"],
                "confidence": claim["confidence"],
                "evidence": [
                    {
                        key: item.get(key)
                        for key in ("source_url", "quote", "observed_at", "locator", "clue_id", "observation_id", "source_metadata")
                    }
                    for item in claim["evidence"]
                ],
                "limitations": claim["limitations"],
            }
        )
        for evidence in claim["evidence"]:
            reference = bibliographic_reference(evidence)
            references[reference["reference_id"]] = reference
        limitations.extend(claim["limitations"])
    source = {
        "analysis_output_id": output["analysis_id"],
        "analysis_output_sha256": object_digest(analysis_output),
        "case_id": output["analysis_id"],
        "snapshot_id": output["collection_snapshot"]["snapshot_id"],
        "snapshot_sha256": output["collection_snapshot"]["sha256"],
    }
    report_seed = {
        "source": source,
        "template_id": template["template_id"],
        "claim_filter": filter_provenance,
        "report_id": report_id.strip() if isinstance(report_id, str) else None,
    }
    resolved_report_id = (
        require_string({"report_id": report_id}, "report_id", "report input")
        if report_id is not None
        else f"report:{output['analysis_id']}:{template['template_id']}:{object_digest(report_seed).split(':', 1)[1][:16]}"
    )
    report_input = {
        "schema_version": INPUT_SCHEMA,
        "report_id": resolved_report_id,
        "prepared_at": utc_now(),
        "source": source,
        "question": output["analysis_context"]["question"],
        "decision_context": output["analysis_context"]["decision_context"],
        "audience": output["analysis_context"]["audience"],
        "template": template,
        "evidence_registry": registry,
        "references": list(references.values()),
        "search_scope": deepcopy(output.get("search_scope", {})),
        "allowed_limitations": unique_strings(limitations),
        "rejected_claim_ids": [
            claim.get("claim_id")
            for claim in output["rejected_claims"]
            if isinstance(claim, dict) and isinstance(claim.get("claim_id"), str)
        ],
        **{
            key: deepcopy(output["analysis_context"][key])
            for key in ("question_prompt", "decision_context_prompt", "audience_prompt")
            if key in output["analysis_context"]
        },
    }
    if filter_provenance is not None:
        report_input["claim_filter"] = filter_provenance
    if "framework" in output:
        report_input["framework"] = deepcopy(output["framework"])
    return report_input


def validate_report_input(document: dict[str, Any], root: Path) -> dict[str, Any]:
    if document.get("schema_version") != INPUT_SCHEMA:
        raise CliError(f"report input must use schema_version {INPUT_SCHEMA}")
    for field in ("report_id", "question", "decision_context", "audience"):
        require_string(document, field, "report input")
    copy_prompt_fields(document)
    source = require_object(document, "source", "report input")
    for field in ("analysis_output_id", "analysis_output_sha256", "case_id", "snapshot_id", "snapshot_sha256"):
        require_string(source, field, "report input source")
    template_document = require_object(document, "template", "report input")
    template_id = require_string(template_document, "template_id", "report input template")
    template = load_template(root, template_id)
    if canonical_json(template_document) != canonical_json(template):
        raise CliError("report input template differs from the installed template")
    registry = require_list(document, "evidence_registry", "report input")
    references = require_list(document, "references", "report input")
    for index, reference in enumerate(references, start=1):
        if not isinstance(reference, dict):
            raise CliError(f"report input references[{index}] must be an object")
        for field in ("reference_id", "title", "url"):
            require_string(reference, field, f"report input references[{index}]")
    claim_ids: set[str] = set()
    for index, claim in enumerate(registry, start=1):
        if not isinstance(claim, dict):
            raise CliError(f"report input evidence_registry[{index}] must be an object")
        label = f"report input evidence_registry[{index}]"
        claim_id = require_string(claim, "claim_id", label)
        if claim_id in claim_ids:
            raise CliError(f"report input has duplicate claim_id: {claim_id}")
        claim_ids.add(claim_id)
        for field in ("title", "statement", "classification", "status"):
            require_string(claim, field, label)
        confidence = claim.get("confidence")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
            raise CliError(f"{label} confidence must be a number between 0 and 1")
        evidence = require_list(claim, "evidence", label)
        if not evidence:
            raise CliError(f"{label} must include evidence")
        for evidence_index, item in enumerate(evidence, start=1):
            if not isinstance(item, dict):
                raise CliError(f"{label} evidence[{evidence_index}] must be an object")
            for field in ("source_url", "quote"):
                require_string(item, field, f"{label} evidence[{evidence_index}]")
        require_string_list(claim.get("limitations"), f"{label} limitations")
    require_string_list(document.get("allowed_limitations"), "report input allowed_limitations")
    rejected = document.get("rejected_claim_ids")
    if not isinstance(rejected, list) or not all(isinstance(item, str) for item in rejected):
        raise CliError("report input rejected_claim_ids must be an array of strings")
    normalized = deepcopy(document)
    if "framework" in document:
        normalized["framework"] = validate_framework(
            require_object(document, "framework", "report input"),
            claim_ids,
            "report input framework",
        )
    return normalized


def prompt(root: Path, name: str) -> str:
    path = root / "prompts" / name
    if not path.is_file():
        raise CliError(f"prompt is missing: {path}")
    return path.read_text(encoding="utf-8")


def model_request(system: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "executor": LOCAL_EXECUTOR,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False, indent=2)},
        ],
    }


def report_case_root(report_input_path: Path) -> Path:
    """Map .../<case>/inputs/*.json (or any case-relative path) to the case root."""
    path = report_input_path.expanduser().resolve()
    if path.parent.name == "inputs":
        return path.parent.parent
    return path.parent


def resolve_codex_session_path(
    *,
    run_dir: Path | str | None = None,
    report_input: Path | str | None = None,
    fallback_dir: Path | str | None = None,
) -> Path:
    """
    Prefer one stable session file per report case so regenerations resume the
    same Codex thread and benefit from prompt-cache hits on the large input.
    """
    env = (os.environ.get("REPORT_WRITING_CODEX_SESSION_PATH") or "").strip()
    if env:
        return Path(env).expanduser().resolve()
    if report_input is not None:
        case_root = report_case_root(Path(report_input))
        return (case_root / "runs" / "codex-session.json").resolve()
    if run_dir is not None:
        return (Path(run_dir).expanduser().resolve() / "codex-session.json")
    if fallback_dir is not None:
        return (Path(fallback_dir).expanduser().resolve() / "codex-session.json")
    raise CliError("cannot resolve Codex session path without report input or run-dir")


def load_codex_session_id(session_path: Path) -> str | None:
    if not session_path.is_file():
        return None
    try:
        value = read_json(session_path, "Codex session").get("session_id")
    except CliError:
        return None
    return value if isinstance(value, str) and value.strip() else None


def seed_codex_session_from_case(session_path: Path, report_input: Path | None) -> None:
    """If stable session is missing, adopt the newest prior run session under the case."""
    if session_path.is_file() or report_input is None:
        return
    case_root = report_case_root(report_input)
    runs = case_root / "runs"
    if not runs.is_dir():
        return
    candidates = sorted(
        runs.glob("**/codex-session.json"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for candidate in candidates:
        if candidate.resolve() == session_path.resolve():
            continue
        session_id = load_codex_session_id(candidate)
        if not session_id:
            continue
        session_path.parent.mkdir(parents=True, exist_ok=True)
        write_json(
            session_path,
            {
                "session_id": session_id,
                "seeded_from": str(candidate),
                "model": resolve_report_model(),
                "model_reasoning_effort": resolve_report_reasoning_effort(),
            },
        )
        return


def build_codex_exec_command(
    *,
    session_id: str | None,
    attachment_dirs: list[Path],
    model: str,
    reasoning_effort: str,
    response_path: Path,
) -> list[str]:
    command = [resolve_codex_executable(), "exec"]
    if session_id:
        # Resume the same thread so prior report-input context can hit cache.
        command.extend(["resume", session_id])
    command.extend(["--skip-git-repo-check", "--sandbox", "read-only"])
    # Grant only the snapshot dirs. Never add the live report workspace.
    for directory in sorted({path.resolve() for path in attachment_dirs}):
        command.extend(["--add-dir", str(directory)])
    command.extend(
        [
            "-m",
            model,
            "-c",
            f'model_reasoning_effort="{reasoning_effort}"',
            "--json",
            "--output-last-message",
            str(response_path),
            "-",
        ]
    )
    return command


def request_codex(
    request_payload: dict[str, Any],
    attachments: list[tuple[str, Path]],
    session_path: Path,
    *,
    model: str | None = None,
    reasoning_effort: str | None = None,
) -> dict[str, Any]:
    """Use one persistent local Codex session with immutable JSON attachments."""
    system = request_payload["messages"][0]["content"]
    resolved = [(label, path.expanduser().resolve()) for label, path in attachments]
    missing = [f"{label}: {path}" for label, path in resolved if not path.is_file()]
    if not resolved or missing:
        detail = "; ".join(missing) if missing else "no attachments provided"
        raise CliError(f"local Codex requires existing immutable JSON attachments ({detail})")
    resolved_model = (model or resolve_report_model()).strip() or DEFAULT_REPORT_MODEL
    resolved_effort = (
        (reasoning_effort or resolve_report_reasoning_effort()).strip()
        or DEFAULT_REPORT_REASONING_EFFORT
    )
    session_path = session_path.expanduser().resolve()
    session_id = load_codex_session_id(session_path)
    with tempfile.TemporaryDirectory(prefix="codex-report-attachments-") as snapshot_dir:
        snapshot_root = Path(snapshot_dir)
        snapshots: list[tuple[str, Path]] = []
        for index, (label, path) in enumerate(resolved):
            snapshot = snapshot_root / f"{index:02d}-{path.name}"
            shutil.copy2(path, snapshot)
            snapshots.append((label, snapshot))
        attachment_list = "\n".join(f"- {label}: {path}" for label, path in snapshots)
        prompt_text = (
            f"{system}\n\nRead only these immutable JSON attachments with read-only file commands:\n"
            f"{attachment_list}\n"
            "Do not browse or access other sources. Return exactly the required JSON object, with no prose."
        )
        attachment_dirs = [path.parent for _, path in snapshots]
        with tempfile.NamedTemporaryFile(prefix="codex-report-", suffix=".json", delete=False) as handle:
            response_path = Path(handle.name)
        try:
            resumed = bool(session_id)
            command = build_codex_exec_command(
                session_id=session_id,
                attachment_dirs=attachment_dirs,
                model=resolved_model,
                reasoning_effort=resolved_effort,
                response_path=response_path,
            )
            completed = subprocess.run(command, input=prompt_text, text=True, capture_output=True, check=False)
            # Stale session IDs: fall back to a fresh thread once.
            if completed.returncode != 0 and session_id:
                response_path.unlink(missing_ok=True)
                with tempfile.NamedTemporaryFile(
                    prefix="codex-report-", suffix=".json", delete=False
                ) as handle:
                    response_path = Path(handle.name)
                resumed = False
                session_id = None
                command = build_codex_exec_command(
                    session_id=None,
                    attachment_dirs=attachment_dirs,
                    model=resolved_model,
                    reasoning_effort=resolved_effort,
                    response_path=response_path,
                )
                completed = subprocess.run(
                    command, input=prompt_text, text=True, capture_output=True, check=False
                )
            if completed.returncode != 0 or not response_path.is_file():
                detail = (completed.stderr or completed.stdout or "").strip()
                raise CliError(
                    "local Codex report request failed"
                    + (f": {detail[:500]}" if detail else "")
                )
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
            write_json(
                session_path,
                {
                    "session_id": session_id,
                    "model": resolved_model,
                    "model_reasoning_effort": resolved_effort,
                    "resumed": resumed,
                    "updated_at": utc_now(),
                },
            )
            content = response_path.read_text(encoding="utf-8")
            return {
                "choices": [{"message": {"content": content}}],
                "model": resolved_model,
                "model_reasoning_effort": resolved_effort,
                "session_id": session_id,
                "session_resumed": resumed,
                "session_path": str(session_path),
            }
        finally:
            response_path.unlink(missing_ok=True)


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
        document = json.loads(content)
    except json.JSONDecodeError as error:
        raise CliError("local Codex message content is not a JSON object") from error
    if not isinstance(document, dict):
        raise CliError("local Codex message content must be a JSON object")
    return document


def validate_draft(draft: dict[str, Any], report_input: dict[str, Any], root: Path) -> dict[str, Any]:
    report_input = validate_report_input(report_input, root)
    if draft.get("schema_version") != DRAFT_SCHEMA:
        raise CliError(f"report draft must use schema_version {DRAFT_SCHEMA}")
    if draft.get("report_id") != report_input["report_id"]:
        raise CliError("report draft report_id does not match report input")
    if draft.get("template_id") != report_input["template"]["template_id"]:
        raise CliError("report draft template_id does not match report input")
    require_string(draft, "title", "report draft")
    sections = require_list(draft, "sections", "report draft")
    template_sections = report_input["template"]["sections"]
    expected_ids = [section["section_id"] for section in template_sections]
    actual_ids: list[str] = []
    available_claims = {claim["claim_id"] for claim in report_input["evidence_registry"]}
    rejected = set(report_input["rejected_claim_ids"])
    normalized_sections: list[dict[str, Any]] = []
    used_claim_ids: set[str] = set()
    for index, section in enumerate(sections, start=1):
        if not isinstance(section, dict):
            raise CliError(f"report draft sections[{index}] must be an object")
        label = f"report draft sections[{index}]"
        section_id = require_string(section, "section_id", label)
        actual_ids.append(section_id)
        raw_paragraphs = section.get("paragraphs")
        if raw_paragraphs is None:
            raw_paragraphs = []
        paragraphs = require_string_list(raw_paragraphs, f"{label} paragraphs")
        raw_claim_ids = section.get("claim_ids")
        if raw_claim_ids is None:
            raw_claim_ids = []
        claim_ids = require_string_list(raw_claim_ids, f"{label} claim_ids")
        if len(set(claim_ids)) != len(claim_ids):
            raise CliError(f"{label} has duplicate claim_ids")
        unknown = set(claim_ids) - available_claims
        if unknown:
            raise CliError(f"report draft references unknown claim IDs: {', '.join(sorted(unknown))}")
        forbidden = set(claim_ids) & rejected
        if forbidden:
            raise CliError(f"report draft references rejected claim IDs: {', '.join(sorted(forbidden))}")
        subsections = normalize_subsections(
            section.get("subsections"),
            label,
            available_claims,
            rejected,
        )
        if not paragraphs and not subsections:
            raise CliError(f"{label} must include a paragraph or subsection")
        normalized_section = {
            "section_id": section_id,
            "paragraphs": paragraphs,
            "claim_ids": claim_ids,
            "subsections": subsections,
        }
        used_claim_ids.update(section_claim_ids(normalized_section))
        normalized_sections.append(normalized_section)
    if actual_ids != expected_ids:
        raise CliError("report draft sections must match the selected template exactly and in order")
    empty_evidence = allows_empty_evidence_report(report_input)
    for section, template_section in zip(normalized_sections, template_sections, strict=True):
        if (
            template_section["claims_required"]
            and not section_claim_ids(section)
            and not empty_evidence
        ):
            raise CliError(f"report draft section requires claim IDs: {section['section_id']}")
    if report_input["template"].get("require_full_claim_coverage"):
        missing = available_claims - used_claim_ids
        if missing:
            raise CliError(
                "report draft must bind every evidence_registry claim_id at least once; "
                f"missing {len(missing)} claim(s), e.g. {', '.join(sorted(missing)[:8])}"
            )
    if is_literature_template(report_input) or report_input["template"].get(
        "require_full_claim_coverage"
    ):
        prose = collect_draft_prose({"sections": normalized_sections})
        inline_ids = set(extract_inline_claim_ids(prose))
        missing_inline = used_claim_ids - inline_ids
        if missing_inline:
            raise CliError(
                "literature draft must cite bound claims inline with [@claim-id] markers; "
                f"missing markers for {len(missing_inline)} claim(s), e.g. "
                f"{', '.join(sorted(missing_inline)[:8])}"
            )
        unknown_inline = inline_ids - available_claims
        if unknown_inline:
            raise CliError(
                "literature draft inline citations reference unknown claim IDs: "
                + ", ".join(sorted(unknown_inline)[:8])
            )
        for match in INLINE_CLAIM_CITE_RE.finditer(prose):
            cluster = [part.strip() for part in match.group(1).split(";") if part.strip()]
            if len(cluster) > MAX_CITE_CLUSTER_SIZE:
                raise CliError(
                    "literature draft has an oversized [@…] citation cluster "
                    f"({len(cluster)} ids, max {MAX_CITE_CLUSTER_SIZE}): "
                    f"{match.group(0)[:120]}"
                )
    limitations = require_string_list(draft.get("limitations"), "report draft limitations")
    if set(limitations) != set(report_input["allowed_limitations"]):
        raise CliError("report draft limitations must include exactly the allowed limitations")
    return {
        "schema_version": DRAFT_SCHEMA,
        "report_id": report_input["report_id"],
        "template_id": report_input["template"]["template_id"],
        "title": draft["title"],
        "sections": normalized_sections,
        "limitations": limitations,
    }


def validate_draft_document(draft: dict[str, Any], report_input: dict[str, Any], root: Path) -> dict[str, Any]:
    normalized = validate_draft(draft, report_input, root)
    provenance = draft.get("provenance")
    if provenance is not None:
        if not isinstance(provenance, dict):
            raise CliError("report draft provenance must be an object")
        if provenance.get("report_input_sha256") != object_digest(report_input):
            raise CliError("report draft does not belong to this exact report input")
        normalized["provenance"] = deepcopy(provenance)
    return normalized


def coerce_review_score(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        score = value
    elif isinstance(value, float) and value.is_integer():
        score = int(value)
    elif isinstance(value, str) and value.strip():
        try:
            parsed = float(value.strip())
        except ValueError:
            return None
        if not parsed.is_integer():
            return None
        score = int(parsed)
    else:
        return None
    if 1 <= score <= 10:
        return score
    return None


def fallback_review_issue(dimension: str, section_ids: set[str], problem: str) -> dict[str, str]:
    return {
        "section_id": next(iter(sorted(section_ids)), "findings"),
        "problem": problem,
        "suggested_fix": "Revise the lowest-scoring section until this dimension can pass without blocking issues.",
    }


def validate_review_item(item: dict[str, Any], dimension: str, section_ids: set[str]) -> dict[str, Any]:
    if item.get("dimension") != dimension:
        raise CliError(f"{dimension} reviewer output has the wrong dimension")
    score = coerce_review_score(item.get("score"))
    status = item.get("status")
    if status not in {"pass", "revise"}:
        status = "revise"
    issues = item.get("blocking_issues")
    if not isinstance(issues, list):
        issues = []
    normalized_issues: list[dict[str, str]] = []
    for index, issue in enumerate(issues, start=1):
        if not isinstance(issue, dict):
            continue
        try:
            section_id = require_string(issue, "section_id", f"{dimension} reviewer blocking_issues[{index}]")
            if section_id not in section_ids:
                continue
            normalized_issues.append(
                {
                    "section_id": section_id,
                    "problem": require_string(issue, "problem", f"{dimension} reviewer blocking_issues[{index}]"),
                    "suggested_fix": require_string(issue, "suggested_fix", f"{dimension} reviewer blocking_issues[{index}]"),
                }
            )
        except CliError:
            continue
    notes = require_string_list(item.get("notes") if isinstance(item.get("notes"), list) else [], f"{dimension} reviewer notes")
    if score is None:
        status = "revise"
        score = 1
        if not normalized_issues:
            normalized_issues.append(
                fallback_review_issue(
                    dimension,
                    section_ids,
                    f"{dimension} reviewer score was missing or not an integer from 1 to 10.",
                )
            )
    if status == "pass" and normalized_issues:
        status = "revise"
    elif status == "pass" and score < 8:
        # Status is authoritative when the reviewer listed no issues.
        # A low score without issues is a calibration error, not a publish blocker.
        notes = [
            *notes,
            f"{dimension} reviewer marked pass with score {score}; treating as pass because no blocking issues were listed.",
        ]
    if status == "revise" and not normalized_issues:
        normalized_issues.append(
            fallback_review_issue(
                dimension,
                section_ids,
                f"{dimension} reviewer marked revise without a usable blocking issue.",
            )
        )
    return {
        "dimension": dimension,
        "score": score,
        "status": status,
        "blocking_issues": normalized_issues,
        "notes": notes,
    }


def validate_reviews(reviews: dict[str, Any], report_input: dict[str, Any], draft: dict[str, Any], root: Path) -> dict[str, Any]:
    report_input = validate_report_input(report_input, root)
    draft = validate_draft_document(draft, report_input, root)
    if reviews.get("schema_version") != REVIEW_SCHEMA:
        raise CliError(f"report reviews must use schema_version {REVIEW_SCHEMA}")
    if reviews.get("report_id") != report_input["report_id"]:
        raise CliError("report reviews report_id does not match report input")
    if reviews.get("draft_sha256") != object_digest(draft):
        raise CliError("report reviews do not belong to this exact draft")
    items = require_list(reviews, "reviews", "report reviews")
    if len(items) != len(REVIEW_DIMENSIONS):
        raise CliError("report reviews must contain all four reviewer dimensions")
    section_ids = {section["section_id"] for section in report_input["template"]["sections"]}
    by_dimension: dict[str, dict[str, Any]] = {}
    for item in items:
        if not isinstance(item, dict):
            raise CliError("report reviews entries must be objects")
        dimension = item.get("dimension")
        if dimension not in REVIEW_DIMENSIONS or dimension in by_dimension:
            raise CliError("report reviews must contain each reviewer dimension exactly once")
        by_dimension[dimension] = validate_review_item(item, dimension, section_ids)
    return {
        "schema_version": REVIEW_SCHEMA,
        "report_id": report_input["report_id"],
        "draft_sha256": object_digest(draft),
        "generated_at": reviews.get("generated_at", utc_now()),
        "reviews": [by_dimension[dimension] for dimension in REVIEW_DIMENSIONS],
        "summary": {
            "pass_count": sum(1 for item in by_dimension.values() if item["status"] == "pass"),
            "revise_count": sum(1 for item in by_dimension.values() if item["status"] == "revise"),
        },
    }


def write_run_item(run_dir: Path | None, name: str, request: dict[str, Any], response: dict[str, Any], result: dict[str, Any]) -> None:
    if run_dir is None:
        return
    run_dir = run_dir.expanduser().resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    write_json(run_dir / f"{name}-request.json", request)
    write_json(run_dir / f"{name}-response.json", response)
    write_json(
        run_dir / f"{name}-manifest.json",
        {
            "schema_version": "clue.report-writing.run.v1",
            "tool": {"name": TOOL_NAME},
            "created_at": utc_now(),
            "request_sha256": object_digest(request),
            "response_sha256": object_digest(response),
            "result_sha256": object_digest(result),
        },
    )


def reference_year_value(reference: dict[str, Any]) -> int | None:
    """Publication year from a reference, or None if missing/invalid."""
    year = reference.get("year")
    if isinstance(year, bool):
        return None
    if isinstance(year, int):
        return year
    if isinstance(year, str) and year.strip().isdigit():
        return int(year.strip())
    return None


def reference_venue_label(reference: dict[str, Any], *, max_len: int = 40) -> str:
    """Short venue label for charts and tables."""
    venue = reference.get("venue")
    if not isinstance(venue, str) or not venue.strip():
        return "Unknown / not recorded"
    label = re.sub(r"\s+", " ", venue).strip()
    if len(label) > max_len:
        return label[: max_len - 1].rstrip() + "…"
    return label


def reference_year_counts(report_input: dict[str, Any]) -> list[tuple[int, int]]:
    """Sorted (year, count) pairs from report references."""
    counts: dict[int, int] = {}
    for reference in report_input.get("references") or []:
        if not isinstance(reference, dict):
            continue
        year = reference_year_value(reference)
        if year is None:
            continue
        counts[year] = counts.get(year, 0) + 1
    return sorted(counts.items())


def reference_venue_counts(
    report_input: dict[str, Any],
    *,
    top_n: int = 12,
) -> list[tuple[str, int]]:
    """Top venues by count; remainder collapsed into Other."""
    counts: dict[str, int] = {}
    for reference in report_input.get("references") or []:
        if not isinstance(reference, dict):
            continue
        label = reference_venue_label(reference)
        counts[label] = counts.get(label, 0) + 1
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    if len(ranked) <= top_n:
        return ranked
    head = ranked[:top_n]
    other = sum(count for _, count in ranked[top_n:])
    if other:
        head.append(("Other venues", other))
    return head


def reference_year_venue_matrix(
    report_input: dict[str, Any],
    *,
    top_venues: int = 7,
) -> tuple[list[int], list[str], dict[str, list[int]]]:
    """Year × venue counts for one stacked distribution chart.

    Returns (years, venue_labels, series) where series[venue][i] is the count
    for years[i]. Venues beyond top_venues are collapsed into Other venues.
    """
    raw: dict[tuple[int, str], int] = {}
    venue_totals: dict[str, int] = {}
    years_set: set[int] = set()
    for reference in report_input.get("references") or []:
        if not isinstance(reference, dict):
            continue
        year = reference_year_value(reference)
        if year is None:
            continue
        label = reference_venue_label(reference)
        years_set.add(year)
        raw[(year, label)] = raw.get((year, label), 0) + 1
        venue_totals[label] = venue_totals.get(label, 0) + 1
    if not years_set or not venue_totals:
        return [], [], {}

    years = sorted(years_set)
    ranked = sorted(venue_totals.items(), key=lambda item: (-item[1], item[0]))
    keep = [name for name, _ in ranked[:top_venues]]
    keep_set = set(keep)
    has_other = any(name not in keep_set for name in venue_totals)
    venue_labels = list(keep)
    if has_other:
        venue_labels.append("Other venues")

    series: dict[str, list[int]] = {name: [0] * len(years) for name in venue_labels}
    for (year, label), count in raw.items():
        bucket = label if label in keep_set else "Other venues"
        if bucket not in series:
            continue
        series[bucket][years.index(year)] += count
    return years, venue_labels, series


def search_scope_algorithm_paragraphs(report_input: dict[str, Any]) -> list[str]:
    """Dynamic intro: how the automatic literature-review pipeline scoped the corpus."""
    search_scope = report_input.get("search_scope") if isinstance(report_input.get("search_scope"), dict) else {}
    record_count = search_scope.get("record_count")
    if not isinstance(record_count, int):
        record_count = len(report_input.get("references") or [])
    claim_count = len(report_input.get("evidence_registry") or [])
    tasks = [task for task in (search_scope.get("source_tasks") or []) if isinstance(task, dict)]
    task_count = len(tasks)
    source_types = sorted({
        str(task.get("source_type") or "unknown")
        for task in tasks
    })
    scope = search_scope.get("scope") if isinstance(search_scope.get("scope"), dict) else {}
    time_range = scope.get("time_range") if isinstance(scope.get("time_range"), str) else None
    include = [item for item in (scope.get("include") or []) if isinstance(item, str) and item.strip()]
    years = reference_year_counts(report_input)
    year_span = (
        f"{years[0][0]}–{years[-1][0]}"
        if years
        else (time_range or "the configured window")
    )
    type_phrase = ", ".join(source_types) if source_types else "configured bibliographic sources"
    theme_phrase = "; ".join(include[:6]) if include else "the stated research themes"
    if include and len(include) > 6:
        theme_phrase += "; …"

    return [
        (
            "This review was produced by an automatic literature-review pipeline rather than a "
            "single free-form generation step. Data collection first assembled a frozen corpus; "
            "intelligence analysis then extracted evidence-bound claims; report writing finally "
            "compressed those claims into main arguments, planned subsections, and expanded the "
            "narrative with inline citations. The search-scope facts below describe only the "
            "collection stage that feeds analysis."
        ),
        (
            f"The frozen collection supplies {record_count} bibliographic records"
            + (f" spanning publication years {year_span}" if years or time_range else "")
            + f", drawn through {task_count} source task"
            + ("s" if task_count != 1 else "")
            + f" ({type_phrase}). "
            f"In-scope themes include {theme_phrase}. "
            f"After analysis, the report evidence registry holds {claim_count} approved claim"
            + ("s" if claim_count != 1 else "")
            + " bound to that corpus."
        ),
        (
            "Collection is intentionally conservative about recall and relevance: seed and expand "
            "filters, optional topic judgment, and PDF capture can drop or defer candidates. "
            "The digests and gaps recorded with the collection mark what this run can and cannot "
            f"claim. Re-run command: {search_scope.get('rerun_command') or 'not recorded'}."
        ),
    ]


def write_corpus_distribution_figures(
    report_input: dict[str, Any],
    figure_dir: Path,
) -> dict[str, str]:
    """Write one year×venue stacked chart (SVG + PDF for LaTeX).

    XeLaTeX cannot include SVG directly without extra tooling, so the SVG is
    the canonical vector artifact and a PDF twin is used for \\includegraphics.
    Returns basenames: distribution (PDF), and optionally distribution_svg.
    """
    years, venue_labels, series = reference_year_venue_matrix(report_input)
    if not years or not venue_labels:
        return {}

    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        return {}

    figure_dir = figure_dir.expanduser().resolve()
    figure_dir.mkdir(parents=True, exist_ok=True)
    written: dict[str, str] = {}

    # Distinct categorical palette; last slot reserved for "Other" greys if present.
    palette = [
        "#3b6ea5",
        "#5a8f6b",
        "#c47a3a",
        "#8b5a9e",
        "#c45c5c",
        "#4a9b9b",
        "#b08d3a",
        "#6b7280",
    ]
    x_labels = [str(year) for year in years]
    x_pos = list(range(len(years)))
    fig_width = max(6.4, 0.9 * len(years) + 3.2)
    fig, axis = plt.subplots(figsize=(fig_width, 4.2))
    bottoms = [0] * len(years)
    for index, venue in enumerate(venue_labels):
        values = series[venue]
        color = palette[index % len(palette)]
        if venue == "Other venues":
            color = "#9ca3af"
        axis.bar(
            x_pos,
            values,
            bottom=bottoms,
            width=0.68,
            label=venue,
            color=color,
            edgecolor="white",
            linewidth=0.4,
        )
        bottoms = [base + value for base, value in zip(bottoms, values)]
    axis.set_xticks(x_pos, x_labels)
    axis.set_xlabel("Publication year")
    axis.set_ylabel("Number of records")
    axis.set_title("Corpus distribution by year and venue")
    axis.spines["top"].set_visible(False)
    axis.spines["right"].set_visible(False)
    axis.legend(
        loc="upper left",
        bbox_to_anchor=(1.02, 1.0),
        frameon=False,
        fontsize=8,
        title="Venue",
    )
    fig.tight_layout()

    svg_name = "search-scope-distribution.svg"
    pdf_name = "search-scope-distribution.pdf"
    svg_path = figure_dir / svg_name
    pdf_path = figure_dir / pdf_name
    fig.savefig(svg_path, format="svg")
    written["distribution_svg"] = svg_name

    # Prefer CairoSVG for a clean PDF twin; fall back to matplotlib PDF.
    converted = False
    try:
        import cairosvg

        cairosvg.svg2pdf(url=str(svg_path), write_to=str(pdf_path))
        converted = pdf_path.is_file() and pdf_path.stat().st_size > 0
    except Exception:
        converted = False
    if not converted:
        fig.savefig(pdf_path, format="pdf")
    plt.close(fig)
    if pdf_path.is_file() and pdf_path.stat().st_size > 0:
        written["distribution"] = pdf_name
    return written


def markdown_search_scope_body(report_input: dict[str, Any]) -> list[str]:
    """Structured markdown for collection search scope / reproducibility."""
    search_scope = report_input.get("search_scope") if isinstance(report_input.get("search_scope"), dict) else {}
    lines: list[str] = []
    for paragraph in search_scope_algorithm_paragraphs(report_input):
        lines.extend([paragraph, ""])

    lines.extend(["### Paper distribution by year and venue", ""])
    years, venue_labels, series = reference_year_venue_matrix(report_input)
    if years and venue_labels:
        header = "| Year | " + " | ".join(venue_labels) + " | Total |"
        sep = "| --- | " + " | ".join([":---:"] * len(venue_labels)) + " | ---: |"
        lines.extend([header, sep])
        for index, year in enumerate(years):
            cells = [str(series[venue][index]) for venue in venue_labels]
            total = sum(series[venue][index] for venue in venue_labels)
            lines.append(f"| {year} | " + " | ".join(cells) + f" | {total} |")
        lines.append("")
    else:
        lines.extend(
            [
                "No publication-year/venue fields were available on the frozen references.",
                "",
            ]
        )

    lines.extend(["### Collection Information Gaps", ""])
    gaps = search_scope.get("information_gaps", [])
    if isinstance(gaps, list) and gaps:
        lines.extend(f"- {gap}" for gap in gaps if isinstance(gap, str))
        lines.append("")
    else:
        lines.extend(["- No collection information gaps were recorded for this run.", ""])

    digest_in = search_scope.get("collection_input_sha256", "unknown")
    digest_out = search_scope.get("collection_output_sha256", "unknown")
    lines.extend(
        [
            "### Collection digests",
            "",
            f"- Collection input SHA-256: `{digest_in}`",
            f"- Collection output SHA-256: `{digest_out}`",
            "",
        ]
    )
    return lines


def render_markdown(report_input: dict[str, Any], draft: dict[str, Any]) -> str:
    claims = {claim["claim_id"]: claim for claim in report_input["evidence_registry"]}
    reference_by_url = {
        reference["url"]: reference["reference_id"] for reference in report_input["references"]
    }
    references_by_id = {
        reference["reference_id"]: reference for reference in report_input["references"]
    }
    headings = {section["section_id"]: section["heading"] for section in report_input["template"]["sections"]}
    literature = is_literature_template(report_input)
    lines = [f"# {draft['title']}", ""]
    framework = report_input.get("framework")
    if isinstance(framework, dict) and framework.get("stages"):
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
    search_scope = report_input.get("search_scope", {})
    scope_in_template = template_has_section(report_input, "search_scope")
    if isinstance(search_scope, dict) and search_scope and not scope_in_template:
        lines.extend(["## Search Scope", ""])
        lines.extend(markdown_search_scope_body(report_input))

    def render_paragraph(paragraph: str) -> str:
        return render_prose_with_inline_cites(
            paragraph,
            claims,
            reference_by_url,
            references_by_id,
            fmt="markdown",
        )

    def append_claim_evidence(claim_id_list: list[str]) -> None:
        # Literature reports fuse citations into prose; no separate evidence dump.
        if literature or not claim_id_list:
            return
        lines.extend(["### Supporting Evidence", ""])
        for claim_id in claim_id_list:
            claim = claims[claim_id]
            lines.append(
                f"- `{claim_id}` · {claim['title']}: {claim['statement']} "
                f"(confidence {claim['confidence']})"
            )
            for evidence in claim["evidence"]:
                quote = render_evidence_quote(evidence["quote"])
                lines.append(f"  - <{evidence['source_url']}>: {quote}")
        lines.append("")

    for section in draft["sections"]:
        lines.extend([f"## {headings[section['section_id']]}", ""])
        if section["section_id"] == "search_scope" and isinstance(search_scope, dict) and search_scope:
            # Deterministic scope narrative + distribution tables (not free-form draft only).
            lines.extend(markdown_search_scope_body(report_input))
        else:
            for paragraph in section.get("paragraphs") or []:
                lines.extend([render_paragraph(paragraph), ""])
        append_claim_evidence(list(section.get("claim_ids") or []))
        def render_subsection_tree(node: dict[str, Any], level: int) -> None:
            # level 3 = ### subsection, level 4 = #### subsubsection
            marker = "#" * min(level, 6)
            lines.extend([f"{marker} {node['heading']}", ""])
            for paragraph in node.get("paragraphs") or []:
                lines.extend([render_paragraph(paragraph), ""])
            append_claim_evidence(list(node.get("claim_ids") or []))
            for child in node.get("subsections") or []:
                if isinstance(child, dict):
                    render_subsection_tree(child, level + 1)

        for subsection in section.get("subsections") or []:
            if isinstance(subsection, dict):
                render_subsection_tree(subsection, 3)
    show_limitations = template_has_section(report_input, "scope") or not literature
    if show_limitations:
        lines.extend(["## Known Limitations", ""])
        if draft["limitations"]:
            lines.extend(f"- {item}" for item in draft["limitations"])
        else:
            lines.append("- No additional limitations are recorded for this report.")
        lines.append("")
    return "\n".join(lines)


def markdown_to_html(markdown: str, title: str) -> str:
    """Render the constrained report Markdown to a self-contained print page."""
    body: list[str] = []
    in_list = False
    for line in markdown.splitlines():
        escaped = html.escape(line)
        if line.startswith("<!-- UNREVIEWED DRAFT:") and line.endswith("-->"):
            body.append(f"<p class=\"draft-notice\">{html.escape(line[4:-3].strip())}</p>")
        elif line.startswith("# "):
            body.append(f"<h1>{html.escape(line[2:])}</h1>")
        elif line.startswith("## "):
            body.append(f"<h2>{html.escape(line[3:])}</h2>")
        elif line.startswith("### "):
            body.append(f"<h3>{html.escape(line[4:])}</h3>")
        elif line.startswith("- "):
            if not in_list:
                body.append("<ul>")
                in_list = True
            body.append(f"<li>{html.escape(line[2:])}</li>")
        elif line.startswith("  - "):
            body.append(f"<li class=\"evidence\">{html.escape(line[4:])}</li>")
        else:
            if in_list:
                body.append("</ul>")
                in_list = False
            if line.strip():
                body.append(f"<p>{escaped}</p>")
    if in_list:
        body.append("</ul>")
    return """<!doctype html>
<html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>""" + html.escape(title) + """</title>
<style>@page{size:A4;margin:18mm}body{font-family:'Noto Sans CJK SC',sans-serif;line-height:1.55;color:#111;font-size:10.5pt}h1{font-size:22pt;border-bottom:2px solid #222;padding-bottom:8px}h2{font-size:15pt;margin-top:24px}h3{font-size:12pt;margin-top:16px}p{margin:8px 0}ul{padding-left:20px}.evidence{font-size:9pt;color:#333;overflow-wrap:anywhere}.draft-notice{border:1px solid #8a5a00;background:#fff5dd;padding:8px;font-weight:bold}</style>
</head><body>""" + "\n".join(body) + "</body></html>\n"


def latex_escape(value: str) -> str:
    value = re.sub(r"(?<![A-Za-z0-9])'([^'\n]+)'", r"``\1''", value)
    value = re.sub(r'"([^"\n]+)"', r"``\1''", value)
    value = re.sub(r"[‘’]([^‘’\n]+)[’]", r"``\1''", value)
    value = value.replace("“", "``").replace("”", "''")
    value = value.replace("„", "``").replace("‟", "''")
    value = value.replace("«", "``").replace("»", "''")
    value = value.replace("‘", "'").replace("’", "'")
    return value.replace("\\", r"\textbackslash{}").replace("&", r"\&").replace("%", r"\%").replace("$", r"\$").replace("#", r"\#").replace("_", r"\_").replace("{", r"\{").replace("}", r"\}").replace("~", r"\textasciitilde{}").replace("^", r"\textasciicircum{}")


def render_bib(references: list[dict[str, Any]]) -> str:
    entries = []
    for reference in references:
        fields = {"title": reference["title"], "url": reference["url"]}
        if reference.get("authors"):
            fields["author"] = " and ".join(reference["authors"])
        if reference.get("year"):
            fields["year"] = str(reference["year"])
        if reference.get("venue"):
            fields["booktitle"] = reference["venue"]
        if reference.get("doi"):
            fields["doi"] = reference["doi"]
        formatted = ",\n  ".join(f"{key} = {{{value}}}" for key, value in fields.items())
        entries.append(f"@misc{{{reference['reference_id']},\n  {formatted}\n}}")
    return "\n\n".join(entries) + "\n"


def template_has_section(report_input: dict[str, Any], section_id: str) -> bool:
    sections = (report_input.get("template") or {}).get("sections") or []
    return any(
        isinstance(section, dict) and section.get("section_id") == section_id
        for section in sections
    )


def latex_search_scope_body(
    report_input: dict[str, Any],
    *,
    figures: dict[str, str] | None = None,
) -> list[str]:
    """Structured LaTeX for collection search scope: algorithm intro, charts, gaps."""
    search_scope = report_input.get("search_scope") if isinstance(report_input.get("search_scope"), dict) else {}
    figures = figures or {}
    lines: list[str] = []
    for paragraph in search_scope_algorithm_paragraphs(report_input):
        lines.append(latex_escape(paragraph))

    lines.append(r"\subsection{Paper distribution by year and venue}")
    lines.append(
        latex_escape(
            "The stacked chart below shows how the frozen bibliographic references "
            "are distributed across publication year and venue (top venues; remainder "
            "as Other)."
        )
    )
    if figures.get("distribution"):
        lines.extend(
            [
                r"\begin{figure}[htbp]",
                r"\centering",
                r"\includegraphics[width=0.95\linewidth]{"
                + figures["distribution"]
                + r"}",
                r"\caption{Corpus records by publication year, stacked by venue.}",
                r"\end{figure}",
            ]
        )
    else:
        years, venue_labels, series = reference_year_venue_matrix(report_input)
        if years and venue_labels:
            lines.extend([r"\begin{itemize}"])
            for index, year in enumerate(years):
                parts = [
                    f"{venue} {series[venue][index]}"
                    for venue in venue_labels
                    if series[venue][index]
                ]
                total = sum(series[venue][index] for venue in venue_labels)
                lines.append(
                    r"\item "
                    + latex_escape(f"{year} ({total}): " + "; ".join(parts))
                )
            lines.append(r"\end{itemize}")
        else:
            lines.append(
                latex_escape(
                    "No publication-year/venue fields were available on the frozen references."
                )
            )

    lines.append(r"\subsection{Collection Information Gaps}")
    gaps = search_scope.get("information_gaps", [])
    if isinstance(gaps, list) and any(isinstance(gap, str) and gap.strip() for gap in gaps):
        lines.append(r"\begin{itemize}")
        lines.extend(
            r"\item " + latex_escape(gap)
            for gap in gaps
            if isinstance(gap, str) and gap.strip()
        )
        lines.append(r"\end{itemize}")
    else:
        lines.append(
            latex_escape("No collection information gaps were recorded for this run.")
        )

    lines.append(r"\subsection*{Collection digests}")
    lines.append(
        latex_escape(
            f"Collection input SHA-256: {search_scope.get('collection_input_sha256', 'unknown')}"
        )
    )
    lines.append(
        latex_escape(
            f"Collection output SHA-256: {search_scope.get('collection_output_sha256', 'unknown')}"
        )
    )
    return lines


def render_latex(
    report_input: dict[str, Any],
    draft: dict[str, Any],
    *,
    figure_dir: Path | None = None,
) -> str:
    claims = {claim["claim_id"]: claim for claim in report_input["evidence_registry"]}
    reference_by_url = {reference["url"]: reference["reference_id"] for reference in report_input["references"]}
    references_by_id = {
        reference["reference_id"]: reference for reference in report_input["references"]
    }
    headings = {section["section_id"]: section["heading"] for section in report_input["template"]["sections"]}
    literature = is_literature_template(report_input)
    figures: dict[str, str] = {}
    if figure_dir is not None and (
        template_has_section(report_input, "search_scope")
        or (isinstance(report_input.get("search_scope"), dict) and report_input.get("search_scope"))
    ):
        figures = write_corpus_distribution_figures(report_input, figure_dir)

    lines = [
        r"\documentclass[11pt]{article}",
        r"\usepackage{fontspec}",
        r"\usepackage{xeCJK}",
        r"\setmainfont{Noto Sans}",
        r"\setCJKmainfont{Noto Sans CJK SC}",
        r"\usepackage[margin=25mm]{geometry}",
        r"\usepackage{graphicx}",
        r"\usepackage{hyperref}",
        r"\hypersetup{colorlinks=true,urlcolor=blue}",
        r"\title{" + latex_escape(draft["title"]) + r"}",
        r"\date{}",
        r"\begin{document}",
        r"\maketitle",
    ]
    search_scope = report_input.get("search_scope", {})
    scope_in_template = template_has_section(report_input, "search_scope")
    # Templates without a search_scope section still get a structured appendix.
    if isinstance(search_scope, dict) and search_scope and not scope_in_template:
        lines.append(r"\section{Search Scope}")
        lines.extend(latex_search_scope_body(report_input, figures=figures))

    def render_paragraph(paragraph: str) -> str:
        return render_prose_with_inline_cites(
            paragraph,
            claims,
            reference_by_url,
            references_by_id,
            fmt="latex",
        )

    def append_citations(claim_id_list: list[str]) -> None:
        # Literature reports cite inside sentences; never emit Evidence: dumps.
        if literature or not claim_id_list:
            return
        cited = references_for_claim_ids(claim_id_list, claims, reference_by_url)
        if cited:
            lines.append(
                r"\par\noindent\textit{Evidence:} "
                + ", ".join(r"\cite{" + reference_id + "}" for reference_id in cited)
            )

    for section in draft["sections"]:
        lines.append(r"\section{" + latex_escape(headings[section["section_id"]]) + r"}")
        if section["section_id"] == "search_scope" and isinstance(search_scope, dict) and search_scope:
            # Deterministic algorithm intro, year/venue charts, and gaps.
            lines.extend(latex_search_scope_body(report_input, figures=figures))
        else:
            for paragraph in section.get("paragraphs") or []:
                lines.append(render_paragraph(paragraph))
        append_citations(list(section.get("claim_ids") or []))
        def render_subsection_tree(node: dict[str, Any], depth: int) -> None:
            # depth 1 = \subsection, depth 2 = \subsubsection
            command = r"\subsection" if depth <= 1 else r"\subsubsection"
            lines.append(command + "{" + latex_escape(node["heading"]) + r"}")
            for paragraph in node.get("paragraphs") or []:
                lines.append(render_paragraph(paragraph))
            append_citations(list(node.get("claim_ids") or []))
            for child in node.get("subsections") or []:
                if isinstance(child, dict):
                    render_subsection_tree(child, depth + 1)

        for subsection in section.get("subsections") or []:
            if isinstance(subsection, dict):
                render_subsection_tree(subsection, 1)
    show_limitations = template_has_section(report_input, "scope") or not literature
    if show_limitations:
        lines.extend([r"\section{Limitations}", r"\begin{itemize}"])
        lines.extend(r"\item " + latex_escape(item) for item in draft["limitations"])
        lines.append(r"\end{itemize}")
    lines.append(r"\begin{thebibliography}{99}")
    for reference in report_input["references"]:
        author = ", ".join(reference.get("authors", [])) or "Unknown author"
        year = str(reference["year"]) if reference.get("year") else "n.d."
        venue = f" {reference['venue']}." if reference.get("venue") else ""
        doi = f" DOI: {reference['doi']}." if reference.get("doi") else ""
        lines.append(r"\bibitem{" + reference["reference_id"] + r"}" + latex_escape(f"{author} ({year}). {reference['title']}.{venue}{doi} Available at: {reference['url']}"))
    lines.extend([r"\end{thebibliography}", r"\end{document}"])
    return "\n\n".join(lines) + "\n"


def command_templates(root: Path) -> int:
    print(json.dumps({"templates": list_templates(root)}, ensure_ascii=False, indent=2))
    return 0


def command_prepare(args: argparse.Namespace, root: Path) -> int:
    analysis_output = read_json(Path(args.analysis_output), "analysis output")
    claim_filter = load_claim_filter(
        Path(args.claim_filter).expanduser().resolve() if getattr(args, "claim_filter", None) else None
    )
    report_input = build_report_input(
        root,
        analysis_output,
        args.template,
        claim_filter=claim_filter,
        report_id=getattr(args, "report_id", None),
    )
    output = Path(args.output).expanduser().resolve()
    write_json(output, report_input)
    payload: dict[str, Any] = {
        "status": "succeeded",
        "output": str(output),
        "report_id": report_input["report_id"],
        "template_id": report_input["template"]["template_id"],
        "claim_count": len(report_input["evidence_registry"]),
    }
    if claim_filter is not None and isinstance(report_input.get("claim_filter"), dict):
        payload["claim_filter"] = {
            "mode": report_input["claim_filter"].get("mode"),
            "kept": report_input["claim_filter"].get("kept_judgment_count"),
            "removed": report_input["claim_filter"].get("removed_judgment_count"),
            "removed_by_rule": report_input["claim_filter"].get("removed_by_rule"),
        }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def normalize_draft_claim_ids(draft_response: dict[str, Any], available_claim_ids: set[str]) -> None:
    def normalize_node(node: dict[str, Any]) -> None:
        if isinstance(node.get("claim_ids"), list):
            node["claim_ids"] = [
                claim_id for claim_id in node["claim_ids"] if claim_id in available_claim_ids
            ]
        children = node.get("subsections")
        if not isinstance(children, list):
            return
        for child in children:
            if isinstance(child, dict):
                normalize_node(child)

    for section in draft_response.get("sections", []):
        if isinstance(section, dict):
            normalize_node(section)


def collect_bound_claim_ids(draft: dict[str, Any]) -> set[str]:
    bound: set[str] = set()
    prose = collect_draft_prose(draft)
    bound.update(extract_inline_claim_ids(prose))
    for section in draft.get("sections") or []:
        if not isinstance(section, dict):
            continue
        bound.update(section_claim_ids(section))
    return bound


def missing_claim_ids(draft: dict[str, Any], report_input: dict[str, Any]) -> list[str]:
    """Claims not yet present in both claim_ids arrays and inline [@claim-…] markers."""
    registry_ids = {claim["claim_id"] for claim in report_input["evidence_registry"]}
    array_ids: set[str] = set()
    for section in draft.get("sections") or []:
        if isinstance(section, dict):
            array_ids.update(section_claim_ids(section))
    prose_ids = set(extract_inline_claim_ids(collect_draft_prose(draft)))
    covered = array_ids & prose_ids
    return sorted(registry_ids - covered)


def needs_full_claim_coverage(report_input: dict[str, Any]) -> bool:
    return bool(
        is_literature_template(report_input)
        or report_input["template"].get("require_full_claim_coverage")
    )


def missing_claims_payload(
    report_input: dict[str, Any],
    missing_ids: list[str],
) -> list[dict[str, Any]]:
    """Compact claim cards for a resume fill-in turn (no hard-coded prose)."""
    registry = {
        claim["claim_id"]: claim for claim in report_input["evidence_registry"]
    }
    cards: list[dict[str, Any]] = []
    for claim_id in missing_ids:
        claim = registry.get(claim_id)
        if not claim:
            continue
        cards.append(
            {
                "claim_id": claim_id,
                "title": claim.get("title"),
                "statement": claim.get("statement"),
                "classification": claim.get("classification"),
                "status": claim.get("status"),
                "confidence": claim.get("confidence"),
            }
        )
    return cards


def normalize_model_draft(
    draft_response: dict[str, Any],
    report_input: dict[str, Any],
) -> dict[str, Any]:
    draft_response["report_id"] = report_input["report_id"]
    draft_response["template_id"] = report_input["template"]["template_id"]
    draft_response["limitations"] = report_input["allowed_limitations"]
    available = {claim["claim_id"] for claim in report_input["evidence_registry"]}
    normalize_draft_claim_ids(draft_response, available)
    return draft_response


def command_draft_legacy(args: argparse.Namespace, root: Path, report_input: dict[str, Any]) -> int:
    """One-shot draft path for non-literature templates."""
    prompt_name = draft_prompt_name(report_input)
    input_path = Path(args.input).expanduser().resolve()
    session_path = resolve_codex_session_path(
        run_dir=args.run_dir,
        report_input=input_path,
        fallback_dir=Path(args.output).expanduser().resolve().parent,
    )
    seed_codex_session_from_case(session_path, input_path)

    request = model_request(
        prompt(root, prompt_name),
        {
            "instruction": (
                "Return the required report draft JSON. Use only the attached report "
                "input. Bind claim IDs only where the template requires them."
            )
        },
    )
    response = request_codex(
        request,
        [("report input", input_path)],
        session_path,
    )
    draft_response = normalize_model_draft(extract_model_json(response), report_input)
    draft = validate_draft(draft_response, report_input, root)
    draft["provenance"] = {
        "report_input_sha256": object_digest(report_input),
        "prompt": prompt_name,
        "executor": LOCAL_EXECUTOR,
        "model": response.get("model") or resolve_report_model(),
        "model_reasoning_effort": response.get("model_reasoning_effort")
        or resolve_report_reasoning_effort(),
        "codex_session_path": response.get("session_path") or str(session_path),
        "codex_session_id": response.get("session_id"),
        "codex_session_resumed": response.get("session_resumed"),
        "pipeline": "one-shot",
        "coverage_fill_rounds": 0,
        "unused_claims_remaining": missing_claim_ids(draft, report_input),
    }
    output = Path(args.output).expanduser().resolve()
    write_json(output, draft)
    write_run_item(Path(args.run_dir) if args.run_dir else None, "draft", request, response, draft)
    print(
        json.dumps(
            {
                "status": "succeeded",
                "output": str(output),
                "section_count": len(draft["sections"]),
                "pipeline": "one-shot",
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def command_draft(args: argparse.Namespace, root: Path) -> int:
    report_input = read_json(Path(args.input), "report input")
    validate_report_input(report_input, root)
    output = Path(args.output).expanduser().resolve()
    run_dir = Path(args.run_dir).expanduser().resolve() if getattr(args, "run_dir", None) else None
    resume = True
    if getattr(args, "no_resume", False):
        resume = False

    if allows_empty_evidence_report(report_input):
        draft = validate_draft(
            build_empty_evidence_draft(report_input),
            report_input,
            root,
        )
        draft["provenance"] = {
            "report_input_sha256": object_digest(report_input),
            "pipeline": "empty-evidence",
            "unused_claims_remaining": [],
        }
        write_json(output, draft)
        print(
            json.dumps(
                {
                    "status": "succeeded",
                    "output": str(output),
                    "section_count": len(draft["sections"]),
                    "pipeline": "empty-evidence",
                    "reference_count": 0,
                    "claim_count": 0,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    # Literature / full-coverage templates use compress → outline → expand.
    if is_literature_template(report_input) or report_input["template"].get(
        "require_full_claim_coverage"
    ):
        # Late import: pipeline module depends on this file's helpers.
        import literature_pipeline

        draft = literature_pipeline.draft_literature(
            root,
            report_input,
            output_path=output,
            run_dir=run_dir,
            resume=resume,
        )
        write_json(output, draft)
        print(
            json.dumps(
                {
                    "status": "succeeded",
                    "output": str(output),
                    "section_count": len(draft["sections"]),
                    "pipeline": "compress-outline-expand",
                    "coverage_fill_rounds": (draft.get("provenance") or {}).get(
                        "coverage_fill_rounds", 0
                    ),
                    "unused_claims_remaining": len(
                        (draft.get("provenance") or {}).get("unused_claims_remaining") or []
                    ),
                    "pipeline_dir": str((output.parent / "pipeline").resolve()),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    return command_draft_legacy(args, root, report_input)


def command_review(args: argparse.Namespace, root: Path) -> int:
    report_input = read_json(Path(args.input), "report input")
    draft = read_json(Path(args.draft), "report draft")
    draft = validate_draft_document(draft, report_input, root)
    section_ids = [section["section_id"] for section in report_input["template"]["sections"]]
    input_path = Path(args.input).expanduser().resolve()
    session_path = resolve_codex_session_path(
        run_dir=args.run_dir,
        report_input=input_path,
        fallback_dir=Path(args.output).expanduser().resolve().parent,
    )
    seed_codex_session_from_case(session_path, input_path)
    review_items: list[dict[str, Any]] = []
    run_dir = Path(args.run_dir).expanduser().resolve() if getattr(args, "run_dir", None) else None
    draft_path = Path(args.draft).expanduser().resolve()
    draft_digest = object_digest(draft)
    cache_dir = run_dir / f"review-{draft_digest.split(':', 1)[-1][:16]}" if run_dir is not None else None
    for dimension in REVIEW_DIMENSIONS:
        prompt_name = f"review-{dimension.replace('_', '-')}.v1.md"
        request = model_request(
            prompt(root, prompt_name),
            {
                "instruction": "Review only the requested dimension and return the required review JSON.",
                "allowed_section_ids": section_ids,
            },
        )
        existing = cache_dir / f"{dimension}-response.json" if cache_dir is not None else None
        if existing is not None and existing.is_file():
            try:
                item = validate_review_item(
                    extract_model_json(read_json(existing, f"{dimension} review response")),
                    dimension,
                    set(section_ids),
                )
            except CliError:
                existing = None
            else:
                review_items.append(item)
                continue
        response = request_codex(
            request,
            [("report input", input_path), ("report draft", draft_path)],
            session_path,
        )
        item = validate_review_item(extract_model_json(response), dimension, set(section_ids))
        review_items.append(item)
        write_run_item(cache_dir, dimension, request, response, item)
    reviews = {
        "schema_version": REVIEW_SCHEMA,
        "report_id": report_input["report_id"],
        "draft_sha256": object_digest(draft),
        "generated_at": utc_now(),
        "reviews": review_items,
    }
    reviews = validate_reviews(reviews, report_input, draft, root)
    output = Path(args.output).expanduser().resolve()
    write_json(output, reviews)
    print(json.dumps({"status": "succeeded", "output": str(output), "summary": reviews["summary"]}, ensure_ascii=False, indent=2))
    return 0


def command_revise(args: argparse.Namespace, root: Path) -> int:
    report_input = read_json(Path(args.input), "report input")
    draft = read_json(Path(args.draft), "report draft")
    reviews = read_json(Path(args.reviews), "report reviews")
    draft = validate_draft_document(draft, report_input, root)
    reviews = validate_reviews(reviews, report_input, draft, root)
    prompt_name = draft_prompt_name(report_input)
    request = model_request(
        prompt(root, "revise.v1.md"),
        {
            "instruction": (
                "Return a revised report draft JSON that resolves the blocking reviewer issues. "
                f"Preserve the structure and coverage rules of {prompt_name}."
            ),
        },
    )
    input_path = Path(args.input).expanduser().resolve()
    session_path = resolve_codex_session_path(
        run_dir=args.run_dir,
        report_input=input_path,
        fallback_dir=Path(args.output).expanduser().resolve().parent,
    )
    seed_codex_session_from_case(session_path, input_path)
    response = request_codex(
        request,
        [
            ("report input", input_path),
            ("report draft", Path(args.draft)),
            ("report reviews", Path(args.reviews)),
        ],
        session_path,
    )
    revised_response = extract_model_json(response)
    revised_response["report_id"] = report_input["report_id"]
    revised_response["template_id"] = report_input["template"]["template_id"]
    revised_response["limitations"] = report_input["allowed_limitations"]
    revised_response = normalize_model_draft(revised_response, report_input)
    # Optional coverage fill on the same session after revise (model-authored only).
    coverage_rounds = 0
    while needs_full_claim_coverage(report_input) and coverage_rounds < 4:
        missing = missing_claim_ids(revised_response, report_input)
        if not missing:
            break
        coverage_rounds += 1
        interim_path = session_path.parent / f"revise-coverage-round-{coverage_rounds}.json"
        write_json(interim_path, revised_response)
        fill_request = model_request(
            prompt(root, prompt_name),
            {
                "instruction": (
                    "Continue the same literature-report draft. Return a complete "
                    "replacement draft JSON that keeps the existing long prose (do not "
                    "shorten it) and folds every unused claim into findings with "
                    "clause-level [@claim-id] markers."
                ),
                "unused_claim_ids": missing,
                "unused_claims": missing_claims_payload(report_input, missing),
                "unused_count": len(missing),
            },
        )
        response = request_codex(
            fill_request,
            [
                ("report input", input_path),
                ("current draft", interim_path),
            ],
            session_path,
        )
        revised_response = normalize_model_draft(extract_model_json(response), report_input)
    revised = validate_draft(revised_response, report_input, root)
    revised["provenance"] = {
        "report_input_sha256": object_digest(report_input),
        "prompt": "revise.v1.md",
        "draft_prompt": prompt_name,
        "executor": LOCAL_EXECUTOR,
        "model": response.get("model") or resolve_report_model(),
        "model_reasoning_effort": response.get("model_reasoning_effort")
        or resolve_report_reasoning_effort(),
        "codex_session_path": response.get("session_path") or str(session_path),
        "codex_session_id": response.get("session_id"),
        "codex_session_resumed": response.get("session_resumed"),
        "coverage_fill_rounds": coverage_rounds,
        "unused_claims_remaining": missing_claim_ids(revised, report_input),
        "revised_from_sha256": object_digest(draft),
        "reviews_sha256": object_digest(reviews),
    }
    output = Path(args.output).expanduser().resolve()
    write_json(output, revised)
    write_run_item(Path(args.run_dir) if args.run_dir else None, "revise", request, response, revised)
    print(json.dumps({"status": "succeeded", "output": str(output), "section_count": len(revised["sections"])}, ensure_ascii=False, indent=2))
    return 0


def command_publish(args: argparse.Namespace, root: Path) -> int:
    report_input = read_json(Path(args.input), "report input")
    draft = read_json(Path(args.draft), "report draft")
    reviews = read_json(Path(args.reviews), "report reviews")
    draft = validate_draft_document(draft, report_input, root)
    reviews = validate_reviews(reviews, report_input, draft, root)
    blocked = [item["dimension"] for item in reviews["reviews"] if item["status"] != "pass"]
    allow_residual = bool(getattr(args, "allow_residual", False))
    if blocked and not allow_residual:
        raise CliError(f"report cannot publish until reviewers pass: {', '.join(blocked)}")
    markdown_path = Path(args.output).expanduser().resolve()
    manifest_path = Path(args.manifest).expanduser().resolve()
    if markdown_path == manifest_path:
        raise CliError("--output and --manifest must be different paths")
    markdown = render_markdown(report_input, draft)
    report = {
        "schema_version": REPORT_SCHEMA,
        "report_id": report_input["report_id"],
        "status": "published",
        "published_at": utc_now(),
        "template_id": report_input["template"]["template_id"],
        "title": draft["title"],
        "source": deepcopy(report_input["source"]),
        "draft_sha256": object_digest(draft),
        "reviews_sha256": object_digest(reviews),
        "used_claim_ids": unique_strings(
            [claim_id for section in draft["sections"] for claim_id in section_claim_ids(section)]
        ),
        "limitations": deepcopy(draft["limitations"]),
        "report_path": str(markdown_path),
        "review": {
            "mode": "reviewed",
            "status": "residual" if blocked else "passed",
            "blocked_dimensions": blocked,
        },
    }
    write_text(markdown_path, markdown)
    write_json(manifest_path, report)
    print(json.dumps({"status": "succeeded", "output": str(markdown_path), "manifest": str(manifest_path), "claim_count": len(report["used_claim_ids"])}, ensure_ascii=False, indent=2))
    return 0


def write_fixed_report(
    report_input: dict[str, Any],
    draft: dict[str, Any],
    markdown_path: Path,
    manifest_path: Path,
) -> dict[str, Any]:
    """Write the fixed-mode report without implying that reviewers ran."""
    markdown_path = markdown_path.expanduser().resolve()
    manifest_path = manifest_path.expanduser().resolve()
    if markdown_path == manifest_path:
        raise CliError("fixed report Markdown and manifest must be different paths")
    markdown = render_markdown(report_input, draft)
    report = {
        "schema_version": REPORT_SCHEMA,
        "report_id": report_input["report_id"],
        "status": "published",
        "published_at": utc_now(),
        "template_id": report_input["template"]["template_id"],
        "title": draft["title"],
        "source": deepcopy(report_input["source"]),
        "draft_sha256": object_digest(draft),
        "used_claim_ids": unique_strings(
            [claim_id for section in draft["sections"] for claim_id in section_claim_ids(section)]
        ),
        "limitations": deepcopy(draft["limitations"]),
        "report_path": str(markdown_path),
        "review": {
            "mode": "fixed",
            "status": "not_run",
        },
    }
    write_text(markdown_path, markdown)
    write_json(manifest_path, report)
    return report


def command_preview(args: argparse.Namespace, root: Path) -> int:
    report_input = read_json(Path(args.input), "report input")
    draft = read_json(Path(args.draft), "report draft")
    draft = validate_draft_document(draft, report_input, root)
    output = Path(args.output).expanduser().resolve()
    write_text(output, "<!-- UNREVIEWED DRAFT: not a published report -->\n\n" + render_markdown(report_input, draft))
    print(json.dumps({"status": "preview", "output": str(output), "reviewed": False}, ensure_ascii=False, indent=2))
    return 0


MACOS_SYSTEM_APPS_DIR = Path("/Applications")
MACOS_BROWSER_APPS = (
    "Google Chrome.app/Contents/MacOS/Google Chrome",
    "Chromium.app/Contents/MacOS/Chromium",
)


def resolve_pdf_browser() -> str | None:
    """Find a Chrome/Chromium binary on PATH, then in the macOS app folders."""
    for candidate in (
        "chromium-headless-shell",
        "chromium",
        "google-chrome",
        "chromium-browser",
    ):
        if shutil.which(candidate):
            return candidate
    # macOS installs Chrome as an app bundle, not on PATH. Use the bundle
    # binary directly: a symlink to it breaks Chrome's framework lookup.
    for apps_dir in (MACOS_SYSTEM_APPS_DIR, Path.home() / "Applications"):
        for relative in MACOS_BROWSER_APPS:
            binary = apps_dir / relative
            if binary.is_file() and os.access(binary, os.X_OK):
                return str(binary)
    return None


def command_pdf(args: argparse.Namespace, root: Path) -> int:
    markdown_path = Path(args.markdown).expanduser().resolve()
    if not markdown_path.is_file():
        raise CliError(f"Markdown report does not exist: {markdown_path}")
    markdown = markdown_path.read_text(encoding="utf-8")
    title = next((line[2:] for line in markdown.splitlines() if line.startswith("# ")), "Report")
    html_path = Path(args.html_output).expanduser().resolve() if args.html_output else markdown_path.with_suffix(".html")
    pdf_path = Path(args.output).expanduser().resolve()
    html_path.parent.mkdir(parents=True, exist_ok=True)
    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    write_text(html_path, markdown_to_html(markdown, title))
    browser = args.browser or resolve_pdf_browser()
    if browser is None:
        raise CliError("Chrome or Chromium is required for PDF rendering")
    completed = subprocess.run(
        [browser, "--headless", "--no-sandbox", "--disable-gpu", f"--print-to-pdf={pdf_path}", html_path.as_uri()],
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0 or not pdf_path.is_file() or pdf_path.stat().st_size == 0:
        raise CliError(f"PDF rendering failed: {completed.stderr.strip() or completed.stdout.strip()}")
    print(json.dumps({"status": "succeeded", "output": str(pdf_path), "html": str(html_path)}, ensure_ascii=False, indent=2))
    return 0


def command_latex(args: argparse.Namespace, root: Path) -> int:
    report_input = validate_report_input(read_json(Path(args.input), "report input"), root)
    draft = validate_draft_document(read_json(Path(args.draft), "report draft"), report_input, root)
    tex_path = Path(args.tex).expanduser().resolve()
    bib_path = Path(args.bib).expanduser().resolve()
    pdf_path = Path(args.output).expanduser().resolve()
    # Figures sit beside the .tex so \includegraphics{basename} resolves when
    # xelatex runs with cwd = tex parent (output-directory alone is not enough).
    figure_dir = tex_path.parent
    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    figures = write_corpus_distribution_figures(report_input, figure_dir)
    write_text(tex_path, render_latex(report_input, draft, figure_dir=figure_dir))
    write_text(bib_path, render_bib(report_input["references"]))
    command = [
        "xelatex",
        "-interaction=nonstopmode",
        f"-output-directory={pdf_path.parent}",
        str(tex_path),
    ]
    # Two passes for TOC/refs; cwd must be the figure/tex directory.
    completed = subprocess.run(
        command, text=True, capture_output=True, check=False, cwd=str(figure_dir)
    )
    completed = subprocess.run(
        command, text=True, capture_output=True, check=False, cwd=str(figure_dir)
    )
    if not pdf_path.is_file() or pdf_path.stat().st_size == 0:
        raise CliError(
            f"XeLaTeX compilation failed (exit {completed.returncode}): "
            f"{(completed.stdout or completed.stderr)[-1000:]}"
        )
    print(
        json.dumps(
            {
                "status": "succeeded",
                "output": str(pdf_path),
                "tex": str(tex_path),
                "bib": str(bib_path),
                "reference_count": len(report_input["references"]),
                "figures": figures,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def command_run(args: argparse.Namespace, root: Path) -> int:
    """Run the fixed draft-to-report-and-LaTeX workflow as one operation."""
    pdf_path = Path(args.output).expanduser().resolve()
    markdown_path = Path(
        getattr(args, "report_markdown", None) or pdf_path.with_suffix(".md")
    ).expanduser().resolve()
    manifest_path = Path(
        getattr(args, "report_manifest", None) or pdf_path.with_suffix(".json")
    ).expanduser().resolve()
    report: dict[str, Any]
    with contextlib.redirect_stdout(io.StringIO()):
        command_prepare(
            argparse.Namespace(
                analysis_output=args.analysis_output,
                template=args.template,
                output=args.report_input,
                claim_filter=getattr(args, "claim_filter", None),
                report_id=getattr(args, "report_id", None),
            ),
            root,
        )
        command_draft(
            argparse.Namespace(
                input=args.report_input,
                output=args.draft,
                run_dir=args.run_dir,
            ),
            root,
        )
        command_latex(
            argparse.Namespace(
                input=args.report_input,
                draft=args.draft,
                tex=args.tex,
                bib=args.bib,
                output=args.output,
            ),
            root,
        )
        report_input = validate_report_input(read_json(Path(args.report_input), "report input"), root)
        draft = validate_draft_document(
            read_json(Path(args.draft), "report draft"),
            report_input,
            root,
        )
        report = write_fixed_report(report_input, draft, markdown_path, manifest_path)
    print(
        json.dumps(
            {
                "status": "succeeded",
                "report_input": str(Path(args.report_input).expanduser().resolve()),
                "draft": str(Path(args.draft).expanduser().resolve()),
                "tex": str(Path(args.tex).expanduser().resolve()),
                "bib": str(Path(args.bib).expanduser().resolve()),
                "output": str(Path(args.output).expanduser().resolve()),
                "report_markdown": str(markdown_path),
                "report_manifest": str(manifest_path),
                "review": report["review"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def workflow_request(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any], Path]:
    request = read_json(Path(args.input), "workflow input")
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


def workflow_report_root(workspace_root: Path) -> Path:
    root = workspace_root / "report"
    root.mkdir(parents=True, exist_ok=True)
    return root


def workflow_report_passed(reviews_path: Path) -> tuple[bool, int]:
    reviews = read_json(reviews_path, "report reviews")
    review_items = reviews.get("reviews")
    if not isinstance(review_items, list):
        raise CliError("report reviews has no reviews array")
    passed = all(
        isinstance(item, dict) and item.get("status") == "pass"
        for item in review_items
    )
    return passed, len(review_items)


def command_workflow(args: argparse.Namespace, root: Path) -> int:
    request, values, workspace_root = workflow_request(args)
    report_root = workflow_report_root(workspace_root)
    output = Path(args.output).expanduser().resolve()
    report_input = report_root / "report-input.json"
    draft = report_root / "draft.json"
    reviews = report_root / "reviews.json"
    markdown = report_root / "report.md"
    manifest = report_root / "report.json"
    pdf = report_root / "report.pdf"
    run_dir = report_root / "runs"

    if args.step_command == "prepare":
        analysis_output = workflow_string(values, "analysisOutputRef", args.step_command)
        template = workflow_string(values, "reportTemplate", args.step_command)
        run_id = workflow_string(request, "runId", "adapter")
        command_prepare(
            argparse.Namespace(
                analysis_output=analysis_output,
                template=template,
                output=str(report_input),
                report_id=f"report-{run_id}",
                claim_filter=None,
            ),
            root,
        )
        prepared = validate_report_input(read_json(report_input, "report input"), root)
        write_json(
            output,
            {
                "reportInputRef": str(report_input),
                "selectedTemplate": prepared["template"]["template_id"],
            },
        )
        return 0

    if args.step_command == "draft":
        report_input_ref = workflow_string(values, "reportInputRef", args.step_command)
        command_draft(
            argparse.Namespace(
                input=report_input_ref,
                output=str(draft),
                run_dir=str(run_dir),
                no_resume=False,
            ),
            root,
        )
        validate_draft_document(
            read_json(draft, "report draft"),
            read_json(Path(report_input_ref), "report input"),
            root,
        )
        write_json(output, {"draftRef": str(draft), "draftValid": True})
        return 0

    if args.step_command == "review":
        report_input_ref = workflow_string(values, "reportInputRef", args.step_command)
        draft_ref = workflow_string(values, "draftRef", args.step_command)
        command_review(
            argparse.Namespace(
                input=report_input_ref,
                draft=draft_ref,
                output=str(reviews),
                run_dir=str(run_dir),
            ),
            root,
        )
        passed, review_count = workflow_report_passed(reviews)
        write_json(
            output,
            {
                "reviewsRef": str(reviews),
                "reportPassed": passed,
                "reviewCount": review_count,
            },
        )
        return 0

    if args.step_command == "revise":
        report_input_ref = workflow_string(values, "reportInputRef", args.step_command)
        draft_ref = workflow_string(values, "draftRef", args.step_command)
        reviews_ref = workflow_string(values, "reviewsRef", args.step_command)
        command_revise(
            argparse.Namespace(
                input=report_input_ref,
                draft=draft_ref,
                reviews=reviews_ref,
                output=str(draft),
                run_dir=str(run_dir),
            ),
            root,
        )
        command_review(
            argparse.Namespace(
                input=report_input_ref,
                draft=str(draft),
                output=str(reviews),
                run_dir=str(run_dir),
            ),
            root,
        )
        passed, _ = workflow_report_passed(reviews)
        write_json(output, {"draftRef": str(draft), "reportPassed": passed})
        return 0

    if args.step_command == "publish":
        report_input_ref = workflow_string(values, "reportInputRef", args.step_command)
        draft_ref = workflow_string(values, "draftRef", args.step_command)
        reviews_ref = workflow_string(values, "reviewsRef", args.step_command)
        current_draft = read_json(Path(draft_ref), "report draft")
        current_reviews = (
            read_json(Path(reviews_ref), "report reviews")
            if Path(reviews_ref).expanduser().resolve().is_file()
            else {}
        )
        if current_reviews.get("draft_sha256") != object_digest(current_draft):
            command_review(
                argparse.Namespace(
                    input=report_input_ref,
                    draft=draft_ref,
                    output=str(reviews),
                    run_dir=str(run_dir),
                ),
                root,
            )
            reviews_ref = str(reviews)
        passed, _ = workflow_report_passed(Path(reviews_ref))
        if not passed:
            command_revise(
                argparse.Namespace(
                    input=report_input_ref,
                    draft=draft_ref,
                    reviews=reviews_ref,
                    output=str(draft),
                    run_dir=str(run_dir),
                ),
                root,
            )
            command_review(
                argparse.Namespace(
                    input=report_input_ref,
                    draft=str(draft),
                    output=str(reviews),
                    run_dir=str(run_dir),
                ),
                root,
            )
            reviews_ref = str(reviews)
            draft_ref = str(draft)
            passed, _ = workflow_report_passed(Path(reviews_ref))
        command_publish(
            argparse.Namespace(
                input=report_input_ref,
                draft=draft_ref,
                reviews=reviews_ref,
                output=str(markdown),
                manifest=str(manifest),
                allow_residual=not passed,
            ),
            root,
        )
        write_json(
            output,
            {"markdownRef": str(markdown), "manifestRef": str(manifest)},
        )
        return 0

    if args.step_command == "pdf":
        markdown_ref = workflow_string(values, "markdownRef", args.step_command)
        command_pdf(
            argparse.Namespace(
                markdown=markdown_ref,
                output=str(pdf),
                html_output=str(report_root / "report.html"),
                browser=None,
            ),
            root,
        )
        write_json(output, {"pdfRef": str(pdf)})
        return 0

    raise CliError(f"unsupported workflow command: {args.step_command}")


def add_codex_options(command: argparse.ArgumentParser) -> None:
    command.add_argument(
        "--run-dir",
        help=(
            "Optional audit directory for request/response manifests. "
            "Codex session is stored at <case>/runs/codex-session.json by default "
            "(or REPORT_WRITING_CODEX_SESSION_PATH) so regenerations resume the same thread."
        ),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=TOOL_NAME,
        description="Evidence-bound local-Codex report writing from final analysis output.",
    )
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("version", help="Print the tool and backend versions.")
    subcommands.add_parser("templates", help="List built-in report templates.")

    run = subcommands.add_parser(
        "run",
        help="Prepare, draft, and render a LaTeX PDF as one operation.",
    )
    run.add_argument("--analysis-output", required=True)
    run.add_argument("--template", default="auto")
    run.add_argument("--report-input", required=True)
    run.add_argument("--draft", required=True)
    run.add_argument("--tex", required=True)
    run.add_argument("--bib", required=True)
    run.add_argument("--output", required=True)
    run.add_argument(
        "--report-markdown",
        help="Published Markdown path (defaults to the PDF path with a .md suffix).",
    )
    run.add_argument(
        "--report-manifest",
        help="Report manifest path (defaults to the PDF path with a .json suffix).",
    )
    run.add_argument(
        "--report-id",
        help="Optional stable report identifier; otherwise derive one from the frozen input.",
    )
    run.add_argument(
        "--claim-filter",
        help=(
            "Optional claim-filter JSON (clue.report-writing.claim-filter.v1) to "
            "include/exclude judgments before drafting. Reuses the same analysis "
            "output without re-running intelligence-analysis."
        ),
    )
    add_codex_options(run)

    prepare = subcommands.add_parser("prepare", help="Freeze final analysis output into formatted report input.")
    prepare.add_argument("--analysis-output", required=True, help="Final clue.intelligence-analysis.output.v2 JSON path.")
    prepare.add_argument("--template", default="auto", help="Template ID or auto.")
    prepare.add_argument("--output", required=True, help="Formatted report-input JSON path.")
    prepare.add_argument(
        "--report-id",
        help="Optional stable report identifier; otherwise derive one from the frozen input.",
    )
    prepare.add_argument(
        "--claim-filter",
        help=(
            "Optional claim-filter JSON (clue.report-writing.claim-filter.v1) to "
            "include/exclude judgments when building the report input."
        ),
    )

    draft = subcommands.add_parser("draft", help="Use local Codex to create a structured report draft.")
    draft.add_argument("--input", required=True, help="Formatted report-input JSON path.")
    draft.add_argument("--output", required=True, help="Structured report draft JSON path.")
    draft.add_argument(
        "--no-resume",
        action="store_true",
        help=(
            "For literature compress→outline→expand, ignore existing pipeline "
            "artifacts under <draft-dir>/pipeline/ and regenerate."
        ),
    )
    add_codex_options(draft)

    review = subcommands.add_parser("review", help="Run focused unity, support, coherence, and sentence reviews.")
    review.add_argument("--input", required=True, help="Formatted report-input JSON path.")
    review.add_argument("--draft", required=True, help="Structured report draft JSON path.")
    review.add_argument("--output", required=True, help="Structured report review JSON path.")
    add_codex_options(review)

    revise = subcommands.add_parser("revise", help="Use local Codex to revise a draft from structured reviewer feedback.")
    revise.add_argument("--input", required=True, help="Formatted report-input JSON path.")
    revise.add_argument("--draft", required=True, help="Structured report draft JSON path.")
    revise.add_argument("--reviews", required=True, help="Structured report review JSON path.")
    revise.add_argument("--output", required=True, help="Revised report draft JSON path.")
    add_codex_options(revise)

    publish = subcommands.add_parser("publish", help="Publish reviewer-passed Markdown and a report manifest.")
    publish.add_argument("--input", required=True, help="Formatted report-input JSON path.")
    publish.add_argument("--draft", required=True, help="Structured report draft JSON path.")
    publish.add_argument("--reviews", required=True, help="Structured report review JSON path.")
    publish.add_argument("--output", required=True, help="Published Markdown report path.")
    publish.add_argument("--manifest", required=True, help="Published report JSON manifest path.")
    preview = subcommands.add_parser("preview", help="Render an unreviewed Markdown draft for inspection.")
    preview.add_argument("--input", required=True)
    preview.add_argument("--draft", required=True)
    preview.add_argument("--output", required=True)
    pdf = subcommands.add_parser("pdf", help="Render a Markdown report as a PDF.")
    pdf.add_argument("--markdown", required=True)
    pdf.add_argument("--output", required=True)
    pdf.add_argument("--html-output")
    pdf.add_argument("--browser")
    latex = subcommands.add_parser("latex", help="Generate and compile a formal LaTeX report.")
    latex.add_argument("--input", required=True)
    latex.add_argument("--draft", required=True)
    latex.add_argument("--tex", required=True)
    latex.add_argument("--bib", required=True)
    latex.add_argument("--output", required=True)
    workflow = subcommands.add_parser("workflow", help="Polaris workflow adapter.")
    workflow.add_argument("step_command")
    workflow.add_argument("--input", required=True)
    workflow.add_argument("--output", required=True)
    return parser


def main(argv: list[str]) -> int:
    root = Path(__file__).resolve().parent
    args = build_parser().parse_args(argv)
    try:
        if args.command == "version":
            print(json.dumps({"tool": {"name": TOOL_NAME, "version": read_version(root)}, "backend_lock": json.loads((root / "backend.lock.json").read_text(encoding="utf-8"))}, ensure_ascii=False, indent=2))
            return 0
        if args.command == "templates":
            return command_templates(root)
        if args.command == "run":
            return command_run(args, root)
        if args.command == "prepare":
            return command_prepare(args, root)
        if args.command == "draft":
            return command_draft(args, root)
        if args.command == "review":
            return command_review(args, root)
        if args.command == "revise":
            return command_revise(args, root)
        if args.command == "publish":
            return command_publish(args, root)
        if args.command == "preview":
            return command_preview(args, root)
        if args.command == "pdf":
            return command_pdf(args, root)
        if args.command == "latex":
            return command_latex(args, root)
        if args.command == "workflow":
            return command_workflow(args, root)
        raise CliError(f"unsupported command: {args.command}")
    except CliError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
