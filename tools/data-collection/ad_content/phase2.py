"""Phase 2 — augmentation: media enrich + review qualification flags.

Media enrich (when local files are present on the record):

- image / carousel → tools/image-review (clue-image-review)
- video → tools/video-review (audio/ASR + optional understand)

Config via payload.ad_content_enrich (see README). Records without local
media are left unchanged aside from qualification flags.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ad_content.media_enrich import enrich_records_with_media
from ad_content.support import PHASE_AUGMENTATION, log


def attach_review_qualification(
    collection: dict[str, Any],
) -> dict[str, Any]:
    """Mark records as requiring phase-3 review."""
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
    """Ad-content phase 2: media enrich + review qualification.

    Returns (augmented_collection, phase_record).
    """
    work_dir.mkdir(parents=True, exist_ok=True)

    working, media_summary = enrich_records_with_media(
        collection_output,
        input_value=input_value,
        work_dir=work_dir,
        run_prefix=run_prefix,
    )
    log(
        "phase2_media_enrich_done",
        phase_id=PHASE_AUGMENTATION,
        phase="augmentation",
        **{
            key: value
            for key, value in media_summary.items()
            if key != "errors" or value
        },
    )

    augmented = attach_review_qualification(working)
    intermediate = work_dir / "augmentation-output.json"
    intermediate.write_text(
        json.dumps(augmented, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    note_parts = [
        "qualification flags attached for phase 3",
    ]
    if media_summary.get("succeeded"):
        note_parts.insert(
            0,
            (
                f"media enrich: {media_summary['succeeded']} ok "
                f"({media_summary.get('image_reviews', 0)} image, "
                f"{media_summary.get('video_reviews', 0)} video)"
            ),
        )
    elif media_summary.get("enabled") is False:
        note_parts.insert(0, "media enrich disabled")
    else:
        note_parts.insert(
            0,
            "media enrich: no local media on records "
            "(set payload.media.local_paths / local_video)",
        )

    phase = {
        "phase_id": PHASE_AUGMENTATION,
        "phase": "augmentation",
        "status": "succeeded",
        "mode": "ad-content-intel",
        "output": str(intermediate),
        "record_count": len(augmented.get("records") or []),
        "run_prefix": run_prefix,
        "media_enrich": media_summary,
        "note": "; ".join(note_parts) + ".",
    }
    log(
        "phase_done",
        phase_id=PHASE_AUGMENTATION,
        phase="augmentation",
        status="succeeded",
        mode="ad-content-intel",
        record_count=phase["record_count"],
        output=str(intermediate),
        media_succeeded=media_summary.get("succeeded"),
        media_failed=media_summary.get("failed"),
    )
    return augmented, phase
