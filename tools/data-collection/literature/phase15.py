"""Phase 1.5 — expansion: citation/reference graph growth + re-screen.

Runs after phase 1 collection and before phase 2 augmentation.
See README.md (section Phase 1.5).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from literature.expand import expand_collection
from literature.phase1 import collect_paper_links
from literature.scope import bounds_from_input, topic_keywords_from_input
from literature.support import log
from literature.topic_judge import apply_topic_judge, topic_judge_config


def run_expansion(
    *,
    input_value: dict[str, Any],
    collected: dict[str, Any],
    collection_base: Path,
    run_prefix: str,
    expand_dir: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Expand literature corpus; return (collection, phase_record).

    phase_record uses phase name ``expansion`` (phase_id 1 sub-step).
    """
    expand_cfg: dict[str, Any] = {}
    payload = input_value.get("payload")
    if isinstance(payload, dict) and isinstance(payload.get("citation_expansion"), dict):
        expand_cfg = payload["citation_expansion"]
    if expand_cfg.get("enabled") is False:
        return collected, {
            "phase_id": 1,
            "phase": "expansion",
            "status": "skipped",
            "reason": "payload.citation_expansion.enabled=false",
        }

    bounds = bounds_from_input(input_value)
    topic_keywords = topic_keywords_from_input(input_value)
    max_rounds = expand_cfg.get("max_rounds")
    if max_rounds is not None:
        try:
            max_rounds = int(max_rounds)
        except (TypeError, ValueError):
            max_rounds = None

    use_s2 = expand_cfg.get("use_semantic_scholar")
    if use_s2 is None:
        use_s2 = expand_cfg.get("semantic_scholar", True)
    use_s2 = bool(use_s2)

    sleep_s = expand_cfg.get("sleep_s")
    try:
        sleep_s = float(sleep_s) if sleep_s is not None else (1.0 if use_s2 else 0.8)
    except (TypeError, ValueError):
        sleep_s = 1.0 if use_s2 else 0.8
    if use_s2 and sleep_s < 1.0:
        sleep_s = 1.0

    tj_cfg = topic_judge_config(input_value)
    log(
        "expand_phase_start",
        seed_records=len(collected.get("records") or []),
        bounds=bounds.to_dict(),
        max_rounds=max_rounds,
        topic_keywords=topic_keywords,
        use_semantic_scholar=use_s2,
        sleep_s=sleep_s,
        topic_judge_expand=bool(
            tj_cfg.get("enabled") and "expand" in (tj_cfg.get("stages") or [])
        ),
        topic_judge_model=tj_cfg.get("model"),
    )

    expand_dir.mkdir(parents=True, exist_ok=True)
    collected = expand_collection(
        collected,
        work_dir=expand_dir,
        bounds=bounds,
        max_rounds=max_rounds,
        topic_keywords=topic_keywords,
        use_semantic_scholar=use_s2,
        sleep_s=sleep_s,
        input_value=input_value,
        topic_judge_work_dir=collection_base
        / "work"
        / f"{run_prefix}-topic-judge"
        / "expand",
        topic_judge_scope_path=collection_base / "inputs" / "input.json",
    )

    if isinstance(input_value.get("payload"), dict) and isinstance(
        (input_value.get("payload") or {}).get("pdf_links"), dict
    ):
        collected = collect_paper_links(collected)

    try:
        collected = apply_topic_judge(
            collected,
            input_value,
            work_dir=collection_base / "work" / f"{run_prefix}-topic-judge",
            stage="post_expand",
            scope_path=collection_base / "inputs" / "input.json",
        )
    except Exception as error:  # noqa: BLE001
        log("expand_topic_judge_failed", error=str(error)[:400])

    expand_path = expand_dir / "expanded-collection.json"
    expand_path.write_text(
        json.dumps(collected, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    phase = {
        "phase_id": 1,
        "phase": "expansion",
        "status": "succeeded",
        "record_count": len(collected.get("records") or []),
        "output": str(expand_path),
        "graph_dot": (collected.get("literature_expansion") or {}).get("graph_dot"),
        "stats": (collected.get("literature_expansion") or {}).get("stats"),
        "topic_judgments": collected.get("topic_judgments"),
    }
    log(
        "expand_phase_done",
        record_count=len(collected.get("records") or []),
        stats=(collected.get("literature_expansion") or {}).get("stats"),
        topic_judgments_stages=list((collected.get("topic_judgments") or {}).keys()),
    )
    return collected, phase
