"""Phase 2 — augmentation: PDF capture + review qualification flags.

See README.md (section Phase 2).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from literature.phase1 import collect_paper_links
from literature.pdf_capture import capture_pdfs_for_collection
from literature.support import PHASE_AUGMENTATION, log


def attach_review_qualification(
    collection: dict[str, Any],
) -> dict[str, Any]:
    """Mark records as requiring phase-3 review (default for literature)."""
    records: list[dict[str, Any]] = []
    for record in collection.get("records", []):
        if not isinstance(record, dict):
            continue
        payload = dict(record.get("payload") or {})
        qualification = dict(payload.get("qualification") or {})
        qualification.setdefault("manual_review_required", True)
        qualification.setdefault("phase", "augmentation")
        qualification.setdefault("phase_id", PHASE_AUGMENTATION)
        payload["qualification"] = qualification
        records.append({**record, "payload": payload})
    return {
        **collection,
        "status": "augmented_candidate_set",
        "records": records,
    }


def run_augmentation(
    *,
    input_value: dict[str, Any],
    collection_output: dict[str, Any],
    work_dir: Path,
    run_prefix: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Literature phase 2: optional PDF download, then qualification flags.

    Returns (augmented_collection, phase_record).
    """
    working = collection_output
    pdf_capture_summary: dict[str, Any] | None = None
    wants_pdf = isinstance(input_value.get("payload"), dict) and isinstance(
        (input_value.get("payload") or {}).get("pdf_links"), dict
    )
    has_listed_links = any(
        isinstance((record.get("payload") or {}).get("pdf_links"), dict)
        for record in (collection_output.get("records") or [])
        if isinstance(record, dict)
    )
    if wants_pdf or has_listed_links:
        if not has_listed_links:
            working = collect_paper_links(working)
        try:
            capture_dir = work_dir / f"{run_prefix}-pdf-capture"
            log(
                "phase2_pdf_capture_start",
                phase_id=PHASE_AUGMENTATION,
                phase="augmentation",
                record_count=len(working.get("records") or []),
                output_dir=str(capture_dir),
            )
            capture_result = capture_pdfs_for_collection(
                working,
                output_dir=capture_dir,
                max_urls_per_record=4,
                max_workers=None,
            )
            captured_path = Path(capture_result["output"])
            working = json.loads(captured_path.read_text(encoding="utf-8"))
            pdf_capture_summary = capture_result.get("summary")
            log(
                "phase2_pdf_capture_done",
                phase_id=PHASE_AUGMENTATION,
                phase="augmentation",
                summary=pdf_capture_summary,
            )
        except Exception as error:  # noqa: BLE001
            pdf_capture_summary = {
                "status": "failed",
                "error": str(error),
            }
            log(
                "phase2_pdf_capture_failed",
                phase_id=PHASE_AUGMENTATION,
                phase="augmentation",
                error=str(error),
            )

    augmented = attach_review_qualification(working)
    intermediate = work_dir / "augmentation-output.json"
    intermediate.write_text(
        json.dumps(augmented, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    phase = {
        "phase_id": PHASE_AUGMENTATION,
        "phase": "augmentation",
        "status": "succeeded",
        "mode": (
            "literature+pdf-capture" if pdf_capture_summary else "builtin-literature"
        ),
        "output": str(intermediate),
        "record_count": len(augmented.get("records") or []),
        "run_prefix": run_prefix,
        "pdf_capture": pdf_capture_summary,
    }
    log(
        "phase_done",
        phase_id=PHASE_AUGMENTATION,
        phase="augmentation",
        status="succeeded",
        mode=phase.get("mode"),
        record_count=phase["record_count"],
        output=str(intermediate),
        pdf_capture=pdf_capture_summary,
    )
    return augmented, phase


def run_pdf_capture(
    *,
    input_value: dict[str, Any],
    collection_output: dict[str, Any],
    work_dir: Path,
    run_prefix: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Capture PDFs only; qualification and review are separate operations."""
    working = collection_output
    has_listed_links = any(
        isinstance((record.get("payload") or {}).get("pdf_links"), dict)
        for record in (working.get("records") or [])
        if isinstance(record, dict)
    )
    if not has_listed_links:
        working = collect_paper_links(working)
    capture_dir = work_dir / f"{run_prefix}-pdf-capture"
    result = capture_pdfs_for_collection(
        working, output_dir=capture_dir, max_urls_per_record=4, max_workers=None
    )
    captured = json.loads(Path(result["output"]).read_text(encoding="utf-8"))
    phase = {
        "phase": "pdf-capture", "status": "succeeded",
        "output": str(result["output"]),
        "record_count": len(captured.get("records") or []),
        "summary": result.get("summary"),
    }
    return captured, phase
