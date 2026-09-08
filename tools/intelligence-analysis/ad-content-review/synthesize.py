"""LLM synthesize of ad-content judgments from frozen collection clues.

Default path: Codex via tools/codex/clue-codex-cli (local dev = production).
Optional --lexical-only for offline unit tests without a model.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

DEFAULT_MODEL = "gpt-5.4"
DEFAULT_TIMEOUT_S = 600


class SynthesizeError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def tools_root() -> Path:
    # intelligence-analysis/ad-content-review/ → tools/
    return Path(__file__).resolve().parents[2]


def package_root() -> Path:
    return Path(__file__).resolve().parent


def default_model() -> str:
    for key in (
        "AD_CONTENT_REVIEW_MODEL",
        "INTELLIGENCE_ANALYSIS_MODEL",
        "CODEX_MODEL",
    ):
        value = (os.environ.get(key) or "").strip()
        if value:
            return value
    return DEFAULT_MODEL


def _tokens(text: str) -> list[str]:
    return [t for t in re.findall(r"[\w\u4e00-\u9fff]{2,}", text.lower()) if t]


def _clue_text(clue: dict[str, Any]) -> str:
    meta = clue.get("source_metadata") if isinstance(clue.get("source_metadata"), dict) else {}
    parts: list[str] = []
    for key in ("title", "text", "display_name"):
        value = meta.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(value.strip())
    for obs in clue.get("observations") or []:
        if isinstance(obs, dict) and isinstance(obs.get("quote"), str):
            parts.append(obs["quote"].strip())
    return "\n".join(parts)


def _evidence_from_clue(clue: dict[str, Any], *, max_items: int = 3) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    meta = clue.get("source_metadata") if isinstance(clue.get("source_metadata"), dict) else {}
    for obs in clue.get("observations") or []:
        if not isinstance(obs, dict):
            continue
        quote = obs.get("quote")
        if not isinstance(quote, str) or not quote.strip():
            continue
        items.append(
            {
                "clue_id": str(clue.get("clue_id") or ""),
                "observation_id": str(
                    obs.get("observation_id") or f"{clue.get('clue_id')}:evidence"
                ),
                "relation": "supports",
                "quote": quote.strip()[:800],
                "source_url": str(clue.get("source_url") or ""),
                "observed_at": str(clue.get("observed_at") or ""),
                "locator": str(obs.get("locator") or "observation"),
                "source_metadata": {
                    key: meta[key]
                    for key in (
                        "title",
                        "platform",
                        "note_type",
                        "author_handle",
                        "record_kind",
                    )
                    if key in meta
                },
            }
        )
        if len(items) >= max_items:
            break
    return items


def _auto_pass_decision(*, note: str) -> dict[str, str]:
    return {"status": "approved", "note": note}


def _clue_index(clues: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for clue in clues:
        if not isinstance(clue, dict):
            continue
        cid = clue.get("clue_id")
        if isinstance(cid, str) and cid.strip():
            out[cid.strip()] = clue
    return out


def _pack_clues_for_prompt(clues: list[dict[str, Any]], *, limit: int = 40) -> list[dict[str, Any]]:
    packed: list[dict[str, Any]] = []
    for clue in clues[:limit]:
        if not isinstance(clue, dict):
            continue
        meta = clue.get("source_metadata") if isinstance(clue.get("source_metadata"), dict) else {}
        quotes = []
        for obs in clue.get("observations") or []:
            if isinstance(obs, dict) and isinstance(obs.get("quote"), str) and obs["quote"].strip():
                quotes.append(
                    {
                        "observation_id": obs.get("observation_id"),
                        "quote": obs["quote"].strip()[:500],
                        "locator": obs.get("locator"),
                    }
                )
        packed.append(
            {
                "clue_id": clue.get("clue_id"),
                "source_url": clue.get("source_url"),
                "platform": meta.get("platform"),
                "note_type": meta.get("note_type") or meta.get("record_kind"),
                "title": meta.get("title"),
                "author_handle": meta.get("author_handle"),
                "engagement": meta.get("engagement"),
                "quotes": quotes[:4],
            }
        )
    return packed


def build_synthesize_prompt(
    *,
    question: str,
    decision_context: str,
    audience: str,
    clues_payload: list[dict[str, Any]],
) -> str:
    clues_json = json.dumps(clues_payload, ensure_ascii=False, indent=2)
    return f"""You are an ad and social-content intelligence analyst.

Use ONLY the frozen content clues below. Do not invent posts, metrics, or quotes
that are not present. Prefer Chinese or English to match the audience language.

## Research question
{question}

## Decision context
{decision_context}

## Audience
{audience}

## Task
Produce 3–8 content-intelligence judgments that help answer the question.
Cover where supported:
- corpus/platform mix
- recurring themes, hooks, CTAs, product angles
- ad-like or commercial signals in the text
- notable engagement samples if engagement fields exist
- gaps / what the corpus cannot support

Each judgment MUST cite one or more real clue_id values from the list.

## Clues
{clues_json}

## Output
Return ONLY JSON:
{{
  "judgments": [
    {{
      "title": "short title",
      "statement": "one clear judgment sentence or short paragraph",
      "classification": "new|identical|contradictory|uncertain",
      "confidence": 0.0-1.0,
      "clue_ids": ["clue_id", "..."],
      "limitations": ["optional"]
    }}
  ],
  "unresolved": ["optional open questions or gaps"]
}}
"""


def parse_model_json(last_text: str) -> dict[str, Any]:
    text = (last_text or "").strip()
    if not text:
        raise SynthesizeError("Codex returned empty last message")
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
        if text.startswith("json"):
            text = text[4:].lstrip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            raise SynthesizeError("Codex last message is not JSON") from None
        try:
            parsed = json.loads(match.group(0))
        except json.JSONDecodeError as error:
            raise SynthesizeError(f"Codex JSON parse failed: {error}") from error
    if not isinstance(parsed, dict):
        raise SynthesizeError("Codex JSON must be an object")
    return parsed


def run_codex_synthesize(
    *,
    prompt: str,
    model: str,
    timeout_s: int,
    work_dir: Path | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Call clue-codex-cli exec; return (parsed JSON, meta)."""
    cli = tools_root() / "codex" / "clue-codex-cli"
    if not cli.is_file():
        raise SynthesizeError(f"clue-codex-cli missing: {cli}")
    schema = package_root() / "schemas" / "ad-content-judgments.schema.json"

    def _once(use_schema: bool) -> tuple[dict[str, Any], dict[str, Any]]:
        with tempfile.TemporaryDirectory(prefix="ad-content-synth-") as tmp:
            tmp_path = Path(work_dir) if work_dir else Path(tmp)
            tmp_path.mkdir(parents=True, exist_ok=True)
            codex_out = tmp_path / "codex-exec.json"
            cmd = [
                str(cli),
                "exec",
                "--prompt",
                prompt,
                "--output",
                str(codex_out),
                "--model",
                model,
                "--sandbox",
                "read-only",
                "--ephemeral",
                "--timeout",
                str(timeout_s),
            ]
            if use_schema and schema.is_file():
                cmd.extend(["--output-schema", str(schema)])
            completed = subprocess.run(cmd, text=True, capture_output=True, check=False)
            if completed.returncode != 0 or not codex_out.is_file():
                err = (completed.stderr or completed.stdout or "").strip()[:1000]
                raise SynthesizeError(
                    f"codex exec failed ({completed.returncode}): {err}"
                )
            wrapper = json.loads(codex_out.read_text(encoding="utf-8"))
            last = str(wrapper.get("last_message") or "")
            parsed = parse_model_json(last)
            meta = {
                "model": model,
                "codex_output": str(codex_out),
                "exit_code": completed.returncode,
                "used_output_schema": use_schema,
            }
            return parsed, meta

    # Prefer freeform JSON (more reliable than provider schema mode).
    try:
        return _once(False)
    except SynthesizeError:
        return _once(True)


def normalize_llm_judgments(
    raw: dict[str, Any],
    *,
    case_id: str,
    clues: list[dict[str, Any]],
    min_confidence: float,
) -> tuple[list[dict[str, Any]], list[str]]:
    by_id = _clue_index(clues)
    raw_list = raw.get("judgments") if isinstance(raw.get("judgments"), list) else []
    judgments: list[dict[str, Any]] = []
    claim_n = 0
    for item in raw_list:
        if not isinstance(item, dict):
            continue
        title = item.get("title") if isinstance(item.get("title"), str) else ""
        statement = item.get("statement") if isinstance(item.get("statement"), str) else ""
        if not title.strip() or not statement.strip():
            continue
        classification = str(item.get("classification") or "new").strip().lower()
        if classification not in {"new", "identical", "contradictory", "uncertain"}:
            classification = "new"
        try:
            confidence = float(item.get("confidence"))
        except (TypeError, ValueError):
            confidence = 0.6
        confidence = max(0.0, min(1.0, confidence))
        clue_ids = item.get("clue_ids") if isinstance(item.get("clue_ids"), list) else []
        bound_clues: list[dict[str, Any]] = []
        for cid in clue_ids:
            if isinstance(cid, str) and cid.strip() in by_id:
                bound_clues.append(by_id[cid.strip()])
        if not bound_clues:
            # Refuse ungrounded claims.
            continue
        evidence: list[dict[str, Any]] = []
        for clue in bound_clues[:6]:
            evidence.extend(_evidence_from_clue(clue, max_items=2))
        if not evidence:
            continue
        claim_n += 1
        claim_id = f"claim-{claim_n:03d}"
        status = "supported" if confidence >= min_confidence else "uncertain"
        if confidence < min_confidence:
            classification = "uncertain"
        limitations = item.get("limitations") if isinstance(item.get("limitations"), list) else []
        limitations = [str(x).strip() for x in limitations if str(x).strip()]
        if not limitations:
            limitations = ["LLM synthesis over frozen clue text only."]
        judgments.append(
            {
                "claim_id": claim_id,
                "title": title.strip()[:160],
                "statement": statement.strip()[:1200],
                "classification": classification,
                "status": status,
                "risk_level": "low",
                "confidence": round(confidence, 3),
                "questions": [],
                "limitations": limitations[:8],
                "validation": {"status": "valid", "errors": []},
                "review": {
                    "required": False,
                    "reasons": ["ad_content_llm_synthesize"],
                    "review_key": f"claim:{case_id}:{claim_id}",
                },
                "review_decision": _auto_pass_decision(
                    note=(
                        "Automatically resolved via ad-content-review LLM synthesize; "
                        "not human-reviewed."
                    )
                ),
                "evidence": evidence,
            }
        )
    unresolved = raw.get("unresolved") if isinstance(raw.get("unresolved"), list) else []
    unresolved = [str(x).strip() for x in unresolved if str(x).strip()]
    return judgments, unresolved


def _corpus_stats(clues: list[dict[str, Any]]) -> tuple[dict[str, int], dict[str, int]]:
    platforms: Counter[str] = Counter()
    forms: Counter[str] = Counter()
    for clue in clues:
        meta = clue.get("source_metadata") if isinstance(clue.get("source_metadata"), dict) else {}
        platforms[str(meta.get("platform") or "unknown")] += 1
        forms[str(meta.get("note_type") or meta.get("record_kind") or "other")] += 1
    return dict(platforms), dict(forms)


def _result_shell(
    *,
    case_id: str,
    snapshot_id: str,
    snapshot_sha256: str,
    judgments: list[dict[str, Any]],
    unresolved: list[str],
    platforms: dict[str, int],
    forms: dict[str, int],
    question: str,
    decision_context: str,
    executor_status: str,
    model: str | None,
) -> dict[str, Any]:
    return {
        "schema_version": "clue.intelligence.ad-content-review-result.v1",
        "status": "final",
        "case_id": case_id,
        "generated_at": utc_now(),
        "analysis_kind": "ad-content-review",
        "collection_snapshot": {
            "snapshot_id": snapshot_id,
            "sha256": snapshot_sha256,
        },
        "judgments": judgments,
        "rejected_claims": [],
        "unresolved": unresolved,
        "review": {
            "status": "completed",
            "approval_mode": "auto_pass",
            "review_set_id": f"{case_id}-ad-content-synth",
            "review_result_sha256": "sha256:"
            + hashlib.sha256(
                f"{case_id}:{len(judgments)}:{snapshot_sha256}:{executor_status}".encode()
            ).hexdigest(),
            "summary": {
                "executor": "ad-content-review",
                "executor_status": executor_status,
                "model": model,
                "judgment_count": len(judgments),
            },
        },
        "search_scope": {
            "question": question,
            "decision_context": decision_context,
            "platform_counts": platforms,
            "form_counts": forms,
        },
    }


def synthesize_judgments_lexical(
    *,
    case_id: str,
    question: str,
    decision_context: str,
    audience: str,
    clues: list[dict[str, Any]],
    snapshot_id: str,
    snapshot_sha256: str,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Offline lexical judgments for unit tests only (--lexical-only)."""
    del audience
    policy = policy or {}
    min_conf = float(policy.get("minimum_confidence") or 0.5)
    all_clues = [c for c in clues if isinstance(c, dict)]
    platforms, forms = _corpus_stats(all_clues)
    judgments: list[dict[str, Any]] = []
    if all_clues:
        plat_txt = ", ".join(f"{k}={v}" for k, v in list(platforms.items())[:5])
        evidence = []
        for clue in all_clues[:5]:
            evidence.extend(_evidence_from_clue(clue, max_items=1))
        if evidence:
            judgments.append(
                {
                    "claim_id": "claim-001",
                    "title": "Collection coverage",
                    "statement": (
                        f"The frozen ad-content corpus contains {len(all_clues)} "
                        f"record(s). Platform mix: {plat_txt or 'n/a'}."
                    ),
                    "classification": "new",
                    "status": "supported",
                    "risk_level": "low",
                    "confidence": 0.85 if len(all_clues) >= 1 else 0.4,
                    "questions": [],
                    "limitations": ["Lexical-only offline path (--lexical-only)."],
                    "validation": {"status": "valid", "errors": []},
                    "review": {
                        "required": False,
                        "reasons": ["ad_content_lexical"],
                        "review_key": f"claim:{case_id}:claim-001",
                    },
                    "review_decision": _auto_pass_decision(
                        note="Lexical-only synthesize for offline tests."
                    ),
                    "evidence": evidence,
                }
            )
    # Theme tokens
    stop = {"what", "the", "and", "for", "content", "什么", "怎么", "内容", "分析"}
    keywords = [t for t in _tokens(f"{question} {decision_context}") if t not in stop][:12]
    claim_n = 1
    for key in keywords:
        hits = [c for c in all_clues if key in _clue_text(c).lower() or key in _clue_text(c)]
        if not hits:
            continue
        claim_n += 1
        ev: list[dict[str, Any]] = []
        for clue in hits[:4]:
            ev.extend(_evidence_from_clue(clue, max_items=1))
        if not ev:
            continue
        conf = min(0.55 + 0.08 * len(hits), 0.9)
        judgments.append(
            {
                "claim_id": f"claim-{claim_n:03d}",
                "title": f"Theme signal: {key}",
                "statement": (
                    f"At least {len(hits)} record(s) mention “{key}” from the "
                    f"research question scope."
                ),
                "classification": "new" if conf >= min_conf else "uncertain",
                "status": "supported" if conf >= min_conf else "uncertain",
                "risk_level": "low",
                "confidence": round(conf, 3),
                "questions": [],
                "limitations": ["Lexical match only.", f"support_n={len(hits)}"],
                "validation": {"status": "valid", "errors": []},
                "review": {
                    "required": False,
                    "reasons": ["ad_content_lexical"],
                    "review_key": f"claim:{case_id}:claim-{claim_n:03d}",
                },
                "review_decision": _auto_pass_decision(
                    note="Lexical-only synthesize for offline tests."
                ),
                "evidence": ev,
            }
        )
    unresolved = ["Lexical-only path; use default LLM synthesize for real runs."]
    if not all_clues:
        unresolved.insert(0, "No clues in snapshot.")
    return _result_shell(
        case_id=case_id,
        snapshot_id=snapshot_id,
        snapshot_sha256=snapshot_sha256,
        judgments=judgments,
        unresolved=unresolved,
        platforms=platforms,
        forms=forms,
        question=question,
        decision_context=decision_context,
        executor_status="lexical-only",
        model=None,
    )


def synthesize_judgments(
    *,
    case_id: str,
    question: str,
    decision_context: str,
    audience: str,
    clues: list[dict[str, Any]],
    snapshot_id: str,
    snapshot_sha256: str,
    policy: dict[str, Any] | None = None,
    model: str | None = None,
    timeout_s: int | None = None,
    lexical_only: bool = False,
    work_dir: Path | None = None,
) -> dict[str, Any]:
    """Build ad-content-review result. Default = LLM; lexical_only for tests."""
    if lexical_only:
        return synthesize_judgments_lexical(
            case_id=case_id,
            question=question,
            decision_context=decision_context,
            audience=audience,
            clues=clues,
            snapshot_id=snapshot_id,
            snapshot_sha256=snapshot_sha256,
            policy=policy,
        )

    policy = policy or {}
    min_conf = float(policy.get("minimum_confidence") or 0.55)
    all_clues = [c for c in clues if isinstance(c, dict)]
    platforms, forms = _corpus_stats(all_clues)
    if not all_clues:
        return _result_shell(
            case_id=case_id,
            snapshot_id=snapshot_id,
            snapshot_sha256=snapshot_sha256,
            judgments=[],
            unresolved=["No clues in snapshot; cannot form content judgments."],
            platforms=platforms,
            forms=forms,
            question=question,
            decision_context=decision_context,
            executor_status="llm",
            model=model or default_model(),
        )

    model_id = model or default_model()
    timeout = int(timeout_s or DEFAULT_TIMEOUT_S)
    packed = _pack_clues_for_prompt(all_clues)
    prompt = build_synthesize_prompt(
        question=question,
        decision_context=decision_context,
        audience=audience,
        clues_payload=packed,
    )
    raw, meta = run_codex_synthesize(
        prompt=prompt,
        model=model_id,
        timeout_s=timeout,
        work_dir=work_dir,
    )
    judgments, unresolved = normalize_llm_judgments(
        raw, case_id=case_id, clues=all_clues, min_confidence=min_conf
    )
    if not judgments:
        raise SynthesizeError(
            "LLM returned no judgments grounded in clue_ids; "
            "check model output or clue snapshot."
        )
    if not unresolved:
        unresolved = [
            "Judgments are model-synthesized over frozen clue text only "
            "(captions/metadata/transcripts present in the snapshot)."
        ]
    result = _result_shell(
        case_id=case_id,
        snapshot_id=snapshot_id,
        snapshot_sha256=snapshot_sha256,
        judgments=judgments,
        unresolved=unresolved,
        platforms=platforms,
        forms=forms,
        question=question,
        decision_context=decision_context,
        executor_status="llm",
        model=model_id,
    )
    result["review"]["summary"]["codex"] = meta
    return result
