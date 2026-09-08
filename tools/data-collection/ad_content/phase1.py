"""Phase 1 — collection: normalize web/social discovery into v2 records.

Also holds source-type allow-list and JustOneAPI / web-search task runners.
See README.md (section Phase 1).
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ad_content.support import (
    SOURCE_TYPES,
    AdContentError,
    OUTPUT_V2,
    PHASE_COLLECTION,
    log,
    read_json,
    required_list,
    tools_root,
)

# Public alias matching runner.AD_CONTENT_SOURCE_TYPES
AD_CONTENT_SOURCE_TYPES = SOURCE_TYPES


def normalize_web_search(input_value: dict[str, Any], source: str) -> dict[str, Any]:
    """Normalize plain web-search batch results into collection records."""
    document = read_json(source, "web-search source")
    task_results = required_list(document, "task_results", "web-search source")
    kind = input_value.get("collection_kind") or "ad-content-intel"
    records: list[dict[str, Any]] = []
    for task in task_results:
        if not isinstance(task, dict) or task.get("status") != "succeeded":
            continue
        observed_at = task.get("searched_at")
        if not isinstance(observed_at, str) or not observed_at.strip():
            observed_at = (
                datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
            )
        for result in task.get("results", []):
            if not isinstance(result, dict):
                continue
            url = result.get("url")
            title = result.get("title")
            quote = result.get("content") if isinstance(result.get("content"), str) else title
            if not all(isinstance(item, str) and item.strip() for item in (url, title, quote)):
                continue
            payload = {
                "platform": "web",
                "title": title,
                "text": quote,
                "search_result": result,
                "task_id": task.get("task_id"),
                "query": task.get("query"),
            }
            digest = "sha256:" + hashlib.sha256(
                json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
            ).hexdigest()
            record_kind = (
                "social_post" if kind == "ad-content-intel" else "web-candidate"
            )
            records.append(
                {
                    "record_id": "url:" + hashlib.sha256(url.encode("utf-8")).hexdigest()[:24],
                    "record_kind": record_kind,
                    "source_url": url,
                    "observed_at": observed_at,
                    "content_hash": digest,
                    "evidence": [{"quote": quote, "locator": "search result snippet"}],
                    "payload": payload,
                }
            )
    unique = {record["record_id"]: record for record in records}
    return {
        "schema_version": OUTPUT_V2,
        "collection_id": input_value["collection_id"],
        "collection_kind": kind,
        "status": "candidate_set",
        "records": list(unique.values()),
        "rejected_records": [],
        "run_artifacts": [
            {
                "path": str(Path(source).expanduser().resolve()),
                "sha256": "sha256:" + hashlib.sha256(Path(source).read_bytes()).hexdigest(),
            }
        ],
        "information_gaps": [
            "Web-search candidates are unreviewed discovery hits, not verified ads."
        ],
    }



def normalize_social_media(input_value: dict[str, Any], source: str) -> dict[str, Any]:
    """Normalize social-media candidates into ad-content-intel records."""
    document = read_json(source, "social-media source")
    candidates = document.get("candidates")
    if not isinstance(candidates, list):
        raise AdContentError(f"social_media output has no candidates array: {source}")
    kind = input_value.get("collection_kind") or "ad-content-intel"
    observed_at = document.get("generated_at")
    if not isinstance(observed_at, str) or not observed_at.strip():
        observed_at = (
            datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        )
    records: list[dict[str, Any]] = []
    for item in candidates:
        if not isinstance(item, dict):
            continue
        platform = item.get("platform") if isinstance(item.get("platform"), str) else "social"
        handle = item.get("account_handle") if isinstance(item.get("account_handle"), str) else ""
        post_url = item.get("post_url") if isinstance(item.get("post_url"), str) else ""
        account_url = item.get("account_url") if isinstance(item.get("account_url"), str) else ""
        source_url = post_url or account_url
        if not source_url:
            continue
        content = item.get("content") if isinstance(item.get("content"), dict) else {}
        title = (
            content.get("title")
            if isinstance(content.get("title"), str) and content["title"].strip()
            else item.get("company_name")
            if isinstance(item.get("company_name"), str) and item["company_name"].strip()
            else item.get("profile_summary")
            if isinstance(item.get("profile_summary"), str) and item["profile_summary"].strip()
            else handle or source_url
        )
        quote = (
            item.get("profile_summary")
            if isinstance(item.get("profile_summary"), str) and item["profile_summary"].strip()
            else title
        )
        trace = item.get("source_trace") if isinstance(item.get("source_trace"), dict) else {}
        author_handle = (
            content.get("author_handle")
            if isinstance(content.get("author_handle"), str) and content["author_handle"].strip()
            else handle
        )
        payload = {
            "platform": platform,
            "title": title,
            "text": quote,
            "author_handle": author_handle,
            "author_id": content.get("author_id"),
            "account_url": account_url or None,
            "post_url": post_url or None,
            "note_type": content.get("note_type"),
            "engagement": content.get("engagement")
            if isinstance(content.get("engagement"), dict)
            else None,
            "is_ad_like": bool(item.get("public_business_evidence")),
            "task_id": trace.get("task_id"),
            "query": trace.get("query"),
            "social_candidate": {
                key: item[key]
                for key in item
                if key not in {"source_traces"}  # drop merged multi-trace bulk if present
            },
        }
        if content.get("note_id"):
            payload["note_id"] = content["note_id"]
        digest = "sha256:" + hashlib.sha256(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode(
                "utf-8"
            )
        ).hexdigest()
        if post_url:
            record_id = "post:" + hashlib.sha256(post_url.encode("utf-8")).hexdigest()[:24]
            record_kind = "social_post"
        else:
            record_id = "account:" + hashlib.sha256(source_url.encode("utf-8")).hexdigest()[
                :24
            ]
            record_kind = "social_account"
        # Prefer xhs_* kinds when platform is xiaohongshu.
        plat = platform.lower().replace("_", "")
        if "xiaohongshu" in plat or plat in {"xhs", "rednote"}:
            note_type = str(content.get("note_type") or "").lower()
            if post_url and note_type == "video":
                record_kind = "xhs_video"
            elif post_url:
                record_kind = "xhs_note"
            else:
                record_kind = "xhs_account"
        records.append(
            {
                "record_id": record_id,
                "record_kind": record_kind,
                "source_url": source_url,
                "observed_at": observed_at,
                "content_hash": digest,
                "evidence": [{"quote": quote, "locator": f"{platform} discovery"}],
                "payload": payload,
            }
        )
    unique = {record["record_id"]: record for record in records}
    return {
        "schema_version": OUTPUT_V2,
        "collection_id": input_value["collection_id"],
        "collection_kind": kind,
        "status": "candidate_set",
        "records": list(unique.values()),
        "rejected_records": [],
        "run_artifacts": [
            {
                "path": str(Path(source).expanduser().resolve()),
                "sha256": "sha256:" + hashlib.sha256(Path(source).read_bytes()).hexdigest(),
            }
        ],
        "information_gaps": [
            "Social-media candidates depend on enabled platform routes in "
            "tools/social-media/config/platform-routes.json (instagram + "
            "xiaohongshu). Live capture needs tools/social-media token + "
            "locked JustOneAPI SDK checkout."
        ],
    }




def run_social_media_task(
    *,
    input_value: dict[str, Any],
    task_id: str,
    config: dict[str, Any],
    collection_root: Path,
    run_id: str,
    index: int,
    total: int,
) -> tuple[dict[str, Any], tuple[str, str, dict[str, dict[str, Any]]] | None]:
    """Invoke tools/social-media batch; return (result_row, source_or_None)."""
    platform = config.get("platform")
    query = config.get("query") or config.get("keyword") or config.get("hashtag")
    if not isinstance(platform, str) or not platform.strip():
        raise AdContentError("social_media config requires platform")
    if not isinstance(query, str) or not query.strip():
        raise AdContentError("social_media config requires query")
    request = {
        "collection_id": input_value["collection_id"],
        "sources": [
            {
                "source_type": "social_media",
                "tasks": [
                    {
                        "task_id": task_id,
                        "platform": platform.strip(),
                        "query": query.strip(),
                    }
                ],
            }
        ],
    }
    request_path = collection_root / run_id / "request.json"
    request_path.parent.mkdir(parents=True, exist_ok=True)
    request_path.write_text(
        json.dumps(request, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    # CLI requires a non-existent output directory (it creates the run root).
    output_dir = collection_root / run_id / "social-media"
    (collection_root / run_id).mkdir(parents=True, exist_ok=True)
    if output_dir.exists():
        raise AdContentError(
            f"social-media output directory already exists: {output_dir} "
            "(use a fresh run_id / run-prefix)"
        )
    command = [
        str(tools_root() / "social-media/clue-justoneapi-cli"),
        "batch",
        "--input",
        str(request_path),
        "--output",
        str(output_dir),
    ]
    max_pages = config.get("max_pages")
    if max_pages is not None:
        try:
            command.extend(("--max-pages", str(max(1, int(max_pages)))))
        except (TypeError, ValueError):
            pass
    completed = subprocess.run(command, text=True, capture_output=True, check=False)
    candidates_path = output_dir / "social-media-candidates.json"
    status = (
        "succeeded"
        if completed.returncode == 0 and candidates_path.is_file()
        else "failed"
    )
    result = {
        "task_id": task_id,
        "status": status,
        "output": str(candidates_path if candidates_path.is_file() else output_dir),
        "detail": (completed.stderr or completed.stdout or "").strip()[:500],
    }
    log(
        "phase1_task_done",
        phase_id=PHASE_COLLECTION,
        phase="collection",
        index=index,
        total=total,
        task_id=task_id,
        source_type="social_media",
        status=status,
        exit_code=completed.returncode,
        platform=platform.strip(),
    )
    source = ("social_media", str(candidates_path), {}) if status == "succeeded" else None
    return result, source


def run_web_search_task(
    *,
    input_value: dict[str, Any],
    task_id: str,
    config: dict[str, Any],
    collection_root: Path,
    run_id: str,
    index: int,
    total: int,
    default_locale: str = "zh-CN",
) -> tuple[dict[str, Any], tuple[str, str, dict[str, dict[str, Any]]] | None]:
    """Invoke tools/web-search batch; return (result_row, source_or_None)."""
    query = config.get("query") or config.get("keyword") or config.get("question")
    if not isinstance(query, str) or not query.strip():
        raise AdContentError("web-search config requires query")
    locale = config.get("locale", default_locale)
    if not isinstance(locale, str) or not locale.strip():
        locale = default_locale
    request = {
        "collection_id": input_value["collection_id"],
        "sources": [
            {
                "source_type": "web_search",
                "tasks": [
                    {
                        "task_id": task_id,
                        "query": query.strip(),
                        "locale": locale.strip(),
                        "buyer_type_ids": [],
                    }
                ],
            }
        ],
    }
    request_path = collection_root / run_id / "request.json"
    request_path.parent.mkdir(parents=True, exist_ok=True)
    request_path.write_text(
        json.dumps(request, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    output = collection_root / run_id / "search" / "results.json"
    command = [
        str(tools_root() / "web-search/clue-web-search-cli"),
        "batch",
        "--input",
        str(request_path),
        "--output",
        str(output.parent),
    ]
    completed = subprocess.run(command, text=True, capture_output=True, check=False)
    status = "succeeded" if completed.returncode == 0 else "failed"
    result = {
        "task_id": task_id,
        "status": status,
        "output": str(output),
        "detail": (completed.stderr or "").strip()[:500],
    }
    log(
        "phase1_task_done",
        phase_id=PHASE_COLLECTION,
        phase="collection",
        index=index,
        total=total,
        task_id=task_id,
        source_type="web-search",
        status=status,
        exit_code=completed.returncode,
    )
    source = ("web-search", str(output), {}) if completed.returncode == 0 else None
    return result, source
