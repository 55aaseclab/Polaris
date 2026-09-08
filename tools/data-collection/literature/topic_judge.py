"""LLM topic-judge for literature collections via tools/codex.

Domain rules stay in collection input (question / include / exclude /
topic_criteria). This module batches records, calls clue-codex-cli, and
caches judgments under POLARIS_LITERATURE_CACHE_ROOT/topic-judgments/ for re-runs.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


# literature/ → data-collection/ → tools/
_TOOLS = Path(__file__).resolve().parents[2]
_CODEX_CLI = _TOOLS / "codex" / "clue-codex-cli"
_DEFAULT_BATCH = 12
_DEFAULT_TIMEOUT = 900


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def log(message: str, **fields: Any) -> None:
    payload: dict[str, Any] = {
        "ts": utc_now(),
        "level": "info",
        "msg": message,
        "component": "literature_topic_judge",
    }
    payload.update(fields)
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def topic_criteria_from_input(input_value: dict[str, Any] | None) -> list[str]:
    """Collect topic_criteria / aliases from literature input."""
    if not isinstance(input_value, dict):
        return []
    payload = input_value.get("payload") if isinstance(input_value.get("payload"), dict) else {}
    lit = (
        payload.get("literature_scope")
        if isinstance(payload.get("literature_scope"), dict)
        else {}
    )
    scope = input_value.get("scope") if isinstance(input_value.get("scope"), dict) else {}
    for blob in (lit, input_value, scope):
        for key in ("topic_criteria", "judgment_criteria", "criteria"):
            raw = blob.get(key)
            if not isinstance(raw, list):
                continue
            items = [str(x).strip() for x in raw if isinstance(x, (str, int, float)) and str(x).strip()]
            if items:
                return items
    return []


def topic_judge_config(input_value: dict[str, Any] | None) -> dict[str, Any]:
    """Normalize payload.literature_scope.topic_judge config.

    Defaults:
      enabled: true when topic_criteria present, else false
      stages: ["seed", "expand"] when criteria present
        (add "post_expand" for a final full-corpus pass)
      batch_size: 12
      cache: true
      model: from CODEX_MODEL / gpt-5.4-mini
    """
    if not isinstance(input_value, dict):
        return {"enabled": False, "stages": [], "batch_size": _DEFAULT_BATCH, "cache": True}
    payload = input_value.get("payload") if isinstance(input_value.get("payload"), dict) else {}
    lit = (
        payload.get("literature_scope")
        if isinstance(payload.get("literature_scope"), dict)
        else {}
    )
    raw = lit.get("topic_judge") if isinstance(lit.get("topic_judge"), dict) else {}
    criteria = topic_criteria_from_input(input_value)
    if "enabled" in raw:
        enabled = bool(raw["enabled"])
    else:
        enabled = bool(criteria)
    stages_raw = raw.get("stages")
    if isinstance(stages_raw, list) and stages_raw:
        stages = [str(s).strip() for s in stages_raw if str(s).strip()]
    elif isinstance(stages_raw, str) and stages_raw.strip():
        stages = [stages_raw.strip()]
    else:
        # Seed + expand-time LLM when criteria exist; post_expand opt-in.
        stages = ["seed", "expand"] if criteria else ["seed"]
    try:
        batch_size = int(raw.get("batch_size") or _DEFAULT_BATCH)
    except (TypeError, ValueError):
        batch_size = _DEFAULT_BATCH
    batch_size = max(1, min(batch_size, 40))
    try:
        timeout_s = int(raw.get("timeout_s") or raw.get("timeout") or _DEFAULT_TIMEOUT)
    except (TypeError, ValueError):
        timeout_s = _DEFAULT_TIMEOUT
    max_papers = raw.get("max_papers")
    if max_papers is not None:
        try:
            max_papers = int(max_papers)
        except (TypeError, ValueError):
            max_papers = None
    model = raw.get("model")
    if not isinstance(model, str) or not model.strip():
        model = (
            os.environ.get("POLARIS_LITERATURE_ANALYSIS_MODEL")
            or os.environ.get("POLARIS_LITERATURE_CODEX_MODEL")
            or os.environ.get("CODEX_MODEL")
            or "gpt-5.4-mini"
        ).strip()
    return {
        "enabled": enabled,
        "stages": stages,
        "batch_size": batch_size,
        "cache": raw.get("cache", True) is not False,
        "model": model,
        "timeout_s": timeout_s,
        "max_papers": max_papers,
        "criteria": criteria,
    }


def cache_root() -> Path:
    env = (os.environ.get("TOPIC_JUDGE_CACHE") or "").strip()
    if env:
        return Path(env).expanduser().resolve()
    shared = (os.environ.get("POLARIS_LITERATURE_CACHE_ROOT") or "").strip()
    if not shared:
        raise RuntimeError("POLARIS_LITERATURE_CACHE_ROOT is required for topic-judgments cache")
    return Path(shared).expanduser().resolve() / "topic-judgments"


def _paper_fields(record: dict[str, Any]) -> dict[str, str]:
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    title = payload.get("title") or payload.get("display_name") or ""
    if isinstance(title, list):
        title = title[0] if title else ""
    abstract = payload.get("abstract") or ""
    if isinstance(abstract, dict):
        abstract = abstract.get("text") or abstract.get("value") or ""
    rid = str(record.get("record_id") or payload.get("DOI") or payload.get("doi") or "")
    return {
        "record_id": rid,
        "title": str(title).strip(),
        "abstract": str(abstract).strip()[:4000],
    }


def _scope_fingerprint(input_value: dict[str, Any], criteria: list[str]) -> str:
    scope = input_value.get("scope") if isinstance(input_value.get("scope"), dict) else {}
    blob = {
        "question": str(input_value.get("question") or ""),
        "include": scope.get("include") if isinstance(scope.get("include"), list) else [],
        "exclude": scope.get("exclude") if isinstance(scope.get("exclude"), list) else [],
        "criteria": criteria,
    }
    raw = json.dumps(blob, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def judgment_cache_key(
    *,
    record_id: str,
    title: str,
    abstract: str,
    scope_fp: str,
    model: str,
) -> str:
    material = "\n".join([scope_fp, model, record_id, title, abstract])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _cache_path(key: str) -> Path:
    return cache_root() / key[:2] / f"{key}.json"


def cache_get(key: str) -> dict[str, Any] | None:
    path = _cache_path(key)
    if not path.is_file():
        return None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(doc, dict) or "in_scope" not in doc:
        return None
    return doc


def cache_put(key: str, judgment: dict[str, Any]) -> None:
    path = _cache_path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(judgment, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _resolve_codex_cli() -> Path:
    env = (
        os.environ.get("POLARIS_LITERATURE_CODEX_CLI")
        or os.environ.get("CODEX_CLI")
        or ""
    ).strip()
    if env:
        return Path(env).expanduser().resolve()
    return _CODEX_CLI


def run_codex_topic_judge(
    *,
    scope_path: Path,
    records: list[dict[str, Any]],
    output_path: Path,
    model: str,
    timeout_s: int,
) -> dict[str, Any]:
    """Invoke tools/codex topic-judge for one batch; return wrapper JSON."""
    cli = _resolve_codex_cli()
    if not cli.is_file():
        raise RuntimeError(f"clue-codex-cli not found: {cli}")
    records_path = output_path.with_suffix(output_path.suffix + ".records.json")
    records_path.write_text(
        json.dumps({"records": records}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    cmd = [
        str(cli),
        "topic-judge",
        "--scope",
        str(scope_path),
        "--records",
        str(records_path),
        "--output",
        str(output_path),
        "--model",
        model,
        "--sandbox",
        "read-only",
        "--timeout",
        str(timeout_s),
    ]
    completed = subprocess.run(
        cmd,
        text=True,
        capture_output=True,
        check=False,
        stdin=subprocess.DEVNULL,
        timeout=timeout_s + 60,
    )
    if not output_path.is_file():
        raise RuntimeError(
            f"topic-judge produced no output (exit {completed.returncode}): "
            f"{(completed.stderr or completed.stdout or '')[:800]}"
        )
    try:
        wrapper = json.loads(output_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"cannot read topic-judge output: {error}") from error
    if not isinstance(wrapper, dict):
        raise RuntimeError("topic-judge output must be a JSON object")
    wrapper["_cli_exit_code"] = completed.returncode
    wrapper["_cli_stderr"] = (completed.stderr or "")[-4000:]
    return wrapper


def judge_records(
    records: list[dict[str, Any]],
    input_value: dict[str, Any],
    *,
    work_dir: Path,
    stage: str,
    scope_path: Path | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Judge records; return accepted, rejected, judgments, cache stats."""
    cfg = config or topic_judge_config(input_value)
    criteria = list(cfg.get("criteria") or topic_criteria_from_input(input_value))
    model = str(cfg.get("model") or "gpt-5.4-mini")
    batch_size = int(cfg.get("batch_size") or _DEFAULT_BATCH)
    use_cache = cfg.get("cache", True) is not False
    timeout_s = int(cfg.get("timeout_s") or _DEFAULT_TIMEOUT)
    max_papers = cfg.get("max_papers")

    papers_meta: list[tuple[dict[str, Any], dict[str, str]]] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        fields = _paper_fields(record)
        if not fields["record_id"] or not fields["title"]:
            continue
        papers_meta.append((record, fields))
    if isinstance(max_papers, int) and max_papers >= 0:
        papers_meta = papers_meta[:max_papers]

    scope_fp = _scope_fingerprint(input_value, criteria)
    work_dir.mkdir(parents=True, exist_ok=True)
    if scope_path is None:
        scope_path = work_dir / "topic-judge-scope.json"
        scope_path.write_text(
            json.dumps(input_value, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    by_id: dict[str, dict[str, Any]] = {}
    cache_hits = 0
    cache_misses = 0
    pending: list[tuple[dict[str, Any], dict[str, str], str]] = []

    for record, fields in papers_meta:
        key = judgment_cache_key(
            record_id=fields["record_id"],
            title=fields["title"],
            abstract=fields["abstract"],
            scope_fp=scope_fp,
            model=model,
        )
        if use_cache:
            hit = cache_get(key)
            if hit is not None:
                cache_hits += 1
                by_id[fields["record_id"]] = {
                    **hit,
                    "record_id": fields["record_id"],
                    "title": fields["title"],
                    "cache_hit": True,
                }
                continue
        cache_misses += 1
        pending.append((record, fields, key))

    batch_results: list[dict[str, Any]] = []
    for start in range(0, len(pending), batch_size):
        chunk = pending[start : start + batch_size]
        batch_records = [item[0] for item in chunk]
        batch_idx = start // batch_size + 1
        out_path = work_dir / f"{stage}-batch-{batch_idx:04d}.json"
        log(
            "topic_judge_batch_start",
            stage=stage,
            batch=batch_idx,
            size=len(chunk),
            model=model,
        )
        wrapper = run_codex_topic_judge(
            scope_path=scope_path,
            records=batch_records,
            output_path=out_path,
            model=model,
            timeout_s=timeout_s,
        )
        batch_results.append(
            {
                "batch": batch_idx,
                "path": str(out_path),
                "exit_code": wrapper.get("codex_exit_code") or wrapper.get("_cli_exit_code"),
                "in_scope_count": wrapper.get("in_scope_count"),
                "parse_error": wrapper.get("parse_error"),
            }
        )
        for judgment in wrapper.get("judgments") or []:
            if not isinstance(judgment, dict) or not judgment.get("record_id"):
                continue
            rid = str(judgment["record_id"])
            cleaned = {
                "record_id": rid,
                "in_scope": bool(judgment.get("in_scope")),
                "confidence": float(judgment.get("confidence") or 0.0),
                "reason": str(judgment.get("reason") or ""),
                "matched_aspects": judgment.get("matched_aspects")
                if isinstance(judgment.get("matched_aspects"), list)
                else [],
                "title": str(judgment.get("title") or ""),
                "cache_hit": False,
                "model": model,
                "scope_fp": scope_fp,
            }
            by_id[rid] = cleaned
        # Write cache for this chunk's keys.
        if use_cache:
            for _record, fields, key in chunk:
                item = by_id.get(fields["record_id"])
                if item is not None:
                    cache_put(key, {k: v for k, v in item.items() if k != "cache_hit"})

    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    ordered_judgments: list[dict[str, Any]] = []
    for record, fields in papers_meta:
        rid = fields["record_id"]
        judgment = by_id.get(rid)
        if judgment is None:
            judgment = {
                "record_id": rid,
                "in_scope": False,
                "confidence": 0.0,
                "reason": "missing judgment from model",
                "matched_aspects": [],
                "title": fields["title"],
                "cache_hit": False,
            }
            by_id[rid] = judgment
        ordered_judgments.append(judgment)
        decision = {
            "stage": f"topic_judge:{stage}",
            "in_scope": bool(judgment.get("in_scope")),
            "confidence": judgment.get("confidence"),
            "reason": judgment.get("reason"),
            "matched_aspects": judgment.get("matched_aspects"),
            "model": model,
            "cache_hit": bool(judgment.get("cache_hit")),
        }
        annotated = {**record, "topic_judgment": decision}
        if judgment.get("in_scope"):
            accepted.append(annotated)
        else:
            scope_decision = dict(annotated.get("scope_decision") or {})
            reasons = list(scope_decision.get("reasons") or [])
            reasons.append(f"topic_judge_out:{stage}")
            if judgment.get("reason"):
                reasons.append(str(judgment["reason"])[:240])
            scope_decision["in_bounds"] = False
            scope_decision["reasons"] = reasons
            scope_decision["topic_judge"] = decision
            annotated["scope_decision"] = scope_decision
            rejected.append(annotated)

    # Records without title/id pass through as accepted (cannot judge).
    judged_ids = {fields["record_id"] for _r, fields in papers_meta}
    for record in records:
        if not isinstance(record, dict):
            continue
        fields = _paper_fields(record)
        if fields["record_id"] in judged_ids:
            continue
        accepted.append(record)

    in_scope_n = sum(1 for j in ordered_judgments if j.get("in_scope"))
    summary = {
        "schema_version": "clue.codex.topic-judge.v1",
        "stage": stage,
        "model": model,
        "criteria": criteria,
        "input_count": len(papers_meta),
        "in_scope_count": in_scope_n,
        "out_of_scope_count": len(ordered_judgments) - in_scope_n,
        "accepted_count": len(accepted),
        "rejected_count": len(rejected),
        "cache_hits": cache_hits,
        "cache_misses": cache_misses,
        "batches": batch_results,
        "judgments": ordered_judgments,
    }

    log(
        "topic_judge_done",
        stage=stage,
        input_count=summary["input_count"],
        in_scope=summary["in_scope_count"],
        out_of_scope=summary["out_of_scope_count"],
        cache_hits=cache_hits,
        cache_misses=cache_misses,
        batches=len(batch_results),
        model=model,
    )
    return {
        "accepted": accepted,
        "rejected": rejected,
        "summary": summary,
    }


class ExpandTopicJudgeBuffer:
    """Batch LLM topic-judge for expand candidates (after keyword/year/venue).

    Flow: keyword-pass candidates are queued; when the batch is full (or
    ``flush`` is forced) they are judged via cache + codex. Only in-scope
    papers should join the expand corpus/frontier.
    """

    def __init__(
        self,
        input_value: dict[str, Any],
        *,
        work_dir: Path,
        scope_path: Path | None = None,
        config: dict[str, Any] | None = None,
    ) -> None:
        self.input_value = input_value
        self.cfg = config or topic_judge_config(input_value)
        self.work_dir = work_dir
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self.scope_path = scope_path
        self.batch_size = int(self.cfg.get("batch_size") or _DEFAULT_BATCH)
        self._pending: list[dict[str, Any]] = []
        self._batch_seq = 0
        self.stats = {
            "queued": 0,
            "judged": 0,
            "accepted": 0,
            "rejected": 0,
            "cache_hits": 0,
            "cache_misses": 0,
            "batches": 0,
            "errors": 0,
        }
        self.enabled = bool(self.cfg.get("enabled")) and "expand" in (
            self.cfg.get("stages") or []
        )

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    def enqueue(self, candidate: dict[str, Any]) -> None:
        """Queue a keyword-pass candidate for LLM judgment (no auto-flush)."""
        if not self.enabled:
            return
        self._pending.append(candidate)
        self.stats["queued"] += 1

    def flush(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Judge all pending candidates. Returns (accepted, rejected)."""
        if not self._pending:
            return [], []
        # Judge in batch_size chunks so codex prompts stay bounded.
        accepted_all: list[dict[str, Any]] = []
        rejected_all: list[dict[str, Any]] = []
        pending = list(self._pending)
        self._pending.clear()
        for start in range(0, len(pending), self.batch_size):
            chunk = pending[start : start + self.batch_size]
            acc, rej = self._flush_chunk(chunk)
            accepted_all.extend(acc)
            rejected_all.extend(rej)
        return accepted_all, rejected_all

    def _flush_chunk(
        self, batch: list[dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        self._batch_seq += 1
        stage = f"expand-batch-{self._batch_seq:04d}"
        try:
            result = judge_records(
                batch,
                self.input_value,
                work_dir=self.work_dir,
                stage=stage,
                scope_path=self.scope_path,
                config=self.cfg,
            )
        except Exception as error:  # noqa: BLE001
            self.stats["errors"] += 1
            log(
                "topic_judge_expand_batch_failed",
                batch=self._batch_seq,
                size=len(batch),
                error=str(error)[:400],
            )
            # Fail closed: do not admit unjudged expand candidates.
            rejected = []
            for rec in batch:
                decision = {
                    "stage": "topic_judge:expand",
                    "in_scope": False,
                    "confidence": 0.0,
                    "reason": f"topic_judge_error:{error}"[:240],
                    "matched_aspects": [],
                    "cache_hit": False,
                }
                scope_decision = dict(rec.get("scope_decision") or {})
                reasons = list(scope_decision.get("reasons") or [])
                reasons.append("topic_judge_error")
                scope_decision["in_bounds"] = False
                scope_decision["reasons"] = reasons
                scope_decision["topic_judge"] = decision
                rejected.append(
                    {
                        **rec,
                        "topic_judgment": decision,
                        "scope_decision": scope_decision,
                    }
                )
            self.stats["judged"] += len(batch)
            self.stats["rejected"] += len(batch)
            return [], rejected

        summary = result.get("summary") or {}
        self.stats["judged"] += int(summary.get("input_count") or len(batch))
        self.stats["accepted"] += len(result.get("accepted") or [])
        self.stats["rejected"] += len(result.get("rejected") or [])
        self.stats["cache_hits"] += int(summary.get("cache_hits") or 0)
        self.stats["cache_misses"] += int(summary.get("cache_misses") or 0)
        self.stats["batches"] += 1
        log(
            "topic_judge_expand_flush",
            batch=self._batch_seq,
            accepted=len(result.get("accepted") or []),
            rejected=len(result.get("rejected") or []),
            cache_hits=summary.get("cache_hits"),
            cache_misses=summary.get("cache_misses"),
        )
        return list(result.get("accepted") or []), list(result.get("rejected") or [])


def apply_topic_judge(
    collection: dict[str, Any],
    input_value: dict[str, Any],
    *,
    work_dir: Path,
    stage: str,
    scope_path: Path | None = None,
) -> dict[str, Any]:
    """Filter collection.records with topic-judge for the given stage."""
    cfg = topic_judge_config(input_value)
    if not cfg["enabled"] or stage not in cfg["stages"]:
        return collection
    records = [r for r in (collection.get("records") or []) if isinstance(r, dict)]
    if not records:
        return collection

    stage_dir = work_dir / f"topic-judge-{stage}"
    result = judge_records(
        records,
        input_value,
        work_dir=stage_dir,
        stage=stage,
        scope_path=scope_path,
        config=cfg,
    )
    prior_rejected = [
        r for r in (collection.get("rejected_records") or []) if isinstance(r, dict)
    ]
    summary = result["summary"]
    summary_path = stage_dir / "summary.json"
    stage_dir.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    topic_judgments = dict(collection.get("topic_judgments") or {})
    topic_judgments[stage] = {
        "schema_version": summary.get("schema_version"),
        "model": summary.get("model"),
        "input_count": summary.get("input_count"),
        "in_scope_count": summary.get("in_scope_count"),
        "out_of_scope_count": summary.get("out_of_scope_count"),
        "cache_hits": summary.get("cache_hits"),
        "cache_misses": summary.get("cache_misses"),
        "criteria": summary.get("criteria"),
        "artifact_path": str(summary_path),
        "judgments": summary.get("judgments"),
    }

    out = {
        **collection,
        "records": result["accepted"],
        "rejected_records": prior_rejected + result["rejected"],
        "topic_judgments": topic_judgments,
    }
    gaps = list(out.get("information_gaps") or [])
    gaps.append(
        f"LLM topic-judge ({stage}): {summary['in_scope_count']} in / "
        f"{summary['out_of_scope_count']} out "
        f"(cache hits {summary['cache_hits']}, misses {summary['cache_misses']})."
    )
    out["information_gaps"] = list(dict.fromkeys(gaps))
    return out
