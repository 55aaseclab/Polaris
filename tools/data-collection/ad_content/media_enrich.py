"""Phase-2 media enrich: local images/videos → image-review / video-review."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from ad_content.support import AdContentError, log, tools_root, utc_now

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".mkv", ".m4v"}


def enrich_config(input_value: dict[str, Any]) -> dict[str, Any]:
    """Read payload.ad_content_enrich (and ad_content_scope.enrich alias)."""
    payload = input_value.get("payload") if isinstance(input_value.get("payload"), dict) else {}
    raw = payload.get("ad_content_enrich")
    if not isinstance(raw, dict):
        scope = payload.get("ad_content_scope")
        raw = (
            scope.get("enrich")
            if isinstance(scope, dict) and isinstance(scope.get("enrich"), dict)
            else {}
        )
    if not isinstance(raw, dict):
        raw = {}
    max_records = raw.get("max_records")
    try:
        max_records = int(max_records) if max_records is not None else None
    except (TypeError, ValueError):
        max_records = None
    return {
        # Default on: records without local media are skipped cheaply.
        "enabled": raw.get("enabled", True) is not False,
        "dry_run": bool(raw.get("dry_run", False)),
        "image_review": raw.get("image_review", True) is not False,
        "video_review": raw.get("video_review", True) is not False,
        "skip_understand": bool(raw.get("skip_understand", False)),
        "max_records": max_records,
    }


def _as_path_list(value: Any) -> list[Path]:
    paths: list[Path] = []
    if isinstance(value, str) and value.strip():
        paths.append(Path(value).expanduser())
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, str) and item.strip():
                paths.append(Path(item).expanduser())
            elif isinstance(item, dict):
                for key in ("path", "local_path", "file"):
                    p = item.get(key)
                    if isinstance(p, str) and p.strip():
                        paths.append(Path(p).expanduser())
                        break
    return paths


def resolve_local_media(record: dict[str, Any]) -> dict[str, Any]:
    """Detect local image/video paths on a collection record payload."""
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    media = payload.get("media") if isinstance(payload.get("media"), dict) else {}
    images: list[Path] = []
    videos: list[Path] = []

    for key in ("local_images", "images", "image_paths", "carousel_paths"):
        images.extend(_as_path_list(payload.get(key)))
    for key in ("local_paths", "images", "frames", "slides"):
        images.extend(_as_path_list(media.get(key)))
    for key in ("local_image", "image_path"):
        images.extend(_as_path_list(payload.get(key)))
        images.extend(_as_path_list(media.get(key)))

    for key in ("local_video", "video_path", "local_path"):
        videos.extend(_as_path_list(payload.get(key)))
        videos.extend(_as_path_list(media.get(key)))
    videos.extend(_as_path_list(media.get("video_paths")))
    videos.extend(_as_path_list(payload.get("local_videos")))

    # Classify ambiguous local_paths by suffix.
    for path in _as_path_list(media.get("local_paths")) + _as_path_list(
        payload.get("local_paths")
    ):
        suffix = path.suffix.lower()
        if suffix in VIDEO_SUFFIXES:
            videos.append(path)
        elif suffix in IMAGE_SUFFIXES:
            images.append(path)

    def _existing(paths: list[Path]) -> list[Path]:
        seen: set[str] = set()
        out: list[Path] = []
        for path in paths:
            resolved = path.expanduser().resolve()
            key = str(resolved)
            if key in seen:
                continue
            seen.add(key)
            if resolved.is_file():
                out.append(resolved)
        return out

    images_ok = _existing(images)
    videos_ok = _existing(videos)
    note_type = str(payload.get("note_type") or "").lower()
    kind = str(record.get("record_kind") or "").lower()
    if not note_type:
        if "video" in kind or videos_ok:
            note_type = "video"
        elif images_ok:
            note_type = "image"
        else:
            note_type = "other"
    return {
        "note_type": note_type,
        "images": images_ok,
        "videos": videos_ok,
        "has_media": bool(images_ok or videos_ok),
    }


def _run_json_cli(command: list[str], *, label: str) -> dict[str, Any]:
    completed = subprocess.run(command, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        err = (completed.stderr or completed.stdout or "").strip()[:600]
        raise AdContentError(f"{label} failed ({completed.returncode}): {err}")
    # Prefer last JSON object on stdout; tools also write --output files.
    return {"stdout": completed.stdout or "", "stderr": completed.stderr or ""}


def run_image_review(
    images: list[Path],
    *,
    output: Path,
    dry_run: bool,
) -> dict[str, Any]:
    cli = tools_root() / "image-review" / "clue-image-review"
    if not cli.is_file():
        raise AdContentError(f"image-review CLI missing: {cli}")
    cmd = [str(cli), "review", "--output", str(output)]
    for path in images:
        cmd.extend(["--image", str(path)])
    if dry_run:
        cmd.append("--dry-run")
    _run_json_cli(cmd, label="image-review")
    if not output.is_file():
        raise AdContentError(f"image-review produced no output: {output}")
    return json.loads(output.read_text(encoding="utf-8"))


def run_video_review(
    video: Path,
    *,
    work_dir: Path,
    output: Path,
    dry_run: bool,
    skip_understand: bool,
) -> dict[str, Any]:
    cli = tools_root() / "video-review" / "clue-video-review"
    if not cli.is_file():
        raise AdContentError(f"video-review CLI missing: {cli}")
    work_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(cli),
        "review",
        "--video",
        str(video),
        "--work-dir",
        str(work_dir),
        "--output",
        str(output),
    ]
    if dry_run:
        cmd.append("--dry-run")
    if skip_understand:
        cmd.append("--skip-understand")
    _run_json_cli(cmd, label="video-review")
    if not output.is_file():
        raise AdContentError(f"video-review produced no output: {output}")
    return json.loads(output.read_text(encoding="utf-8"))


def _merge_evidence(
    record: dict[str, Any], new_items: list[dict[str, str]]
) -> list[dict[str, Any]]:
    existing = list(record.get("evidence") or []) if isinstance(record.get("evidence"), list) else []
    seen = {
        (str(item.get("quote")), str(item.get("locator")))
        for item in existing
        if isinstance(item, dict)
    }
    for item in new_items:
        if not isinstance(item, dict):
            continue
        quote = item.get("quote")
        locator = item.get("locator") or "media-enrich"
        if not isinstance(quote, str) or not quote.strip():
            continue
        key = (quote.strip(), str(locator))
        if key in seen:
            continue
        seen.add(key)
        existing.append({"quote": quote.strip()[:800], "locator": str(locator)[:160]})
    return existing


def apply_image_result(record: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    payload = dict(record.get("payload") or {})
    text = result.get("text") if isinstance(result.get("text"), str) else ""
    ocr = result.get("ocr_text") if isinstance(result.get("ocr_text"), str) else ""
    if text.strip():
        # Keep original caption; add review text.
        if not (isinstance(payload.get("text"), str) and payload["text"].strip()):
            payload["text"] = text.strip()
        payload["image_review_text"] = text.strip()
    if ocr.strip():
        payload["ocr_text"] = ocr.strip()
    tags = result.get("tags") if isinstance(result.get("tags"), list) else []
    if tags:
        prior = payload.get("tags") if isinstance(payload.get("tags"), list) else []
        merged = list(dict.fromkeys([*prior, *[str(t) for t in tags if str(t).strip()]]))
        payload["tags"] = merged
    payload["image_review"] = {
        "status": result.get("status"),
        "dry_run": result.get("dry_run"),
        "model": result.get("model"),
        "generated_at": result.get("generated_at") or utc_now(),
        "output_schema": result.get("schema_version"),
    }
    evidence_in = result.get("evidence") if isinstance(result.get("evidence"), list) else []
    new_ev = [
        {"quote": str(item.get("quote")), "locator": str(item.get("locator") or "image@0")}
        for item in evidence_in
        if isinstance(item, dict)
    ]
    return {
        **record,
        "payload": payload,
        "evidence": _merge_evidence(record, new_ev),
    }


def apply_video_result(record: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    payload = dict(record.get("payload") or {})
    transcript = result.get("transcript") if isinstance(result.get("transcript"), dict) else {}
    t_text = (
        transcript.get("text")
        if isinstance(transcript.get("text"), str)
        else result.get("text") if isinstance(result.get("text"), str) else ""
    )
    if isinstance(t_text, str) and t_text.strip():
        payload["transcript"] = {
            "text": t_text.strip(),
            "engine": transcript.get("engine"),
            "dry_run": transcript.get("dry_run", result.get("dry_run")),
            "segments": transcript.get("segments") or [],
            "language": transcript.get("language"),
        }
        if not (isinstance(payload.get("text"), str) and payload["text"].strip()):
            payload["text"] = t_text.strip()
    if result.get("audio_path"):
        media = dict(payload.get("media") or {}) if isinstance(payload.get("media"), dict) else {}
        media["audio_path"] = result["audio_path"]
        payload["media"] = media
    understand = result.get("understand") if isinstance(result.get("understand"), dict) else None
    if understand:
        payload["video_understand"] = {
            "keyframes": understand.get("keyframes"),
            "image_review": understand.get("image_review"),
            "vibe": understand.get("vibe"),
            "note": understand.get("note"),
        }
        ir = understand.get("image_review") if isinstance(understand.get("image_review"), dict) else {}
        ir_text = ir.get("text") if isinstance(ir.get("text"), str) else ""
        if ir_text.strip():
            payload["video_review_text"] = ir_text.strip()
    payload["video_review"] = {
        "status": result.get("status"),
        "dry_run": result.get("dry_run"),
        "generated_at": result.get("generated_at") or utc_now(),
        "output_schema": result.get("schema_version"),
    }
    evidence_in = result.get("evidence") if isinstance(result.get("evidence"), list) else []
    new_ev = [
        {"quote": str(item.get("quote")), "locator": str(item.get("locator") or "transcript")}
        for item in evidence_in
        if isinstance(item, dict)
    ]
    return {
        **record,
        "payload": payload,
        "evidence": _merge_evidence(record, new_ev),
    }


def enrich_records_with_media(
    collection: dict[str, Any],
    *,
    input_value: dict[str, Any],
    work_dir: Path,
    run_prefix: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Run image/video review for records that have local media files.

    Returns (collection, summary).
    """
    cfg = enrich_config(input_value)
    summary: dict[str, Any] = {
        "enabled": cfg["enabled"],
        "dry_run": cfg["dry_run"],
        "attempted": 0,
        "succeeded": 0,
        "skipped_no_media": 0,
        "failed": 0,
        "image_reviews": 0,
        "video_reviews": 0,
        "errors": [],
    }
    if not cfg["enabled"]:
        summary["reason"] = "payload.ad_content_enrich.enabled=false"
        return collection, summary

    records_in = [
        r for r in (collection.get("records") or []) if isinstance(r, dict)
    ]
    media_dir = work_dir / f"{run_prefix}-media-enrich"
    media_dir.mkdir(parents=True, exist_ok=True)
    out_records: list[dict[str, Any]] = []
    processed = 0

    for index, record in enumerate(records_in):
        media = resolve_local_media(record)
        if not media["has_media"]:
            summary["skipped_no_media"] += 1
            out_records.append(record)
            continue
        if cfg["max_records"] is not None and processed >= cfg["max_records"]:
            out_records.append(record)
            continue

        record_id = str(record.get("record_id") or f"record-{index}")
        safe_id = "".join(c if c.isalnum() or c in "-_" else "_" for c in record_id)[:80]
        rec_dir = media_dir / safe_id
        rec_dir.mkdir(parents=True, exist_ok=True)
        summary["attempted"] += 1
        processed += 1
        try:
            note_type = media["note_type"]
            kind = str(record.get("record_kind") or "").lower()
            prefer_video = note_type == "video" or "video" in kind
            if prefer_video and media["videos"] and cfg["video_review"]:
                use_video = True
            elif media["images"] and cfg["image_review"]:
                use_video = False
            elif media["videos"] and cfg["video_review"]:
                use_video = True
            else:
                use_video = False

            if use_video and media["videos"]:
                if not cfg["video_review"]:
                    out_records.append(record)
                    continue
                video = media["videos"][0]
                out_path = rec_dir / "video-review.json"
                result = run_video_review(
                    video,
                    work_dir=rec_dir / "video-work",
                    output=out_path,
                    dry_run=cfg["dry_run"],
                    skip_understand=cfg["skip_understand"],
                )
                record = apply_video_result(record, result)
                summary["video_reviews"] += 1
                log(
                    "media_enrich_video",
                    record_id=record_id,
                    video=str(video),
                    dry_run=cfg["dry_run"],
                )
            elif cfg["image_review"] and media["images"]:
                out_path = rec_dir / "image-review.json"
                result = run_image_review(
                    media["images"],
                    output=out_path,
                    dry_run=cfg["dry_run"],
                )
                record = apply_image_result(record, result)
                summary["image_reviews"] += 1
                log(
                    "media_enrich_image",
                    record_id=record_id,
                    image_count=len(media["images"]),
                    dry_run=cfg["dry_run"],
                )
            else:
                summary["skipped_no_media"] += 1
                summary["attempted"] -= 1
                processed -= 1
                out_records.append(record)
                continue
            summary["succeeded"] += 1
            out_records.append(record)
        except Exception as error:  # noqa: BLE001 — per-record soft fail
            summary["failed"] += 1
            summary["errors"].append(
                {"record_id": record_id, "error": str(error)[:300]}
            )
            log(
                "media_enrich_failed",
                record_id=record_id,
                error=str(error)[:300],
            )
            # Keep original record so the run still completes.
            out_records.append(record)

    # Preserve non-dict entries order-safe: only dict records were listed.
    return {**collection, "records": out_records}, summary
