"""Compress → outline → expand literature draft pipeline.

Keeps large registries out of a single write prompt: first reduce claims to
main arguments, outline from those arguments, then expand per subsection.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

# Imported as a sibling module of runner.py (same directory on sys.path).
import runner as R


def _progress(message: str, **fields: Any) -> None:
    """Stdout progress line for long pipeline runs (flushed for log tailing)."""
    payload = {"msg": message, **fields}
    print(json.dumps(payload, ensure_ascii=False), flush=True)
    print(f"[pipeline] {message} " + " ".join(f"{k}={v}" for k, v in fields.items()), file=sys.stderr, flush=True)

ARGUMENTS_SCHEMA = "clue.report-writing.arguments.v1"
LOCAL_ARGUMENTS_SCHEMA = "clue.report-writing.local-arguments.v1"
OUTLINE_SCHEMA = "clue.report-writing.outline.v1"
EXPANSION_SCHEMA = "clue.report-writing.expansion.v1"
FRONTMATTER_SCHEMA = "clue.report-writing.frontmatter.v1"
FINDINGS_INTRO_SCHEMA = "clue.report-writing.findings-intro.v1"
FINDINGS_SUMMARY_SCHEMA = "clue.report-writing.findings-summary.v1"
SUMMARY_SUBSECTION_HEADING = "Summary"
PIPELINE_META_SCHEMA = "clue.report-writing.pipeline-meta.v1"

COMPRESS_BATCH_SIZE = 60
EXPAND_BATCH_SIZE = 25
MAX_CITE_CLUSTER_SIZE = 5
MAX_RECONCILE_ROUNDS = 4
EXPAND_CHUNK_RETRIES = 2
THIN_CONFIDENCE = 0.6
# Subsubsections only when a theme has enough claims to feed each unit.
# Below 2 × threshold, keep a flat subsection (no empty \\subsubsection leaves).
MIN_CLAIMS_PER_SUBSUBSECTION = 3
MAX_SUBSUBSECTIONS = 6


def _digest_suffix(digest: str) -> str:
    suffix = digest.split(":", 1)[-1]
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", suffix).strip("-")
    return safe[:16] or "unknown"


def report_input_session_dir(case_root: Path, report_input_sha256: str) -> Path:
    """Return the Codex session directory scoped to an exact report input."""
    return (case_root / "runs" / f"report-input-{_digest_suffix(report_input_sha256)}").resolve()


def pipeline_resume_allowed(
    pipeline_dir: Path,
    report_input_sha256: str,
    *,
    resume: bool,
) -> tuple[bool, str]:
    """Only resume cached pipeline artifacts for the exact report input."""
    if not resume:
        return False, "disabled"
    meta_path = pipeline_dir / "pipeline-meta.json"
    if not meta_path.is_file():
        return False, "missing-meta"
    try:
        meta = R.read_json(meta_path, "pipeline metadata")
    except R.CliError:
        return False, "invalid-meta"
    if meta.get("schema_version") != PIPELINE_META_SCHEMA:
        return False, "invalid-meta"
    if meta.get("report_input_sha256") != report_input_sha256:
        return False, "input-hash-mismatch"
    return True, "matched"


def write_pipeline_meta(
    pipeline_dir: Path,
    *,
    report_input_sha256: str,
    session_dir: Path,
) -> None:
    R.write_json(
        pipeline_dir / "pipeline-meta.json",
        {
            "schema_version": PIPELINE_META_SCHEMA,
            "report_input_sha256": report_input_sha256,
            "session_dir": str(session_dir),
            "updated_at": R.utc_now(),
        },
    )


def max_subsubsections_for_claims(claim_count: int) -> int:
    """How many subsubsections a theme may use given its claim budget.

    Returns 0 when claims are too few to justify nesting (flat subsection).
    Otherwise returns a count in [2, MAX_SUBSUBSECTIONS] capped by
    claim_count // MIN_CLAIMS_PER_SUBSUBSECTION so each unit can hold at least
    MIN_CLAIMS_PER_SUBSUBSECTION claims after even partition.
    """
    if claim_count < MIN_CLAIMS_PER_SUBSUBSECTION * 2:
        return 0
    return min(MAX_SUBSUBSECTIONS, max(2, claim_count // MIN_CLAIMS_PER_SUBSUBSECTION))


def claim_cards(report_input: dict[str, Any], claim_ids: list[str] | None = None) -> list[dict[str, Any]]:
    """Compact cards without evidence quotes (safe for compress/expand prompts)."""
    wanted = set(claim_ids) if claim_ids is not None else None
    cards: list[dict[str, Any]] = []
    for claim in report_input["evidence_registry"]:
        claim_id = claim["claim_id"]
        if wanted is not None and claim_id not in wanted:
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


def claim_cards_with_quotes(
    report_input: dict[str, Any],
    claim_ids: list[str],
    *,
    max_quote_chars: int = 280,
) -> list[dict[str, Any]]:
    """Expand-time cards: compact fields plus one short quote when available."""
    registry = {claim["claim_id"]: claim for claim in report_input["evidence_registry"]}
    cards: list[dict[str, Any]] = []
    for claim_id in claim_ids:
        claim = registry.get(claim_id)
        if not claim:
            continue
        card: dict[str, Any] = {
            "claim_id": claim_id,
            "title": claim.get("title"),
            "statement": claim.get("statement"),
            "classification": claim.get("classification"),
            "status": claim.get("status"),
            "confidence": claim.get("confidence"),
        }
        evidence = claim.get("evidence") or []
        if evidence and isinstance(evidence[0], dict):
            quote = evidence[0].get("quote")
            if isinstance(quote, str) and quote.strip():
                text = re.sub(r"\s+", " ", quote).strip()
                if len(text) > max_quote_chars:
                    text = text[: max_quote_chars - 1].rstrip() + "…"
                card["quote"] = text
        cards.append(card)
    return cards


def _chunk(items: list[Any], size: int) -> list[list[Any]]:
    if size < 1:
        raise R.CliError("batch size must be >= 1")
    return [items[index : index + size] for index in range(0, len(items), size)]


def _partition_list(items: list[Any], parts: int) -> list[list[Any]]:
    """Split items into `parts` contiguous slices as evenly as possible."""
    if parts < 1:
        raise R.CliError("partition count must be >= 1")
    if not items:
        return [[] for _ in range(parts)]
    n = len(items)
    base, rem = divmod(n, parts)
    out: list[list[Any]] = []
    cursor = 0
    for index in range(parts):
        take = base + (1 if index < rem else 0)
        out.append(items[cursor : cursor + take])
        cursor += take
    return out


def partition_claim_cards(
    cards: list[dict[str, Any]],
    report_input: dict[str, Any],
    *,
    batch_size: int = COMPRESS_BATCH_SIZE,
) -> list[list[dict[str, Any]]]:
    """Deterministic batches: framework stages, then thin, then remainder."""
    by_id = {card["claim_id"]: card for card in cards}
    assigned: set[str] = set()
    groups: list[list[dict[str, Any]]] = []

    framework = report_input.get("framework")
    if isinstance(framework, dict):
        stages = framework.get("stages") or []
        if isinstance(stages, list):
            ordered = sorted(
                [stage for stage in stages if isinstance(stage, dict)],
                key=lambda stage: stage.get("sequence")
                if isinstance(stage.get("sequence"), int)
                else 10**9,
            )
            for stage in ordered:
                stage_ids = [
                    claim_id
                    for claim_id in stage.get("claim_ids") or []
                    if isinstance(claim_id, str) and claim_id in by_id and claim_id not in assigned
                ]
                if not stage_ids:
                    continue
                batch_cards = [by_id[claim_id] for claim_id in stage_ids]
                groups.extend(_chunk(batch_cards, batch_size))
                assigned.update(stage_ids)

    thin: list[dict[str, Any]] = []
    rest: list[dict[str, Any]] = []
    for card in cards:
        claim_id = card["claim_id"]
        if claim_id in assigned:
            continue
        status = str(card.get("status") or "").lower()
        confidence = card.get("confidence")
        is_thin = status in {"insufficient_evidence", "unsupported", "rejected"} or (
            isinstance(confidence, (int, float)) and float(confidence) < THIN_CONFIDENCE
        )
        if is_thin:
            thin.append(card)
        else:
            rest.append(card)

    if rest:
        groups.extend(_chunk(rest, batch_size))
    if thin:
        groups.extend(_chunk(thin, batch_size))
    if not groups and cards:
        groups = _chunk(cards, batch_size)
    return groups


def validate_arguments_document(
    document: dict[str, Any],
    registry_ids: set[str],
) -> dict[str, Any]:
    if document.get("schema_version") != ARGUMENTS_SCHEMA:
        raise R.CliError(f"arguments must use schema_version {ARGUMENTS_SCHEMA}")
    raw = document.get("arguments")
    if not isinstance(raw, list) or not raw:
        raise R.CliError("arguments document requires a non-empty arguments array")
    seen_ids: set[str] = set()
    covered: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            raise R.CliError(f"arguments[{index}] must be an object")
        label = f"arguments[{index}]"
        argument_id = R.require_string(item, "argument_id", label)
        if argument_id in seen_ids:
            raise R.CliError(f"duplicate argument_id: {argument_id}")
        seen_ids.add(argument_id)
        thesis = R.require_string(item, "thesis", label)
        role = str(item.get("role") or "established").strip() or "established"
        themes = item.get("themes") or []
        if not isinstance(themes, list) or any(not isinstance(theme, str) for theme in themes):
            raise R.CliError(f"{label} themes must be a string array")
        claim_ids = R.require_string_list(item.get("claim_ids"), f"{label} claim_ids")
        if not claim_ids:
            raise R.CliError(f"{label} must list at least one claim_id")
        if len(set(claim_ids)) != len(claim_ids):
            raise R.CliError(f"{label} has duplicate claim_ids")
        unknown = set(claim_ids) - registry_ids
        if unknown:
            raise R.CliError(
                f"{label} references unknown claim IDs: {', '.join(sorted(unknown)[:8])}"
            )
        covered.update(claim_ids)
        normalized.append(
            {
                "argument_id": argument_id,
                "thesis": thesis,
                "role": role,
                "themes": themes,
                "claim_ids": claim_ids,
            }
        )
    missing = registry_ids - covered
    if missing:
        raise R.CliError(
            "arguments must cover every evidence_registry claim_id; "
            f"missing {len(missing)}, e.g. {', '.join(sorted(missing)[:8])}"
        )
    return {"schema_version": ARGUMENTS_SCHEMA, "arguments": normalized}


def validate_outline_document(
    document: dict[str, Any],
    arguments_doc: dict[str, Any],
) -> dict[str, Any]:
    if document.get("schema_version") != OUTLINE_SCHEMA:
        raise R.CliError(f"outline must use schema_version {OUTLINE_SCHEMA}")
    title = R.require_string(document, "title", "outline")
    findings = document.get("findings")
    if not isinstance(findings, list) or not findings:
        raise R.CliError("outline requires a non-empty findings array")
    argument_ids = {item["argument_id"] for item in arguments_doc["arguments"]}
    claim_by_argument = {
        item["argument_id"]: list(item["claim_ids"]) for item in arguments_doc["arguments"]
    }
    used_arguments: set[str] = set()
    normalized: list[dict[str, Any]] = []
    seen_subsection_ids: set[str] = set()
    for index, item in enumerate(findings, start=1):
        if not isinstance(item, dict):
            raise R.CliError(f"outline findings[{index}] must be an object")
        label = f"outline findings[{index}]"
        subsection_id = R.require_string(item, "subsection_id", label)
        if subsection_id in seen_subsection_ids:
            raise R.CliError(f"duplicate subsection_id: {subsection_id}")
        seen_subsection_ids.add(subsection_id)
        heading = R.require_string(item, "heading", label)
        arg_ids = R.require_string_list(item.get("argument_ids"), f"{label} argument_ids")
        if not arg_ids:
            raise R.CliError(f"{label} must list argument_ids")
        unknown = set(arg_ids) - argument_ids
        if unknown:
            raise R.CliError(
                f"{label} references unknown argument_ids: {', '.join(sorted(unknown))}"
            )
        used_arguments.update(arg_ids)
        claim_ids: list[str] = []
        seen_claims: set[str] = set()
        for argument_id in arg_ids:
            for claim_id in claim_by_argument[argument_id]:
                if claim_id not in seen_claims:
                    seen_claims.add(claim_id)
                    claim_ids.append(claim_id)

        # Prefer explicit subsubsections; fall back to promoting legacy points.
        raw_subsubs = item.get("subsubsections")
        if raw_subsubs is None and item.get("points"):
            raw_subsubs = [
                {
                    "subsubsection_id": f"{subsection_id}.{point_index}",
                    "heading": point if len(point) <= 120 else point[:117].rstrip() + "…",
                    "points": [point],
                }
                for point_index, point in enumerate(
                    R.require_string_list(item.get("points"), f"{label} points"),
                    start=1,
                )
            ]
        if raw_subsubs is None:
            raw_subsubs = []
        if not isinstance(raw_subsubs, list):
            raise R.CliError(f"{label} subsubsections must be an array when set")

        max_subs = max_subsubsections_for_claims(len(claim_ids))
        subsubs: list[dict[str, Any]] = []
        if max_subs == 0:
            # Not enough claims for nested units — expand as a flat subsection.
            if raw_subsubs:
                _progress(
                    "outline_skip_subsubs_below_threshold",
                    subsection_id=subsection_id,
                    claim_count=len(claim_ids),
                    planned=len(raw_subsubs),
                    min_claims_per_subsub=MIN_CLAIMS_PER_SUBSUBSECTION,
                )
        else:
            seen_subsub_ids: set[str] = set()
            for sub_index, raw in enumerate(raw_subsubs, start=1):
                if not isinstance(raw, dict):
                    raise R.CliError(
                        f"{label} subsubsections[{sub_index}] must be an object"
                    )
                sub_label = f"{label} subsubsections[{sub_index}]"
                raw_sub_id = raw.get("subsubsection_id")
                sub_id = (
                    raw_sub_id.strip()
                    if isinstance(raw_sub_id, str) and raw_sub_id.strip()
                    else f"{subsection_id}.{sub_index}"
                )
                if sub_id in seen_subsub_ids:
                    sub_id = f"{subsection_id}.{sub_index}"
                seen_subsub_ids.add(sub_id)
                sub_heading = R.require_string(raw, "heading", sub_label)
                sub_points = raw.get("points")
                if sub_points is None:
                    sub_points = []
                sub_points = R.require_string_list(sub_points, f"{sub_label} points")
                subsubs.append(
                    {
                        "subsubsection_id": sub_id,
                        "heading": sub_heading,
                        "points": sub_points,
                    }
                )
            if len(subsubs) > max_subs:
                # Cap so partition cannot leave empty claim buckets.
                overflow = subsubs[max_subs:]
                subsubs = subsubs[:max_subs]
                for extra in overflow:
                    subsubs[-1]["points"].extend(extra.get("points") or [])
                    subsubs[-1]["points"].append(extra.get("heading") or "")
                _progress(
                    "outline_cap_subsubs",
                    subsection_id=subsection_id,
                    claim_count=len(claim_ids),
                    kept=len(subsubs),
                    max_subs=max_subs,
                )
            if len(subsubs) < 2:
                # One planned unit is not worth a nesting level.
                subsubs = []
            else:
                partitions = _partition_list(claim_ids, len(subsubs))
                for sub, part in zip(subsubs, partitions, strict=True):
                    sub["claim_ids"] = part
                # Drop any empty partitions (defensive) and re-merge claims.
                nonempty = [sub for sub in subsubs if sub.get("claim_ids")]
                if len(nonempty) < 2:
                    subsubs = []
                else:
                    # Re-partition onto surviving heads so no claim is dropped.
                    heads = [
                        {
                            "subsubsection_id": sub["subsubsection_id"],
                            "heading": sub["heading"],
                            "points": sub.get("points") or [],
                        }
                        for sub in nonempty
                    ]
                    partitions = _partition_list(claim_ids, len(heads))
                    for sub, part in zip(heads, partitions, strict=True):
                        sub["claim_ids"] = part
                    subsubs = heads

        normalized.append(
            {
                "subsection_id": subsection_id,
                "heading": heading,
                "argument_ids": arg_ids,
                "claim_ids": claim_ids,
                "subsubsections": subsubs,
            }
        )
    missing_args = sorted(argument_ids - used_arguments)
    if missing_args:
        # Do not fail the whole pipeline: park leftover arguments in a residual
        # subsection (nested only when claim budget clears the subsub threshold).
        residual_claims: list[str] = []
        seen_residual: set[str] = set()
        for argument_id in missing_args:
            for claim_id in claim_by_argument.get(argument_id, []):
                if claim_id not in seen_residual:
                    seen_residual.add(claim_id)
                    residual_claims.append(claim_id)
        residual_subs: list[dict[str, Any]] = []
        max_residual_subs = max_subsubsections_for_claims(len(residual_claims))
        if max_residual_subs >= 2:
            planned = min(max_residual_subs, max(2, len(missing_args)))
            residual_subs = [
                {
                    "subsubsection_id": f"S_residual.{index}",
                    "heading": f"Residual theme from {argument_id}",
                    "points": [
                        next(
                            (
                                str(item.get("thesis") or argument_id)
                                for item in arguments_doc["arguments"]
                                if item.get("argument_id") == argument_id
                            ),
                            argument_id,
                        )
                    ],
                    "claim_ids": [],
                }
                for index, argument_id in enumerate(missing_args[:planned], start=1)
            ]
            while len(residual_subs) < planned:
                residual_subs.append(
                    {
                        "subsubsection_id": f"S_residual.{len(residual_subs) + 1}",
                        "heading": "Additional residual evidence",
                        "points": [],
                        "claim_ids": [],
                    }
                )
            parts = _partition_list(residual_claims, len(residual_subs))
            for sub, part in zip(residual_subs, parts, strict=True):
                sub["claim_ids"] = part
            residual_subs = [sub for sub in residual_subs if sub.get("claim_ids")]
            if len(residual_subs) < 2:
                residual_subs = []
        normalized.append(
            {
                "subsection_id": "S_residual",
                "heading": "Additional literature themes",
                "argument_ids": missing_args,
                "claim_ids": residual_claims,
                "subsubsections": residual_subs,
            }
        )
        _progress(
            "outline_residual_arguments",
            missing=len(missing_args),
            claims=len(residual_claims),
            subsubs=len(residual_subs),
        )
    return {
        "schema_version": OUTLINE_SCHEMA,
        "title": title,
        "findings": normalized,
    }


def cite_cluster_sizes(text: str) -> list[int]:
    sizes: list[int] = []
    for match in R.INLINE_CLAIM_CITE_RE.finditer(text or ""):
        ids = [part.strip() for part in match.group(1).split(";") if part.strip()]
        if ids:
            sizes.append(len(ids))
    return sizes


def oversized_cite_clusters(
    text: str,
    *,
    limit: int = MAX_CITE_CLUSTER_SIZE,
) -> list[tuple[int, str]]:
    bad: list[tuple[int, str]] = []
    for match in R.INLINE_CLAIM_CITE_RE.finditer(text or ""):
        raw = match.group(1)
        ids = [part.strip() for part in raw.split(";") if part.strip()]
        if len(ids) > limit:
            bad.append((len(ids), match.group(0)[:120]))
    return bad


def validate_expansion(
    document: dict[str, Any],
    *,
    expected_claim_ids: set[str],
    subsection_id: str | None = None,
) -> dict[str, Any]:
    if (
        "schema_version" in document
        and document.get("schema_version") != EXPANSION_SCHEMA
    ):
        raise R.CliError(f"expansion must use schema_version {EXPANSION_SCHEMA}")
    heading = R.require_string(document, "heading", "expansion")
    paragraphs = R.require_string_list(document.get("paragraphs"), "expansion paragraphs")
    if not paragraphs:
        raise R.CliError("expansion must include paragraphs")
    raw_claim_ids = document.get("claim_ids")
    if raw_claim_ids is None:
        claim_ids = sorted(expected_claim_ids)
    else:
        claim_ids = R.require_string_list(raw_claim_ids, "expansion claim_ids")
    if len(set(claim_ids)) != len(claim_ids):
        raise R.CliError("expansion has duplicate claim_ids")
    bound = set(claim_ids)
    missing_declared = expected_claim_ids - bound
    if missing_declared:
        raise R.CliError(
            "expansion omitted required claim_ids: "
            + ", ".join(sorted(missing_declared)[:8])
        )
    extra = bound - expected_claim_ids
    if extra:
        raise R.CliError(
            "expansion lists unexpected claim_ids: " + ", ".join(sorted(extra)[:8])
        )
    prose = "\n".join(paragraphs)
    inline = set(R.extract_inline_claim_ids(prose))
    missing_inline = expected_claim_ids - inline
    if missing_inline:
        raise R.CliError(
            "expansion missing inline markers for "
            f"{len(missing_inline)} claim(s), e.g. {', '.join(sorted(missing_inline)[:8])}"
        )
    unknown_inline = inline - expected_claim_ids
    if unknown_inline:
        raise R.CliError(
            "expansion cites unexpected claim IDs: "
            + ", ".join(sorted(unknown_inline)[:8])
        )
    oversized = oversized_cite_clusters(prose)
    if oversized:
        size, sample = oversized[0]
        raise R.CliError(
            f"expansion has [@…] cluster with {size} claims "
            f"(max {MAX_CITE_CLUSTER_SIZE}): {sample}"
        )
    sid = subsection_id or "S"
    raw_sid = document.get("subsection_id")
    if isinstance(raw_sid, str) and raw_sid.strip():
        sid = raw_sid.strip()
    if subsection_id:
        sid = subsection_id
    return {
        "schema_version": EXPANSION_SCHEMA,
        "subsection_id": sid,
        "heading": heading,
        "paragraphs": paragraphs,
        "claim_ids": sorted(expected_claim_ids),
    }


def _write_attachment(path: Path, value: dict[str, Any] | list[Any]) -> Path:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(value, dict):
        R.write_json(path, value)
    else:
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def _codex_json(
    root: Path,
    *,
    prompt_name: str,
    payload: dict[str, Any],
    attachments: list[tuple[str, Path]],
    session_path: Path,
    run_dir: Path | None,
    run_name: str,
) -> dict[str, Any]:
    request = R.model_request(R.prompt(root, prompt_name), payload)
    response = R.request_codex(request, attachments, session_path)
    document = R.extract_model_json(response)
    R.write_run_item(run_dir, run_name, request, response, document)
    return document


def _normalize_local_arguments(
    document: dict[str, Any],
    batch_ids: set[str],
) -> list[dict[str, Any]]:
    raw = document.get("local_arguments")
    if not isinstance(raw, list) or not raw:
        raise R.CliError("local compress response requires local_arguments[]")
    normalized: list[dict[str, Any]] = []
    covered: set[str] = set()
    for index, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            raise R.CliError(f"local_arguments[{index}] must be an object")
        thesis = R.require_string(item, "thesis", f"local_arguments[{index}]")
        claim_ids = [
            claim_id
            for claim_id in R.require_string_list(
                item.get("claim_ids"), f"local_arguments[{index}] claim_ids"
            )
            if claim_id in batch_ids
        ]
        if not claim_ids:
            continue
        covered.update(claim_ids)
        normalized.append(
            {
                "local_id": str(item.get("local_id") or f"L{index}"),
                "thesis": thesis,
                "role": str(item.get("role") or "established"),
                "themes": [
                    theme
                    for theme in (item.get("themes") or [])
                    if isinstance(theme, str) and theme.strip()
                ],
                "claim_ids": claim_ids,
            }
        )
    missing = batch_ids - covered
    if missing:
        # Deterministic catch-all so compress never drops claims.
        normalized.append(
            {
                "local_id": "L_unassigned",
                "thesis": "Additional literature claims remain to be synthesized in this batch.",
                "role": "thin",
                "themes": ["unassigned"],
                "claim_ids": sorted(missing),
            }
        )
    return normalized


def _normalize_global_arguments(
    document: dict[str, Any],
    registry_ids: set[str],
) -> dict[str, Any]:
    raw = document.get("arguments")
    if not isinstance(raw, list) or not raw:
        raise R.CliError("compress merge response requires arguments[]")
    # Filter unknown ids first, then fill gaps.
    cleaned: list[dict[str, Any]] = []
    covered: set[str] = set()
    for index, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            continue
        thesis = item.get("thesis")
        if not isinstance(thesis, str) or not thesis.strip():
            continue
        claim_ids = []
        seen: set[str] = set()
        for claim_id in item.get("claim_ids") or []:
            if (
                isinstance(claim_id, str)
                and claim_id in registry_ids
                and claim_id not in seen
            ):
                seen.add(claim_id)
                claim_ids.append(claim_id)
        if not claim_ids:
            continue
        covered.update(claim_ids)
        argument_id = item.get("argument_id")
        if not isinstance(argument_id, str) or not argument_id.strip():
            argument_id = f"A{index:02d}"
        cleaned.append(
            {
                "argument_id": argument_id.strip(),
                "thesis": thesis.strip(),
                "role": str(item.get("role") or "established"),
                "themes": [
                    theme
                    for theme in (item.get("themes") or [])
                    if isinstance(theme, str) and theme.strip()
                ],
                "claim_ids": claim_ids,
            }
        )
    missing = registry_ids - covered
    if missing:
        cleaned.append(
            {
                "argument_id": f"A{len(cleaned) + 1:02d}",
                "thesis": (
                    "Boundary or residual claims that were not yet folded into the "
                    "primary thematic arguments."
                ),
                "role": "thin",
                "themes": ["residual"],
                "claim_ids": sorted(missing),
            }
        )
    # Re-id stably if duplicates.
    seen_ids: set[str] = set()
    for index, item in enumerate(cleaned, start=1):
        argument_id = item["argument_id"]
        if argument_id in seen_ids:
            item["argument_id"] = f"A{index:02d}"
        seen_ids.add(item["argument_id"])
    return validate_arguments_document(
        {"schema_version": ARGUMENTS_SCHEMA, "arguments": cleaned},
        registry_ids,
    )


def compress_arguments(
    root: Path,
    report_input: dict[str, Any],
    *,
    work_dir: Path,
    session_dir: Path,
    run_dir: Path | None,
) -> dict[str, Any]:
    registry_ids = {claim["claim_id"] for claim in report_input["evidence_registry"]}
    cards = claim_cards(report_input)
    batches = partition_claim_cards(cards, report_input)
    local_all: list[dict[str, Any]] = []
    _progress("compress_start", claim_count=len(cards), batch_count=len(batches))

    for batch_index, batch in enumerate(batches, start=1):
        batch_ids = {card["claim_id"] for card in batch}
        _progress(
            "compress_batch_start",
            batch_index=batch_index,
            batch_count=len(batches),
            claim_count=len(batch),
        )
        attachment = _write_attachment(
            work_dir / "compress" / f"batch-{batch_index:03d}-cards.json",
            {
                "schema_version": "clue.report-writing.claim-cards.v1",
                "batch_index": batch_index,
                "batch_count": len(batches),
                "question": report_input["question"],
                "cards": batch,
            },
        )
        session_path = session_dir / f"codex-session-compress-{batch_index:03d}.json"
        document = _codex_json(
            root,
            prompt_name="compress-local.v1.md",
            payload={
                "instruction": (
                    "Compress this batch of claim cards into local main arguments. "
                    "Every claim_id in the batch must be assigned."
                ),
                "batch_index": batch_index,
                "batch_count": len(batches),
                "claim_count": len(batch),
            },
            attachments=[("claim cards batch", attachment)],
            session_path=session_path,
            run_dir=run_dir,
            run_name=f"compress-local-{batch_index:03d}",
        )
        local_args = _normalize_local_arguments(document, batch_ids)
        local_all.extend(local_args)
        _write_attachment(
            work_dir / "compress" / f"batch-{batch_index:03d}-local.json",
            {
                "schema_version": LOCAL_ARGUMENTS_SCHEMA,
                "batch_index": batch_index,
                "local_arguments": local_args,
            },
        )
        _progress(
            "compress_batch_done",
            batch_index=batch_index,
            batch_count=len(batches),
            local_arguments=len(local_args),
            covered=sum(len(item.get("claim_ids") or []) for item in local_args),
        )

    _progress("compress_local_complete", local_arguments=len(local_all), batches=len(batches))
    # Single-batch: promote local → global without a merge call when already small.
    if len(batches) == 1:
        promoted = []
        for index, item in enumerate(local_all, start=1):
            promoted.append(
                {
                    "argument_id": f"A{index:02d}",
                    "thesis": item["thesis"],
                    "role": item.get("role") or "established",
                    "themes": item.get("themes") or [],
                    "claim_ids": item["claim_ids"],
                }
            )
        arguments = validate_arguments_document(
            {"schema_version": ARGUMENTS_SCHEMA, "arguments": promoted},
            registry_ids,
        )
    else:
        merge_attachment = _write_attachment(
            work_dir / "compress" / "local-arguments.json",
            {
                "schema_version": LOCAL_ARGUMENTS_SCHEMA,
                "question": report_input["question"],
                "decision_context": report_input["decision_context"],
                "local_arguments": local_all,
            },
        )
        document = _codex_json(
            root,
            prompt_name="compress-merge.v1.md",
            payload={
                "instruction": (
                    "Merge local arguments into global main arguments. "
                    "Preserve full claim coverage."
                ),
                "local_argument_count": len(local_all),
                "claim_count": len(registry_ids),
            },
            attachments=[("local arguments", merge_attachment)],
            session_path=session_dir / "codex-session-compress-merge.json",
            run_dir=run_dir,
            run_name="compress-merge",
        )
        arguments = _normalize_global_arguments(document, registry_ids)
        _progress("compress_merge_done", arguments=len(arguments["arguments"]))

    out_path = work_dir / "arguments.json"
    R.write_json(out_path, arguments)
    _progress("arguments_ready", arguments=len(arguments["arguments"]), path=str(out_path))
    return arguments


def build_outline(
    root: Path,
    report_input: dict[str, Any],
    arguments_doc: dict[str, Any],
    *,
    work_dir: Path,
    session_dir: Path,
    run_dir: Path | None,
) -> dict[str, Any]:
    # Attach arguments without repeating giant claim lists if huge: keep claim_ids
    # (needed for model awareness of mass) but no quotes.
    slim_arguments = [
        {
            "argument_id": item["argument_id"],
            "thesis": item["thesis"],
            "role": item.get("role"),
            "themes": item.get("themes") or [],
            "claim_count": len(item["claim_ids"]),
            "claim_ids": item["claim_ids"],
        }
        for item in arguments_doc["arguments"]
    ]
    attachment = _write_attachment(
        work_dir / "outline-input.json",
        {
            "question": report_input["question"],
            "decision_context": report_input["decision_context"],
            "audience": report_input["audience"],
            "arguments": slim_arguments,
        },
    )
    document = _codex_json(
        root,
        prompt_name="outline.v1.md",
        payload={
            "instruction": (
                "Build a findings outline from main arguments only. "
                "No word-count plan. Every argument_id must appear once or more."
            )
        },
        attachments=[("arguments for outline", attachment)],
        session_path=session_dir / "codex-session-outline.json",
        run_dir=run_dir,
        run_name="outline",
    )
    # Fill schema_version if model omitted it.
    if "schema_version" not in document:
        document["schema_version"] = OUTLINE_SCHEMA
    outline = validate_outline_document(document, arguments_doc)
    R.write_json(work_dir / "outline.json", outline)
    _progress(
        "outline_ready",
        subsections=len(outline["findings"]),
        title=outline["title"],
    )
    return outline


def expand_frontmatter(
    root: Path,
    report_input: dict[str, Any],
    outline: dict[str, Any],
    *,
    work_dir: Path,
    session_dir: Path,
    run_dir: Path | None,
) -> dict[str, Any]:
    attachment = _write_attachment(
        work_dir / "frontmatter-input.json",
        {
            "question": report_input["question"],
            "decision_context": report_input["decision_context"],
            "audience": report_input["audience"],
            "search_scope": report_input.get("search_scope") or {},
            "outline_title": outline.get("title"),
        },
    )
    document = _codex_json(
        root,
        prompt_name="expand-frontmatter.v1.md",
        payload={"instruction": "Write title, question paragraphs, and search_scope paragraphs only."},
        attachments=[("frontmatter input", attachment)],
        session_path=session_dir / "codex-session-frontmatter.json",
        run_dir=run_dir,
        run_name="expand-frontmatter",
    )
    title = document.get("title") if isinstance(document.get("title"), str) else outline["title"]
    title = title.strip() or outline["title"]
    question_paragraphs = document.get("question_paragraphs")
    if not isinstance(question_paragraphs, list) or not question_paragraphs:
        question_paragraphs = [
            report_input["question"].strip(),
            report_input["decision_context"].strip(),
        ]
    question_paragraphs = [str(item).strip() for item in question_paragraphs if str(item).strip()]
    scope_paragraphs = document.get("search_scope_paragraphs")
    if not isinstance(scope_paragraphs, list) or not scope_paragraphs:
        scope = report_input.get("search_scope") or {}
        record_count = scope.get("record_count")
        scope_paragraphs = [
            (
                f"The search scope covers {record_count} records."
                if isinstance(record_count, int)
                else "The search scope is defined by the frozen collection snapshot."
            )
        ]
    scope_paragraphs = [str(item).strip() for item in scope_paragraphs if str(item).strip()]
    result = {
        "schema_version": FRONTMATTER_SCHEMA,
        "title": title,
        "question_paragraphs": question_paragraphs,
        "search_scope_paragraphs": scope_paragraphs,
        "findings_intro_paragraphs": [],
    }
    R.write_json(work_dir / "frontmatter.json", result)
    return result


def _fallback_findings_intro(
    report_input: dict[str, Any],
    outline: dict[str, Any],
) -> list[str]:
    """Deterministic intro when the model returns nothing usable."""
    headings = [
        str(node.get("heading") or "").strip()
        for node in outline.get("findings") or []
        if str(node.get("heading") or "").strip()
    ]
    question = str(report_input.get("question") or "").strip()
    lead = (
        "This section synthesizes the approved literature against the research "
        f"question: {question}"
        if question
        else (
            "This section synthesizes the approved literature into an "
            "evidence-bound findings narrative."
        )
    )
    if not lead.endswith("."):
        lead = lead.rstrip() + "."
    if headings:
        if len(headings) == 1:
            roadmap = f"The discussion is organized around {headings[0]}."
        elif len(headings) == 2:
            roadmap = (
                f"The discussion proceeds through {headings[0]}, then {headings[1]}."
            )
        else:
            body = ", ".join(headings[:-1])
            roadmap = (
                f"The discussion proceeds through {body}, and finally {headings[-1]}."
            )
    else:
        roadmap = (
            "Thematic subsections that follow develop mechanisms, threats, and "
            "governance themes with integrated citations."
        )
    close = (
        "Each subsection integrates supporting claims with inline citations; "
        "thin or contested evidence is stated as such rather than overstated."
    )
    return [lead, roadmap, close]


def expand_findings_intro(
    root: Path,
    report_input: dict[str, Any],
    outline: dict[str, Any],
    arguments_doc: dict[str, Any],
    *,
    work_dir: Path,
    session_dir: Path,
    run_dir: Path | None,
) -> list[str]:
    """Section-level intro for Findings and Evidence (before subsections)."""
    slim_arguments = [
        {
            "argument_id": item["argument_id"],
            "thesis": item["thesis"],
            "role": item.get("role"),
            "themes": item.get("themes") or [],
            "claim_count": len(item.get("claim_ids") or []),
        }
        for item in arguments_doc.get("arguments") or []
    ]
    outline_nodes = [
        {
            "subsection_id": node["subsection_id"],
            "heading": node["heading"],
            "points": node.get("points") or [],
            "argument_ids": node.get("argument_ids") or [],
        }
        for node in outline.get("findings") or []
    ]
    attachment = _write_attachment(
        work_dir / "findings-intro-input.json",
        {
            "question": report_input["question"],
            "decision_context": report_input["decision_context"],
            "audience": report_input["audience"],
            "title": outline.get("title"),
            "arguments": slim_arguments,
            "outline_findings": outline_nodes,
        },
    )
    document = _codex_json(
        root,
        prompt_name="expand-findings-intro.v1.md",
        payload={
            "instruction": (
                "Write a 2–4 paragraph introduction for the Findings and Evidence "
                "section that previews the outline themes in order. No claim markers."
            )
        },
        attachments=[("findings intro input", attachment)],
        session_path=session_dir / "codex-session-findings-intro.json",
        run_dir=run_dir,
        run_name="expand-findings-intro",
    )
    raw = document.get("findings_intro_paragraphs")
    paragraphs = (
        [str(item).strip() for item in raw if str(item).strip()]
        if isinstance(raw, list)
        else []
    )
    # Reject accidental claim markers in the intro.
    cleaned: list[str] = []
    for paragraph in paragraphs:
        if R.INLINE_CLAIM_CITE_RE.search(paragraph):
            paragraph = R.INLINE_CLAIM_CITE_RE.sub("", paragraph)
            paragraph = re.sub(r"\s{2,}", " ", paragraph).strip()
        if paragraph:
            cleaned.append(paragraph)
    if not cleaned:
        cleaned = _fallback_findings_intro(report_input, outline)
        _progress("findings_intro_fallback", paragraphs=len(cleaned))
    else:
        _progress("findings_intro_ready", paragraphs=len(cleaned))
    R.write_json(
        work_dir / "findings-intro.json",
        {
            "schema_version": FINDINGS_INTRO_SCHEMA,
            "findings_intro_paragraphs": cleaned,
        },
    )
    return cleaned


def _fallback_findings_summary(
    report_input: dict[str, Any],
    outline: dict[str, Any],
    arguments_doc: dict[str, Any],
) -> list[str]:
    """Deterministic summary when the model returns nothing usable."""
    question = str(report_input.get("question") or "").strip()
    headings = [
        str(node.get("heading") or "").strip()
        for node in outline.get("findings") or []
        if str(node.get("heading") or "").strip()
    ]
    thin = [
        item
        for item in arguments_doc.get("arguments") or []
        if str(item.get("role") or "").lower() in {"thin", "contested"}
    ]
    lead = (
        "Taken together, the approved literature supplies an evidence-bound "
        f"answer to the research question: {question}"
        if question
        else (
            "Taken together, the approved literature supplies an evidence-bound "
            "account of the mechanisms and risks reviewed above."
        )
    )
    if not lead.endswith("."):
        lead = lead.rstrip() + "."
    if headings:
        mid = (
            "The thematic threads—"
            + "; ".join(headings)
            + "—should be read as mutually reinforcing rather than as isolated checklists."
        )
    else:
        mid = (
            "The thematic threads developed above should be read as mutually "
            "reinforcing rather than as isolated checklists."
        )
    if thin:
        close = (
            f"{len(thin)} argument clusters remain thin or contested; those "
            "limits constrain how far architectural conclusions can be pushed "
            "beyond the supplied evidence."
        )
    else:
        close = (
            "Where the evidence is strong, the findings support structured "
            "controls at execution, permission, and governance boundaries; "
            "where it is thinner, the review marks interpretive limits instead "
            "of overstating certainty."
        )
    return [lead, mid, close]


def expand_findings_summary(
    root: Path,
    report_input: dict[str, Any],
    outline: dict[str, Any],
    arguments_doc: dict[str, Any],
    expansions: list[dict[str, Any]],
    *,
    work_dir: Path,
    session_dir: Path,
    run_dir: Path | None,
) -> list[str]:
    """Closing Summary subsection after all thematic findings expansions."""
    slim_arguments = [
        {
            "argument_id": item["argument_id"],
            "thesis": item["thesis"],
            "role": item.get("role"),
            "themes": item.get("themes") or [],
            "claim_count": len(item.get("claim_ids") or []),
        }
        for item in arguments_doc.get("arguments") or []
    ]
    expanded_heads = [
        {
            "subsection_id": item.get("subsection_id"),
            "heading": item.get("heading"),
            "paragraph_count": len(item.get("paragraphs") or []),
            "claim_count": len(item.get("claim_ids") or []),
        }
        for item in expansions
    ]
    outline_nodes = [
        {
            "subsection_id": node["subsection_id"],
            "heading": node["heading"],
            "points": node.get("points") or [],
            "argument_ids": node.get("argument_ids") or [],
        }
        for node in outline.get("findings") or []
    ]
    attachment = _write_attachment(
        work_dir / "findings-summary-input.json",
        {
            "question": report_input["question"],
            "decision_context": report_input["decision_context"],
            "audience": report_input["audience"],
            "title": outline.get("title"),
            "arguments": slim_arguments,
            "outline_findings": outline_nodes,
            "expanded_subsections": expanded_heads,
        },
    )
    document = _codex_json(
        root,
        prompt_name="expand-findings-summary.v1.md",
        payload={
            "instruction": (
                "Write a 2–4 paragraph Summary for Findings and Evidence that "
                "synthesizes the themes after the subsections. No claim markers."
            )
        },
        attachments=[("findings summary input", attachment)],
        session_path=session_dir / "codex-session-findings-summary.json",
        run_dir=run_dir,
        run_name="expand-findings-summary",
    )
    raw = document.get("findings_summary_paragraphs")
    paragraphs = (
        [str(item).strip() for item in raw if str(item).strip()]
        if isinstance(raw, list)
        else []
    )
    cleaned: list[str] = []
    for paragraph in paragraphs:
        if R.INLINE_CLAIM_CITE_RE.search(paragraph):
            paragraph = R.INLINE_CLAIM_CITE_RE.sub("", paragraph)
            paragraph = re.sub(r"\s{2,}", " ", paragraph).strip()
        if paragraph:
            cleaned.append(paragraph)
    if not cleaned:
        cleaned = _fallback_findings_summary(report_input, outline, arguments_doc)
        _progress("findings_summary_fallback", paragraphs=len(cleaned))
    else:
        _progress("findings_summary_ready", paragraphs=len(cleaned))
    R.write_json(
        work_dir / "findings-summary.json",
        {
            "schema_version": FINDINGS_SUMMARY_SCHEMA,
            "findings_summary_paragraphs": cleaned,
        },
    )
    return cleaned


def _soft_fill_missing_markers(
    paragraphs: list[str],
    missing_ids: list[str],
    report_input: dict[str, Any],
) -> list[str]:
    """Last-resort: one sentence + one marker per missing claim (never bulk dumps)."""
    registry = {claim["claim_id"]: claim for claim in report_input["evidence_registry"]}
    filled = list(paragraphs)
    for claim_id in missing_ids:
        claim = registry.get(claim_id) or {}
        statement = claim.get("statement") or claim.get("title") or "a related finding"
        if not isinstance(statement, str) or not statement.strip():
            statement = "a related finding"
        text = re.sub(r"\s+", " ", statement).strip().rstrip(".")
        if len(text) > 240:
            text = text[:239].rstrip() + "…"
        filled.append(f"The literature also records that {text} [@{claim_id}].")
    return filled


def _try_validate_or_soft_fill(
    document: dict[str, Any],
    *,
    expected_claim_ids: set[str],
    subsection_id: str,
    report_input: dict[str, Any],
) -> dict[str, Any]:
    try:
        return validate_expansion(
            document,
            expected_claim_ids=expected_claim_ids,
            subsection_id=subsection_id,
        )
    except R.CliError as error:
        message = str(error)
        if "missing inline markers" not in message and "omitted required claim_ids" not in message:
            raise
        paragraphs = R.require_string_list(document.get("paragraphs"), "expansion paragraphs")
        heading = R.require_string(document, "heading", "expansion")
        prose = "\n".join(paragraphs)
        inline = set(R.extract_inline_claim_ids(prose))
        missing = sorted(expected_claim_ids - inline)
        if not missing:
            # claim_ids array gap only — repair array via validate path after fill of empty
            missing = sorted(expected_claim_ids - set(
                document.get("claim_ids") or []
            )) or sorted(expected_claim_ids - inline)
        _progress(
            "expand_soft_fill",
            subsection_id=subsection_id,
            missing=len(missing),
            sample=missing[:5],
        )
        repaired = {
            "schema_version": EXPANSION_SCHEMA,
            "subsection_id": subsection_id,
            "heading": heading,
            "paragraphs": _soft_fill_missing_markers(paragraphs, missing, report_input),
            "claim_ids": sorted(expected_claim_ids),
        }
        return validate_expansion(
            repaired,
            expected_claim_ids=expected_claim_ids,
            subsection_id=subsection_id,
        )


def _expand_unit_chunk(
    root: Path,
    report_input: dict[str, Any],
    theses: list[dict[str, Any]],
    unit: dict[str, Any],
    claim_ids: list[str],
    *,
    work_dir: Path,
    session_dir: Path,
    run_dir: Path | None,
    chunk_index: int,
    chunk_count: int,
    parent_heading: str | None = None,
) -> dict[str, Any]:
    """Expand one outline unit (subsubsection or legacy subsection) claim chunk."""
    unit_id = str(unit.get("subsubsection_id") or unit.get("subsection_id") or "U")
    safe_id = re.sub(r"[^\w.-]+", "_", unit_id)
    chunk_path = work_dir / "expansions" / f"{safe_id}-chunk-{chunk_index:02d}.json"
    if chunk_path.is_file():
        try:
            loaded = R.read_json(chunk_path, "expansion chunk")
            return validate_expansion(
                loaded,
                expected_claim_ids=set(claim_ids),
                subsection_id=unit_id,
            )
        except R.CliError:
            pass

    cards = claim_cards_with_quotes(report_input, claim_ids)
    attachment = _write_attachment(
        work_dir / "expansions" / f"{safe_id}-chunk-{chunk_index:02d}-input.json",
        {
            "unit": {
                "unit_id": unit_id,
                "heading": unit.get("heading"),
                "points": unit.get("points") or [],
                "parent_heading": parent_heading,
            },
            "arguments": theses,
            "claim_cards": cards,
            "chunk_index": chunk_index,
            "chunk_count": chunk_count,
            "max_ids_per_cite_cluster": MAX_CITE_CLUSTER_SIZE,
            "required_claim_ids": claim_ids,
        },
    )

    last_error: Exception | None = None
    document: dict[str, Any] | None = None
    for attempt in range(1, EXPAND_CHUNK_RETRIES + 2):
        instruction = (
            "Expand this literature outline unit into detailed prose. "
            f"Cover ALL {len(claim_ids)} claim cards in this chunk—every claim_id "
            f"must appear as its own or small-group [@claim-id] marker. "
            f"Max {MAX_CITE_CLUSTER_SIZE} ids per [@…] marker. "
            "No compression, no word-count target. "
        )
        if parent_heading:
            instruction += (
                f"This unit is a \\subsubsection under the subsection "
                f"“{parent_heading}”; keep scope tight to this sub-theme. "
            )
        if chunk_count > 1:
            instruction += (
                "This is a continuation chunk of the same unit; write new "
                "paragraphs only for these claims. "
            )
        if attempt > 1 and document is not None:
            prose = "\n".join(
                p for p in (document.get("paragraphs") or []) if isinstance(p, str)
            )
            missing = sorted(set(claim_ids) - set(R.extract_inline_claim_ids(prose)))
            instruction = (
                "Revise this expansion chunk. Previous attempt missed inline markers "
                f"for {len(missing)} claim(s): {', '.join(missing[:20])}. "
                "Return a complete replacement chunk that keeps good prose and adds "
                f"one natural sentence with a single [@claim-id] for each missing claim. "
                f"Max {MAX_CITE_CLUSTER_SIZE} ids per marker. No bulk dumps."
            )
        try:
            document = _codex_json(
                root,
                prompt_name="expand-subsection.v1.md",
                payload={
                    "instruction": instruction,
                    "unit_id": unit_id,
                    "chunk_index": chunk_index,
                    "chunk_count": chunk_count,
                    "attempt": attempt,
                    "required_claim_count": len(claim_ids),
                    "required_claim_ids": claim_ids,
                },
                attachments=[("unit expand input", attachment)],
                session_path=session_dir
                / f"codex-session-expand-{safe_id}-{chunk_index:02d}.json",
                run_dir=run_dir,
                run_name=f"expand-{safe_id}-c{chunk_index:02d}-a{attempt}",
            )
            if "schema_version" not in document:
                document["schema_version"] = EXPANSION_SCHEMA
            if "heading" not in document or not str(document.get("heading") or "").strip():
                document["heading"] = unit.get("heading") or unit_id
            expansion = validate_expansion(
                document,
                expected_claim_ids=set(claim_ids),
                subsection_id=unit_id,
            )
            R.write_json(chunk_path, expansion)
            return expansion
        except R.CliError as error:
            last_error = error
            _progress(
                "expand_chunk_retry",
                unit_id=unit_id,
                chunk_index=chunk_index,
                attempt=attempt,
                error=str(error)[:200],
            )
            continue

    if document is None:
        document = {
            "schema_version": EXPANSION_SCHEMA,
            "subsection_id": unit_id,
            "heading": unit.get("heading") or unit_id,
            "paragraphs": [
                f"This unit develops {unit.get('heading') or unit_id} from the attached claims."
            ],
            "claim_ids": claim_ids,
        }
    expansion = _try_validate_or_soft_fill(
        document,
        expected_claim_ids=set(claim_ids),
        subsection_id=unit_id,
        report_input=report_input,
    )
    R.write_json(chunk_path, expansion)
    if last_error:
        _progress(
            "expand_chunk_recovered",
            unit_id=unit_id,
            chunk_index=chunk_index,
            prior_error=str(last_error)[:160],
        )
    return expansion


def _expand_claim_unit(
    root: Path,
    report_input: dict[str, Any],
    theses: list[dict[str, Any]],
    unit: dict[str, Any],
    *,
    work_dir: Path,
    session_dir: Path,
    run_dir: Path | None,
    parent_heading: str | None = None,
) -> dict[str, Any]:
    claim_ids = list(unit.get("claim_ids") or [])
    chunks = _chunk(claim_ids, EXPAND_BATCH_SIZE) or [[]]
    paragraphs: list[str] = []
    heading = str(unit.get("heading") or "")
    unit_id = str(unit.get("subsubsection_id") or unit.get("subsection_id") or "U")
    for chunk_index, chunk_ids in enumerate(chunks, start=1):
        if not chunk_ids:
            continue
        _progress(
            "expand_chunk_start",
            unit_id=unit_id,
            chunk_index=chunk_index,
            chunk_count=len(chunks),
            claim_count=len(chunk_ids),
        )
        part = _expand_unit_chunk(
            root,
            report_input,
            theses,
            unit,
            chunk_ids,
            work_dir=work_dir,
            session_dir=session_dir,
            run_dir=run_dir,
            chunk_index=chunk_index,
            chunk_count=len(chunks),
            parent_heading=parent_heading,
        )
        if chunk_index == 1 and part.get("heading"):
            heading = part["heading"]
        paragraphs.extend(part["paragraphs"])
    return {
        "heading": heading or unit_id,
        "paragraphs": paragraphs,
        "claim_ids": sorted(claim_ids),
        "subsections": [],
    }


def expand_subsection(
    root: Path,
    report_input: dict[str, Any],
    arguments_doc: dict[str, Any],
    node: dict[str, Any],
    *,
    work_dir: Path,
    session_dir: Path,
    run_dir: Path | None,
) -> dict[str, Any]:
    """Expand one outline subsection into nested subsubsections when planned."""
    arg_map = {item["argument_id"]: item for item in arguments_doc["arguments"]}
    theses = [
        {
            "argument_id": argument_id,
            "thesis": arg_map[argument_id]["thesis"],
            "role": arg_map[argument_id].get("role"),
        }
        for argument_id in node.get("argument_ids") or []
        if argument_id in arg_map
    ]
    claim_ids = list(node.get("claim_ids") or [])
    subsubs = list(node.get("subsubsections") or [])
    _progress(
        "expand_subsection_start",
        subsection_id=node["subsection_id"],
        heading=node["heading"],
        claim_count=len(claim_ids),
        subsubsections=len(subsubs),
    )

    # Drop subsubs that received no claims (threshold / partition leftovers).
    active_subsubs = [sub for sub in subsubs if sub.get("claim_ids")]
    if active_subsubs and len(active_subsubs) < len(subsubs):
        _progress(
            "expand_skip_empty_subsubs",
            subsection_id=node["subsection_id"],
            planned=len(subsubs),
            active=len(active_subsubs),
        )
    if len(active_subsubs) >= 2:
        nested: list[dict[str, Any]] = []
        for sub in active_subsubs:
            nested.append(
                _expand_claim_unit(
                    root,
                    report_input,
                    theses,
                    sub,
                    work_dir=work_dir,
                    session_dir=session_dir,
                    run_dir=run_dir,
                    parent_heading=str(node.get("heading") or ""),
                )
            )
        # Drop any unit that still produced no prose (should not happen).
        nested = [
            item
            for item in nested
            if (item.get("paragraphs") or item.get("subsections"))
        ]
        if len(nested) >= 2:
            expansion = {
                "schema_version": EXPANSION_SCHEMA,
                "subsection_id": node["subsection_id"],
                "heading": node["heading"],
                "paragraphs": [],
                "claim_ids": [],
                "subsections": nested,
            }
        else:
            # Fall through to flat expansion of the parent claim set.
            active_subsubs = []
    if len(active_subsubs) < 2:
        # Legacy flat subsection (no subsubs planned).
        flat = _expand_claim_unit(
            root,
            report_input,
            theses,
            {
                "subsection_id": node["subsection_id"],
                "heading": node["heading"],
                "points": node.get("points") or [],
                "claim_ids": claim_ids,
            },
            work_dir=work_dir,
            session_dir=session_dir,
            run_dir=run_dir,
        )
        expansion = {
            "schema_version": EXPANSION_SCHEMA,
            "subsection_id": node["subsection_id"],
            "heading": flat["heading"],
            "paragraphs": flat["paragraphs"],
            "claim_ids": flat["claim_ids"],
            "subsections": [],
        }
        # Flat path still needs dual-bind validation at the leaf.
        expansion = {
            **validate_expansion(
                expansion,
                expected_claim_ids=set(claim_ids),
                subsection_id=node["subsection_id"],
            ),
            "subsections": [],
        }

    R.write_json(work_dir / "expansions" / f"{node['subsection_id']}.json", expansion)
    _progress(
        "expand_subsection_done",
        subsection_id=node["subsection_id"],
        paragraphs=len(expansion.get("paragraphs") or []),
        nested=len(expansion.get("subsections") or []),
        claims=len(claim_ids),
    )
    return expansion


def reconcile_subsection(
    root: Path,
    report_input: dict[str, Any],
    subsection: dict[str, Any],
    missing_ids: list[str],
    *,
    work_dir: Path,
    session_dir: Path,
    run_dir: Path | None,
    round_index: int,
) -> dict[str, Any]:
    subsection_id = subsection.get("subsection_id") or "S"
    prior_ids = list(subsection.get("claim_ids") or [])
    expected = set(prior_ids) | set(missing_ids)
    cards = claim_cards_with_quotes(report_input, sorted(expected))
    attachment = _write_attachment(
        work_dir / "expansions" / f"{subsection_id}-reconcile-{round_index}-input.json",
        {
            "current_subsection": {
                "heading": subsection.get("heading"),
                "paragraphs": subsection.get("paragraphs") or [],
                "claim_ids": prior_ids,
            },
            "missing_claim_ids": missing_ids,
            "claim_cards": cards,
            "max_ids_per_cite_cluster": MAX_CITE_CLUSTER_SIZE,
        },
    )
    document = _codex_json(
        root,
        prompt_name="reconcile-subsection.v1.md",
        payload={
            "instruction": (
                "Revise only this subsection to fold in the missing claims. "
                "Keep existing substance; do not bulk-dump citations."
            ),
            "missing_count": len(missing_ids),
        },
        attachments=[("reconcile input", attachment)],
        session_path=session_dir / f"codex-session-reconcile-{subsection_id}.json",
        run_dir=run_dir,
        run_name=f"reconcile-{subsection_id}-r{round_index}",
    )
    if "schema_version" not in document:
        document["schema_version"] = EXPANSION_SCHEMA
    expansion = validate_expansion(
        document,
        expected_claim_ids=expected,
        subsection_id=str(subsection_id),
    )
    if isinstance(document.get("heading"), str) and document["heading"].strip():
        expansion["heading"] = document["heading"].strip()
    R.write_json(
        work_dir / "expansions" / f"{subsection_id}-reconcile-{round_index}.json",
        expansion,
    )
    return expansion


def assemble_draft(
    report_input: dict[str, Any],
    frontmatter: dict[str, Any],
    expansions: list[dict[str, Any]],
) -> dict[str, Any]:
    def as_draft_subsection(item: dict[str, Any]) -> dict[str, Any]:
        children = item.get("subsections") or []
        nested = [
            as_draft_subsection(child)
            for child in children
            if isinstance(child, dict)
        ]
        return {
            "heading": item.get("heading") or "Untitled",
            "paragraphs": list(item.get("paragraphs") or []),
            "claim_ids": list(item.get("claim_ids") or []),
            "subsections": nested,
        }

    findings_subsections = [
        as_draft_subsection(item)
        for item in expansions
        if isinstance(item, dict)
    ]
    findings_intro = frontmatter.get("findings_intro_paragraphs") or []
    if not isinstance(findings_intro, list):
        findings_intro = []
    findings_intro = [str(item).strip() for item in findings_intro if str(item).strip()]

    summary_paras = frontmatter.get("findings_summary_paragraphs") or []
    if not isinstance(summary_paras, list):
        summary_paras = []
    summary_paras = [str(item).strip() for item in summary_paras if str(item).strip()]
    # Closing Summary as a final subsection (after thematic expansions).
    if summary_paras:
        findings_subsections = [
            *findings_subsections,
            {
                "heading": SUMMARY_SUBSECTION_HEADING,
                "paragraphs": summary_paras,
                "claim_ids": [],
                "subsections": [],
            },
        ]

    sections = [
        {
            "section_id": "question",
            "paragraphs": list(frontmatter["question_paragraphs"]),
            "claim_ids": [],
            "subsections": [],
        },
        {
            "section_id": "search_scope",
            "paragraphs": list(frontmatter["search_scope_paragraphs"]),
            "claim_ids": [],
            "subsections": [],
        },
        {
            "section_id": "findings",
            # Section-level intro under "Findings and Evidence", before subsections.
            "paragraphs": findings_intro,
            "claim_ids": [],
            "subsections": findings_subsections,
        },
    ]
    return {
        "schema_version": R.DRAFT_SCHEMA,
        "report_id": report_input["report_id"],
        "template_id": report_input["template"]["template_id"],
        "title": frontmatter["title"],
        "sections": sections,
        "limitations": list(report_input["allowed_limitations"]),
    }


def _map_claim_to_subsection(
    outline: dict[str, Any],
    claim_id: str,
) -> str | None:
    for node in outline["findings"]:
        if claim_id in node["claim_ids"]:
            return node["subsection_id"]
    return None


def _findings_subsections(draft: dict[str, Any]) -> list[dict[str, Any]]:
    for section in draft.get("sections") or []:
        if isinstance(section, dict) and section.get("section_id") == "findings":
            subsections = section.get("subsections") or []
            if isinstance(subsections, list):
                return [item for item in subsections if isinstance(item, dict)]
    return []


def reconcile_draft(
    root: Path,
    report_input: dict[str, Any],
    draft: dict[str, Any],
    outline: dict[str, Any],
    *,
    work_dir: Path,
    session_dir: Path,
    run_dir: Path | None,
    max_rounds: int = MAX_RECONCILE_ROUNDS,
) -> tuple[dict[str, Any], int]:
    rounds = 0
    while rounds < max_rounds:
        missing = R.missing_claim_ids(draft, report_input)
        if not missing:
            break
        rounds += 1
        # Group missing claims by outline subsection.
        buckets: dict[str, list[str]] = {}
        residual: list[str] = []
        for claim_id in missing:
            subsection_id = _map_claim_to_subsection(outline, claim_id)
            if subsection_id:
                buckets.setdefault(subsection_id, []).append(claim_id)
            else:
                residual.append(claim_id)
        subsections = _findings_subsections(draft)
        by_heading_order = list(subsections)
        # Map outline subsection_id → current draft subsection via order when possible.
        outline_ids = [node["subsection_id"] for node in outline["findings"]]
        id_to_index = {subsection_id: index for index, subsection_id in enumerate(outline_ids)}

        updated: list[dict[str, Any]] = list(by_heading_order)
        for subsection_id, claim_ids in buckets.items():
            index = id_to_index.get(subsection_id)
            if index is None or index >= len(updated):
                residual.extend(claim_ids)
                continue
            current = dict(updated[index])
            current["subsection_id"] = subsection_id
            expansion = reconcile_subsection(
                root,
                report_input,
                current,
                claim_ids,
                work_dir=work_dir,
                session_dir=session_dir,
                run_dir=run_dir,
                round_index=rounds,
            )
            updated[index] = {
                "heading": expansion["heading"],
                "paragraphs": expansion["paragraphs"],
                "claim_ids": expansion["claim_ids"],
            }

        if residual:
            # Append or extend a residual thin subsection.
            residual_cards_heading = "Thin or boundary evidence"
            residual_index = next(
                (
                    index
                    for index, item in enumerate(updated)
                    if str(item.get("heading") or "") == residual_cards_heading
                ),
                None,
            )
            if residual_index is None:
                base = {
                    "subsection_id": "S_residual",
                    "heading": residual_cards_heading,
                    "paragraphs": [
                        "Some records remain useful mainly as boundary-setting evidence."
                    ],
                    "claim_ids": [],
                }
                expansion = reconcile_subsection(
                    root,
                    report_input,
                    base,
                    residual,
                    work_dir=work_dir,
                    session_dir=session_dir,
                    run_dir=run_dir,
                    round_index=rounds,
                )
                updated.append(
                    {
                        "heading": expansion["heading"],
                        "paragraphs": expansion["paragraphs"],
                        "claim_ids": expansion["claim_ids"],
                    }
                )
            else:
                current = dict(updated[residual_index])
                current["subsection_id"] = "S_residual"
                expansion = reconcile_subsection(
                    root,
                    report_input,
                    current,
                    residual,
                    work_dir=work_dir,
                    session_dir=session_dir,
                    run_dir=run_dir,
                    round_index=rounds,
                )
                updated[residual_index] = {
                    "heading": expansion["heading"],
                    "paragraphs": expansion["paragraphs"],
                    "claim_ids": expansion["claim_ids"],
                }

        for section in draft["sections"]:
            if section.get("section_id") == "findings":
                section["subsections"] = updated
                break

    return draft, rounds


def draft_literature(
    root: Path,
    report_input: dict[str, Any],
    *,
    output_path: Path,
    run_dir: Path | None,
    resume: bool = True,
) -> dict[str, Any]:
    """Full compress → outline → expand → assemble → reconcile pipeline."""
    output_path = output_path.expanduser().resolve()
    work_dir = output_path.parent
    work_dir.mkdir(parents=True, exist_ok=True)
    # Typical layout: <case>/work/draft.json → case root is parent of work/.
    case_root = work_dir.parent if work_dir.name == "work" else work_dir
    pipeline_dir = work_dir / "pipeline"
    pipeline_dir.mkdir(parents=True, exist_ok=True)
    report_input_sha256 = R.object_digest(report_input)
    resume, resume_reason = pipeline_resume_allowed(
        pipeline_dir,
        report_input_sha256,
        resume=resume,
    )
    session_dir = report_input_session_dir(case_root, report_input_sha256)
    session_dir.mkdir(parents=True, exist_ok=True)
    write_pipeline_meta(
        pipeline_dir,
        report_input_sha256=report_input_sha256,
        session_dir=session_dir,
    )

    registry_ids = {claim["claim_id"] for claim in report_input["evidence_registry"]}
    arguments_path = pipeline_dir / "arguments.json"
    outline_path = pipeline_dir / "outline.json"
    frontmatter_path = pipeline_dir / "frontmatter.json"
    findings_intro_path = pipeline_dir / "findings-intro.json"
    findings_summary_path = pipeline_dir / "findings-summary.json"
    _progress(
        "pipeline_start",
        claim_count=len(registry_ids),
        resume=resume,
        resume_reason=resume_reason,
        pipeline_dir=str(pipeline_dir),
    )

    if resume and arguments_path.is_file():
        try:
            arguments_doc = validate_arguments_document(
                R.read_json(arguments_path, "arguments"),
                registry_ids,
            )
        except R.CliError:
            arguments_doc = compress_arguments(
                root,
                report_input,
                work_dir=pipeline_dir,
                session_dir=session_dir,
                run_dir=run_dir,
            )
    else:
        arguments_doc = compress_arguments(
            root,
            report_input,
            work_dir=pipeline_dir,
            session_dir=session_dir,
            run_dir=run_dir,
        )

    if resume and outline_path.is_file():
        try:
            outline = validate_outline_document(
                R.read_json(outline_path, "outline"),
                arguments_doc,
            )
            # Re-write so claim-budgeted subsubs match what expand will use.
            R.write_json(outline_path, outline)
        except R.CliError:
            outline = build_outline(
                root,
                report_input,
                arguments_doc,
                work_dir=pipeline_dir,
                session_dir=session_dir,
                run_dir=run_dir,
            )
    else:
        outline = build_outline(
            root,
            report_input,
            arguments_doc,
            work_dir=pipeline_dir,
            session_dir=session_dir,
            run_dir=run_dir,
        )

    if resume and frontmatter_path.is_file():
        frontmatter = R.read_json(frontmatter_path, "frontmatter")
        if not isinstance(frontmatter.get("question_paragraphs"), list):
            frontmatter = expand_frontmatter(
                root,
                report_input,
                outline,
                work_dir=pipeline_dir,
                session_dir=session_dir,
                run_dir=run_dir,
            )
    else:
        frontmatter = expand_frontmatter(
            root,
            report_input,
            outline,
            work_dir=pipeline_dir,
            session_dir=session_dir,
            run_dir=run_dir,
        )

    # Findings section intro (roadmap under "Findings and Evidence").
    if resume and findings_intro_path.is_file():
        try:
            intro_doc = R.read_json(findings_intro_path, "findings intro")
            intro_paras = intro_doc.get("findings_intro_paragraphs")
            if isinstance(intro_paras, list) and intro_paras:
                frontmatter["findings_intro_paragraphs"] = [
                    str(item).strip() for item in intro_paras if str(item).strip()
                ]
            else:
                raise R.CliError("findings intro is empty")
        except R.CliError:
            frontmatter["findings_intro_paragraphs"] = expand_findings_intro(
                root,
                report_input,
                outline,
                arguments_doc,
                work_dir=pipeline_dir,
                session_dir=session_dir,
                run_dir=run_dir,
            )
    else:
        frontmatter["findings_intro_paragraphs"] = expand_findings_intro(
            root,
            report_input,
            outline,
            arguments_doc,
            work_dir=pipeline_dir,
            session_dir=session_dir,
            run_dir=run_dir,
        )
    # Keep frontmatter.json self-contained for inspectability.
    R.write_json(frontmatter_path, frontmatter)

    expansions: list[dict[str, Any]] = []
    for node in outline["findings"]:
        expansion_path = pipeline_dir / "expansions" / f"{node['subsection_id']}.json"
        if resume and expansion_path.is_file():
            try:
                loaded = R.read_json(expansion_path, "expansion")
                nested = list(loaded.get("subsections") or [])
                # Drop empty leaf units left by pre-threshold partitions.
                if nested:
                    nested = [
                        child
                        for child in nested
                        if isinstance(child, dict)
                        and (
                            (child.get("paragraphs") or [])
                            or (child.get("subsections") or [])
                        )
                    ]
                    loaded = {**loaded, "subsections": nested}
                if nested:
                    if len(nested) < 2:
                        raise R.CliError(
                            f"{node['subsection_id']} has fewer than 2 non-empty "
                            "subsubs after prune; re-expand"
                        )
                    # Nested subsub expansions: verify claim union matches outline.
                    bound = set(R.section_claim_ids(loaded))
                    expected = set(node.get("claim_ids") or [])
                    if bound != expected:
                        raise R.CliError(
                            f"{node['subsection_id']} nested claims mismatch "
                            f"(have {len(bound)}, want {len(expected)})"
                        )
                    expansions.append(loaded)
                else:
                    expansions.append(
                        validate_expansion(
                            loaded,
                            expected_claim_ids=set(node["claim_ids"]),
                            subsection_id=node["subsection_id"],
                        )
                    )
                continue
            except R.CliError:
                pass
        expansions.append(
            expand_subsection(
                root,
                report_input,
                arguments_doc,
                node,
                work_dir=pipeline_dir,
                session_dir=session_dir,
                run_dir=run_dir,
            )
        )

    # Closing Summary after all thematic expansions.
    if resume and findings_summary_path.is_file():
        try:
            summary_doc = R.read_json(findings_summary_path, "findings summary")
            summary_paras = summary_doc.get("findings_summary_paragraphs")
            if isinstance(summary_paras, list) and summary_paras:
                frontmatter["findings_summary_paragraphs"] = [
                    str(item).strip() for item in summary_paras if str(item).strip()
                ]
            else:
                raise R.CliError("findings summary is empty")
        except R.CliError:
            frontmatter["findings_summary_paragraphs"] = expand_findings_summary(
                root,
                report_input,
                outline,
                arguments_doc,
                expansions,
                work_dir=pipeline_dir,
                session_dir=session_dir,
                run_dir=run_dir,
            )
    else:
        frontmatter["findings_summary_paragraphs"] = expand_findings_summary(
            root,
            report_input,
            outline,
            arguments_doc,
            expansions,
            work_dir=pipeline_dir,
            session_dir=session_dir,
            run_dir=run_dir,
        )
    R.write_json(frontmatter_path, frontmatter)

    draft = assemble_draft(report_input, frontmatter, expansions)
    _progress(
        "assemble_done",
        subsections=len(expansions),
        has_intro=bool(frontmatter.get("findings_intro_paragraphs")),
        has_summary=bool(frontmatter.get("findings_summary_paragraphs")),
    )
    draft, reconcile_rounds = reconcile_draft(
        root,
        report_input,
        draft,
        outline,
        work_dir=pipeline_dir,
        session_dir=session_dir,
        run_dir=run_dir,
    )
    _progress("reconcile_done", rounds=reconcile_rounds)
    draft = R.normalize_model_draft(draft, report_input)
    validated = R.validate_draft(draft, report_input, root)
    _progress(
        "pipeline_validated",
        unused=len(R.missing_claim_ids(validated, report_input)),
        reconcile_rounds=reconcile_rounds,
    )
    validated["provenance"] = {
        "report_input_sha256": report_input_sha256,
        "prompt": "literature-pipeline:compress-outline-expand",
        "executor": R.LOCAL_EXECUTOR,
        "model": R.resolve_report_model(),
        "model_reasoning_effort": R.resolve_report_reasoning_effort(),
        "pipeline": "compress-outline-expand",
        "arguments_path": str((pipeline_dir / "arguments.json").resolve()),
        "outline_path": str((pipeline_dir / "outline.json").resolve()),
        "coverage_fill_rounds": reconcile_rounds,
        "unused_claims_remaining": R.missing_claim_ids(validated, report_input),
        "max_cite_cluster_size": MAX_CITE_CLUSTER_SIZE,
    }
    return validated
