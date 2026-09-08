#!/usr/bin/env python3
"""Versioned JustOneAPI social-media collection runner.

The runner deliberately retains only public, explicitly business-oriented
account evidence. It never stores a token, raw provider payload, media, or
comments. Individual task state is written after each API attempt so a run can
resume after balance, quota, authentication, or transport errors.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

TOOLS_DIR = Path(__file__).resolve().parents[1]
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))
try:
    from paths import WorkspacePathError, collection_paths
except ImportError:
    WorkspacePathError = ValueError  # type: ignore[misc,assignment]
    collection_paths = None  # type: ignore[assignment]


BUSINESS_WORDS = {
    "shop",
    "store",
    "boutique",
    "retail",
    "atelier",
    "studio",
    "design",
    "museum",
    "hotel",
    "spa",
    "wellness",
    "wedding",
    "event",
    "gift",
    "jewelry",
    "jewellery",
    "schmuck",
    "geschenk",
    "cadeau",
    "mariage",
    "magasin",
    "geschäft",
    "laden",
    "unternehmen",
    "boutiquehotel",
    "conceptstore",
}

BLOCKING_STATUSES = {
    "blocked_insufficient_credit",
    "blocked_rate_limit",
    "blocked_authentication",
    "blocked_permission",
}
RUN_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
TASK_CACHE_SCHEMA = "clue.social-media.task-cache.v1"
_CACHE_STATS: dict[str, int] = {"hits": 0, "misses": 0, "puts": 0, "partial_hits": 0}


class CliError(RuntimeError):
    """A user-actionable CLI failure that must not expose secrets."""


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_path = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary_path, path)
    except BaseException:
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            pass
        raise


def append_jsonl(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, sort_keys=True))
        handle.write("\n")


def safe_text(value: Any, token: str = "", limit: int = 500) -> str:
    text = "" if value is None else str(value)
    if token:
        text = text.replace(token, "[REDACTED]")
    text = re.sub(r"(?i)(token=)[^&\s]+", r"\1[REDACTED]", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def short_text(value: Any, limit: int = 280) -> str | None:
    text = safe_text(value, limit=limit)
    return text or None


def git_output(directory: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(directory), *args], text=True).strip()


def load_configuration(root: Path) -> tuple[dict[str, Any], dict[str, Any], str]:
    lock_path = root / "backend.lock.json"
    version_path = root / "VERSION"
    routes_path = root / "config" / "platform-routes.json"
    if not lock_path.is_file() or not version_path.is_file() or not routes_path.is_file():
        raise CliError("tool configuration is incomplete")

    lock = read_json(lock_path)
    routes = read_json(routes_path)
    version = version_path.read_text(encoding="utf-8").strip()
    locked_version = lock.get("cli", {}).get("version")
    if not version or version != locked_version:
        raise CliError("VERSION and backend.lock.json differ")
    if not isinstance(routes.get("platforms"), dict):
        raise CliError("platform routes configuration is invalid")
    return lock, routes, version


def backend_status(root: Path, lock: dict[str, Any]) -> dict[str, Any]:
    backend = lock["backend"]
    backend_path = root / backend["path"]
    if not (backend_path / ".git").is_dir():
        raise CliError(f"backend clone is missing: {backend_path}")

    actual_commit = git_output(backend_path, "rev-parse", "HEAD")
    working_tree = "clean" if not git_output(backend_path, "status", "--porcelain") else "modified"
    return {
        "backend_path": str(backend_path),
        "locked_ref": backend["ref"],
        "expected_commit": backend["commit"],
        "actual_commit": actual_commit,
        "commit_matches_lock": actual_commit == backend["commit"],
        "working_tree": working_tree,
        "api_base_url": backend["api_base_url"],
    }


def assert_backend(root: Path, lock: dict[str, Any]) -> dict[str, Any]:
    status = backend_status(root, lock)
    if not status["commit_matches_lock"]:
        raise CliError("backend commit differs from backend.lock.json")
    if status["working_tree"] != "clean":
        raise CliError("backend has local modifications; restore it before running")
    return status


def absolute_path(path: str) -> Path:
    return Path(path).expanduser().resolve()


def monorepo_root(tool_root: Path) -> Path:
    """tools/social-media → repository root."""
    return tool_root.resolve().parents[1]


def cache_stats() -> dict[str, int]:
    return dict(_CACHE_STATS)


def reset_cache_stats() -> None:
    for key in _CACHE_STATS:
        _CACHE_STATS[key] = 0


def resolve_cache_root(tool_root: Path | None = None) -> Path:
    """Shared JustOneAPI task cache under POLARIS_LITERATURE_CACHE_ROOT/social-media.

    Override with SOCIAL_MEDIA_CACHE=/path. Disable with SOCIAL_MEDIA_CACHE=0.
    """
    env = (os.environ.get("SOCIAL_MEDIA_CACHE") or "").strip()
    if env and env.lower() not in {"0", "false", "off", "no"}:
        return Path(env).expanduser().resolve()
    shared = (os.environ.get("POLARIS_LITERATURE_CACHE_ROOT") or "").strip()
    if not shared:
        raise RuntimeError("POLARIS_LITERATURE_CACHE_ROOT is required for social-media cache")
    return Path(shared).expanduser().resolve() / "social-media"


def cache_enabled(*, force_off: bool = False) -> bool:
    if force_off:
        return False
    flag = (os.environ.get("SOCIAL_MEDIA_CACHE") or "").strip().lower()
    if flag in {"0", "false", "off", "no"}:
        return False
    return True


def task_cache_key(
    *,
    platform: str,
    route: dict[str, Any],
    normalized_query: str,
) -> str:
    """Stable fingerprint for a paid search (platform + query + route).

    max_pages is not part of the key: a larger cached page set can satisfy a
    smaller request, and a smaller set can seed a larger one (partial hit).
    """
    payload = {
        "platform": platform,
        "endpoint_path": route.get("endpoint_path"),
        "resource": route.get("resource"),
        "method": route.get("method"),
        "normalized_query": normalized_query,
        "static_parameters": route.get("static_parameters") or {},
        "candidate_adapter": candidate_adapter_name(route),
        "pagination_style": pagination_style(route),
        "query_parameter": route.get("query_parameter"),
    }
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def task_cache_path(cache_root: Path, key: str) -> Path:
    return cache_root / "tasks" / key[:2] / f"{key}.json"


def cache_get_task(
    *,
    tool_root: Path,
    platform: str,
    route: dict[str, Any],
    normalized_query: str,
    max_pages: int,
    force_off: bool = False,
) -> dict[str, Any] | None:
    if not cache_enabled(force_off=force_off):
        return None
    key = task_cache_key(
        platform=platform,
        route=route,
        normalized_query=normalized_query,
    )
    path = task_cache_path(resolve_cache_root(tool_root), key)
    if not path.is_file():
        _CACHE_STATS["misses"] += 1
        return None
    try:
        entry = read_json(path)
    except (OSError, json.JSONDecodeError, CliError, ValueError, TypeError):
        _CACHE_STATS["misses"] += 1
        return None
    if not isinstance(entry, dict) or entry.get("schema_version") != TASK_CACHE_SCHEMA:
        _CACHE_STATS["misses"] += 1
        return None
    if not isinstance(entry.get("candidates"), list):
        _CACHE_STATS["misses"] += 1
        return None
    pages = int(entry.get("pages_completed") or 0)
    if pages < 1:
        _CACHE_STATS["misses"] += 1
        return None
    entry = dict(entry)
    entry["_cache_key"] = key
    entry["_cache_path"] = str(path)
    if pages >= max_pages:
        _CACHE_STATS["hits"] += 1
    else:
        _CACHE_STATS["partial_hits"] += 1
    return entry


def cache_put_task(
    *,
    tool_root: Path,
    platform: str,
    route: dict[str, Any],
    normalized_query: str,
    max_pages: int,
    task_state: dict[str, Any],
    force_off: bool = False,
) -> str | None:
    """Persist a successful task snapshot (candidates only; no token/raw)."""
    if not cache_enabled(force_off=force_off):
        return None
    if task_state.get("status") != "succeeded":
        return None
    pages = int(task_state.get("pages_completed") or 0)
    if pages < 1:
        return None
    key = task_cache_key(
        platform=platform,
        route=route,
        normalized_query=normalized_query,
    )
    path = task_cache_path(resolve_cache_root(tool_root), key)
    # Keep the richer entry when an older cache already has more pages.
    if path.is_file():
        try:
            existing = read_json(path)
            if (
                isinstance(existing, dict)
                and existing.get("schema_version") == TASK_CACHE_SCHEMA
                and int(existing.get("pages_completed") or 0) > pages
            ):
                return str(existing.get("cache_key") or key)
        except (OSError, json.JSONDecodeError, ValueError, TypeError):
            pass
    entry = {
        "schema_version": TASK_CACHE_SCHEMA,
        "cache_key": key,
        "cached_at": utc_now(),
        "platform": platform,
        "endpoint_path": route.get("endpoint_path"),
        "resource": route.get("resource"),
        "method": route.get("method"),
        "normalized_query": normalized_query,
        "max_pages": int(max_pages),
        "pages_completed": pages,
        "records_seen": int(task_state.get("records_seen") or 0),
        "excluded_record_counts": dict(task_state.get("excluded_record_counts") or {}),
        "next_cursor": task_state.get("next_cursor") or "",
        "pagination_session": dict(task_state.get("pagination_session") or {}),
        "pagination_truncated": bool(task_state.get("pagination_truncated")),
        "candidate_count": int(task_state.get("candidate_count") or 0),
        "candidates": copy.deepcopy(task_state.get("candidates") or []),
    }
    try:
        atomic_write_json(path, entry)
        _CACHE_STATS["puts"] += 1
        return key
    except OSError:
        return None


def _rebind_cached_candidates(
    candidates: list[Any],
    task_state: dict[str, Any],
) -> list[dict[str, Any]]:
    """Copy cached candidates and point source_trace at the current task."""
    rebound: list[dict[str, Any]] = []
    for item in candidates:
        if not isinstance(item, dict):
            continue
        candidate = copy.deepcopy(item)
        trace = candidate.get("source_trace")
        if isinstance(trace, dict):
            trace = dict(trace)
            trace["task_id"] = task_state.get("task_id")
            trace["query"] = task_state.get("query")
            trace["normalized_query"] = task_state.get("normalized_query")
            candidate["source_trace"] = trace
        rebound.append(candidate)
    return rebound


def apply_task_cache_hit(
    task_state: dict[str, Any],
    entry: dict[str, Any],
    *,
    max_pages: int,
    commands_path: Path | None = None,
) -> dict[str, Any]:
    """Fill task_state from a full cache hit (pages_completed >= max_pages)."""
    now = utc_now()
    candidates = _rebind_cached_candidates(list(entry.get("candidates") or []), task_state)
    task_state["status"] = "succeeded"
    task_state["started_at"] = task_state.get("started_at") or now
    task_state["finished_at"] = now
    task_state["pages_completed"] = int(entry.get("pages_completed") or 0)
    task_state["records_seen"] = int(entry.get("records_seen") or 0)
    task_state["excluded_record_counts"] = dict(entry.get("excluded_record_counts") or {})
    task_state["next_cursor"] = entry.get("next_cursor") or ""
    task_state["pagination_session"] = dict(entry.get("pagination_session") or {})
    task_state["pagination_truncated"] = bool(entry.get("pagination_truncated"))
    task_state["candidates"] = candidates
    task_state["candidate_count"] = len(candidates)
    task_state["last_error"] = None
    task_state["cache"] = {
        "hit": True,
        "partial": False,
        "cache_key": entry.get("_cache_key") or entry.get("cache_key"),
        "cached_at": entry.get("cached_at"),
    }
    attempt = {
        "attempted_at": now,
        "status": "cache_hit",
        "api_code": None,
        "provider_message": None,
        "request_id": None,
        "records_seen": task_state["records_seen"],
        "candidates_retained": len(candidates),
        "cache_key": task_state["cache"]["cache_key"],
    }
    attempts = list(task_state.get("attempts") or [])
    attempts.append(attempt)
    task_state["attempts"] = attempts
    if commands_path is not None:
        append_jsonl(
            commands_path,
            {
                "executed_at": now,
                "task_id": task_state.get("task_id"),
                "platform": task_state.get("platform"),
                "status": "cache_hit",
                "cache_key": task_state["cache"]["cache_key"],
                "candidate_count": len(candidates),
                "pages_completed": task_state["pages_completed"],
                "token_logged": False,
            },
        )
    return task_state


def seed_task_from_partial_cache(
    task_state: dict[str, Any],
    entry: dict[str, Any],
) -> dict[str, Any]:
    """Seed an incomplete task from a partial cache entry, then continue API."""
    candidates = _rebind_cached_candidates(list(entry.get("candidates") or []), task_state)
    task_state["pages_completed"] = int(entry.get("pages_completed") or 0)
    task_state["records_seen"] = int(entry.get("records_seen") or 0)
    task_state["excluded_record_counts"] = dict(entry.get("excluded_record_counts") or {})
    task_state["next_cursor"] = entry.get("next_cursor") or ""
    task_state["pagination_session"] = dict(entry.get("pagination_session") or {})
    task_state["pagination_truncated"] = bool(entry.get("pagination_truncated"))
    task_state["candidates"] = candidates
    task_state["candidate_count"] = len(candidates)
    task_state["cache"] = {
        "hit": True,
        "partial": True,
        "cache_key": entry.get("_cache_key") or entry.get("cache_key"),
        "cached_at": entry.get("cached_at"),
    }
    return task_state


def default_token_file(root: Path, lock: dict[str, Any]) -> Path:
    """Prefer repository-root .env (shared site config); else tool-local file."""
    repo_env = monorepo_root(root) / ".env"
    if repo_env.is_file():
        return repo_env.resolve()
    return (root / lock["token"]["default_file"]).resolve()


def _parse_token_line(line: str) -> str:
    text = line.strip()
    if text.startswith("export "):
        text = text[len("export ") :].strip()
    if "=" in text:
        _, token = text.split("=", 1)
    else:
        token = text
    return token.strip().strip('"').strip("'")


def load_token(path: Path | str) -> str:
    """Resolve JustOneAPI token.

    Order:
      1. JUSTONEAPI_TOKEN environment variable
      2. Named key in the token file (JUSTONEAPI_TOKEN=…)
      3. First non-comment line of the file (legacy bare token or KEY=value)
    """
    env = (os.environ.get("JUSTONEAPI_TOKEN") or "").strip().strip('"').strip("'")
    if env:
        return env

    if path == "-":
        first_line = sys.stdin.readline().strip()
        token = _parse_token_line(first_line)
        if not token:
            raise CliError("stdin token line is empty")
        return token

    token_path = Path(path) if not isinstance(path, Path) else path
    if not token_path.is_file():
        raise CliError(
            f"token file is missing: {token_path} "
            "(set JUSTONEAPI_TOKEN in the environment or repository-root .env)"
        )

    named_keys = {"JUSTONEAPI_TOKEN"}
    first_value: str | None = None
    with token_path.open("r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            text = line[len("export ") :].strip() if line.startswith("export ") else line
            if "=" in text:
                name, value = text.split("=", 1)
                name = name.strip()
                value = value.strip().strip('"').strip("'")
                if name in named_keys and value:
                    return value
                if first_value is None and value:
                    first_value = value
            elif first_value is None:
                first_value = text.strip().strip('"').strip("'")
    if first_value:
        return first_value
    raise CliError(
        f"no JUSTONEAPI_TOKEN found in {token_path} "
        "(add JUSTONEAPI_TOKEN=… to repository-root .env)"
    )


def normalize_query(query: str, route: dict[str, Any]) -> str:
    normalized = query.strip()
    mode = route.get("query_normalization")
    if mode == "strip_leading_hash":
        normalized = normalized.lstrip("#").strip()
    elif mode in {None, "strip", ""}:
        normalized = normalized.strip()
    if not normalized:
        raise CliError("task query is empty after route normalization")
    return normalized


def candidate_adapter_name(route: dict[str, Any]) -> str:
    adapter = route.get("candidate_adapter") or "business_account"
    if adapter not in {"business_account", "content_note"}:
        raise CliError(f"unsupported candidate_adapter: {adapter}")
    return adapter


def pagination_style(route: dict[str, Any]) -> str:
    style = route.get("pagination_style") or "cursor"
    if style not in {"cursor", "page"}:
        raise CliError(f"unsupported pagination_style: {style}")
    return style


def task_path(output_directory: Path, task_id: str) -> Path:
    return output_directory / "tasks" / f"{task_id}.json"


def task_template(task: dict[str, Any], route: dict[str, Any], normalized_query: str) -> dict[str, Any]:
    return {
        "schema_version": "clue-justoneapi-cli.task.v1",
        "task_id": task["task_id"],
        "platform": task["platform"],
        "market": task.get("market"),
        "city": task.get("city"),
        "locale": task.get("locale"),
        "query": task["query"],
        "normalized_query": normalized_query,
        "buyer_type_ids": task.get("buyer_type_ids", []),
        "route": {
            "resource": route["resource"],
            "method": route["method"],
            "endpoint_path": route["endpoint_path"],
            "documentation_url": route["documentation_url"],
        },
        "status": "pending",
        "started_at": None,
        "finished_at": None,
        "pages_completed": 0,
        "next_cursor": "",
        "pagination_session": {},
        "pagination_truncated": False,
        "records_seen": 0,
        "excluded_record_counts": {},
        "candidate_count": 0,
        "candidates": [],
        "attempts": [],
        "last_error": None,
    }


def extract_tasks(input_document: dict[str, Any], routes: dict[str, Any]) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    for source in input_document.get("sources", []):
        if source.get("source_type") != "social_media":
            continue
        for task in source.get("tasks", []):
            if not all(isinstance(task.get(key), str) and task[key] for key in ("task_id", "platform", "query")):
                raise CliError("social_media task is missing task_id, platform, or query")
            route = routes["platforms"].get(task["platform"])
            if not isinstance(route, dict) or not route.get("enabled"):
                tasks.append({"task": task, "route": None, "normalized_query": None})
                continue
            if route.get("source_type") != "social_media":
                raise CliError(f"route source type is incompatible for platform {task['platform']}")
            tasks.append({"task": task, "route": route, "normalized_query": normalize_query(task["query"], route)})
    if not tasks:
        raise CliError("input has no source_type=social_media tasks")
    return tasks


def nested_values(value: Any) -> Iterable[Any]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from nested_values(child)
    elif isinstance(value, list):
        for child in value:
            yield from nested_values(child)


def first_value(record: dict[str, Any], names: Iterable[str]) -> Any:
    desired = {name.lower() for name in names}
    for item in nested_values(record):
        if not isinstance(item, dict):
            continue
        for key, value in item.items():
            if key.lower() in desired and value not in (None, "", [], {}):
                return value
    return None


def first_mapping(record: dict[str, Any], names: Iterable[str]) -> dict[str, Any]:
    desired = {name.lower() for name in names}
    for item in nested_values(record):
        if not isinstance(item, dict):
            continue
        for key, value in item.items():
            if key.lower() in desired and isinstance(value, dict):
                return value
    return record


def looks_like_instagram_post(record: dict[str, Any]) -> bool:
    keys = {str(key).lower() for key in record}
    has_identifier = bool(keys & {"code", "shortcode", "short_code", "media_code", "media_id"})
    has_context = bool(keys & {"caption", "text", "user", "author", "owner", "user_info", "userinfo"})
    return has_identifier and has_context


def looks_like_xiaohongshu_note(record: dict[str, Any]) -> bool:
    keys = {str(key).lower() for key in record}
    if "note_id" in keys or "noteid" in keys:
        return True
    if "note_card" in keys or "notecard" in keys:
        return True
    model = str(record.get("model_type") or record.get("modelType") or "").lower()
    if model in {"note", "notes"} and ("id" in keys or "note_id" in keys or "noteid" in keys):
        return True
    has_id = "id" in keys
    has_title = bool(keys & {"title", "display_title", "displaytitle", "desc", "description"})
    has_user = bool(keys & {"user", "user_info", "userinfo", "author"})
    return has_id and has_title and has_user


def looks_like_post(record: dict[str, Any], route: dict[str, Any] | None = None) -> bool:
    shape = (route or {}).get("record_shape") or "instagram_post"
    if shape == "xiaohongshu_note":
        return looks_like_xiaohongshu_note(record)
    return looks_like_instagram_post(record)


def find_post_records(data: Any, route: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    seen_object_ids: set[int] = set()
    for item in nested_values(data):
        if isinstance(item, dict) and id(item) not in seen_object_ids and looks_like_post(item, route):
            seen_object_ids.add(id(item))
            records.append(item)
    return records


def flatten_xiaohongshu_note(record: dict[str, Any]) -> dict[str, Any]:
    """Merge note_card / noteCard wrappers into a single dict for field extraction."""
    card = record.get("note_card") if isinstance(record.get("note_card"), dict) else None
    if card is None and isinstance(record.get("noteCard"), dict):
        card = record["noteCard"]
    if not card:
        return record
    merged = dict(card)
    for key, value in record.items():
        if key in {"note_card", "noteCard"}:
            continue
        if key not in merged or merged[key] in (None, "", [], {}):
            merged[key] = value
    if not merged.get("note_id") and not merged.get("noteId"):
        outer_id = record.get("note_id") or record.get("noteId") or record.get("id")
        if outer_id not in (None, ""):
            merged["note_id"] = outer_id
    return merged


def truthy_business_value(value: Any) -> bool:
    if value is True:
        return True
    if isinstance(value, str) and value.lower() in {"true", "business", "professional", "creator_business"}:
        return True
    return False


def business_evidence(record: dict[str, Any], profile: dict[str, Any]) -> list[str]:
    evidence: list[str] = []
    flattened = list(nested_values(record)) + list(nested_values(profile))
    explicit_keys = {
        "is_business",
        "is_business_account",
        "business_account",
        "is_professional_account",
    }
    category_keys = {
        "business_category",
        "business_category_name",
        "category_name",
        "professional_category",
    }
    for item in flattened:
        if not isinstance(item, dict):
            continue
        for key, value in item.items():
            normalized_key = str(key).lower()
            if normalized_key in explicit_keys and truthy_business_value(value):
                evidence.append(f"explicit_business_flag:{normalized_key}")
            if normalized_key in category_keys and short_text(value, 120):
                evidence.append(f"business_category:{short_text(value, 120)}")

    external_url = first_value(profile, ("external_url", "externalurl", "website", "website_url", "url"))
    text = " ".join(
        filter(
            None,
            [
                short_text(first_value(profile, ("biography", "bio", "description")), 500),
                short_text(first_value(record, ("caption", "text", "title")), 500),
            ],
        )
    ).lower()
    if isinstance(external_url, str) and external_url.startswith(("https://", "http://")):
        if any(word in text for word in BUSINESS_WORDS):
            evidence.append("public_website_plus_business_description")
    return sorted(set(evidence))


def build_business_candidate(
    record: dict[str, Any], task_state: dict[str, Any], route: dict[str, Any], searched_at: str
) -> tuple[dict[str, Any] | None, str | None]:
    profile = first_mapping(record, ("user", "author", "owner", "user_info", "userinfo", "profile"))
    evidence = business_evidence(record, profile)
    if not evidence:
        return None, "no_explicit_business_evidence"

    code = first_value(record, ("code", "shortcode", "short_code", "media_code"))
    username = first_value(profile, ("username", "user_name", "handle"))
    if not isinstance(code, str) or not code.strip():
        return None, "missing_public_post_code"
    if not isinstance(username, str) or not username.strip():
        return None, "missing_public_account_handle"
    username = username.strip().lstrip("@")
    if not re.fullmatch(r"[A-Za-z0-9._]+", username):
        return None, "invalid_public_account_handle"

    public_website = first_value(profile, ("external_url", "externalurl", "website_url", "website"))
    if not isinstance(public_website, str) or not public_website.startswith(("https://", "http://")):
        public_website = None
    summary = short_text(
        first_value(profile, ("biography", "bio", "description"))
        or first_value(record, ("caption", "text", "title")),
        280,
    )

    post_code = code.strip()
    post_url = route["post_url_template"].format(post_code=post_code, account_handle=username)
    account_url = route["account_url_template"].format(post_code=post_code, account_handle=username)
    source_trace = {
        "source_type": "social_media",
        "platform": task_state["platform"],
        "task_id": task_state["task_id"],
        "query": task_state["query"],
        "normalized_query": task_state["normalized_query"],
        "api_endpoint": route["endpoint_path"],
        "documentation_url": route["documentation_url"],
        "searched_at": searched_at,
        "post_url": post_url,
    }
    return (
        {
            "platform": task_state["platform"],
            "account_handle": username,
            "account_url": account_url,
            "post_url": post_url,
            "market": task_state.get("market"),
            "city": task_state.get("city"),
            "buyer_type_ids": task_state.get("buyer_type_ids", []),
            "public_business_evidence": evidence,
            "public_website_url": public_website,
            "profile_summary": summary,
            "eligible_for_lead": False,
            "verification_required": [
                "confirm_business_account",
                "confirm_target_market_operation",
                "confirm_official_website",
                "confirm_buyer_type_and_product_fit",
            ],
            "source_trace": source_trace,
        },
        None,
    )


def _format_route_url(template: str, **fields: Any) -> str:
    class _Safe(dict):
        def __missing__(self, key: str) -> str:
            return ""

    return template.format_map(_Safe(**{k: ("" if v is None else v) for k, v in fields.items()}))


def build_content_note_candidate(
    record: dict[str, Any], task_state: dict[str, Any], route: dict[str, Any], searched_at: str
) -> tuple[dict[str, Any] | None, str | None]:
    """Retain public notes for ad/content intel (no business-account gate)."""
    note = flatten_xiaohongshu_note(record) if route.get("record_shape") == "xiaohongshu_note" else record
    profile = first_mapping(note, ("user", "author", "owner", "user_info", "userinfo", "profile"))
    note_id = first_value(note, ("note_id", "noteId", "noteid", "id"))
    if note_id is None or str(note_id).strip() == "":
        return None, "missing_note_id"
    note_id = str(note_id).strip()
    # Reject bare numeric-looking user objects mistaken as notes.
    if str(note.get("model_type") or note.get("modelType") or "").lower() in {
        "user",
        "users",
    }:
        return None, "not_a_note_record"

    title = first_value(
        note,
        ("display_title", "displayTitle", "title", "desc", "description", "caption", "text", "name"),
    )
    title_text = short_text(title, 280) if title is not None else None
    note_type_raw = first_value(note, ("type", "note_type", "noteType"))
    note_type = short_text(note_type_raw, 40) if note_type_raw is not None else None
    if note_type:
        lowered = note_type.lower()
        if lowered in {"video", "video_note", "video-note"}:
            note_type = "video"
        elif lowered in {"normal", "normal_note", "image", "normal-note"}:
            note_type = "image"

    user_id = first_value(profile, ("user_id", "userId", "userid", "id"))
    handle = first_value(
        profile,
        ("nickname", "nick_name", "user_name", "username", "red_id", "redId", "handle", "name"),
    )
    handle_text = ""
    if isinstance(handle, str) and handle.strip():
        handle_text = handle.strip().lstrip("@")
    elif user_id not in (None, ""):
        handle_text = str(user_id).strip()

    user_id_text = str(user_id).strip() if user_id not in (None, "") else handle_text
    if not title_text and not handle_text:
        return None, "missing_note_title_and_author"

    post_url = _format_route_url(
        route["post_url_template"],
        note_id=note_id,
        post_code=note_id,
        account_handle=handle_text,
        user_id=user_id_text,
    )
    account_url = None
    if user_id_text or handle_text:
        account_url = _format_route_url(
            route["account_url_template"],
            note_id=note_id,
            post_code=note_id,
            account_handle=handle_text,
            user_id=user_id_text or handle_text,
        )
        if not account_url.strip():
            account_url = None

    engagement: dict[str, Any] = {}
    for out_key, names in (
        ("likes", ("liked_count", "likedCount", "like_count", "likeCount", "likes")),
        ("collects", ("collected_count", "collectedCount", "collect_count", "collectCount", "collects")),
        ("comments", ("comment_count", "commentCount", "comments")),
        ("shares", ("share_count", "shareCount", "shared_count", "sharedCount", "shares")),
    ):
        value = first_value(note, names)
        if isinstance(value, (int, float)) or (isinstance(value, str) and str(value).isdigit()):
            engagement[out_key] = int(value)

    summary = title_text or short_text(
        first_value(note, ("desc", "description", "caption", "text")), 280
    )
    source_trace = {
        "source_type": "social_media",
        "platform": task_state["platform"],
        "task_id": task_state["task_id"],
        "query": task_state["query"],
        "normalized_query": task_state["normalized_query"],
        "api_endpoint": route["endpoint_path"],
        "documentation_url": route["documentation_url"],
        "searched_at": searched_at,
        "post_url": post_url,
        "note_id": note_id,
    }
    content = {
        "note_id": note_id,
        "title": title_text,
        "note_type": note_type,
        "author_id": user_id_text or None,
        "author_handle": handle_text or None,
    }
    if engagement:
        content["engagement"] = engagement
    return (
        {
            "platform": task_state["platform"],
            "account_handle": handle_text or user_id_text or note_id,
            "account_url": account_url,
            "post_url": post_url,
            "company_name": title_text,
            "market": task_state.get("market"),
            "city": task_state.get("city"),
            "buyer_type_ids": task_state.get("buyer_type_ids", []),
            "public_business_evidence": [],
            "public_website_url": None,
            "profile_summary": summary,
            "content": content,
            "eligible_for_lead": False,
            "verification_required": [
                "confirm_note_relevance",
                "confirm_public_content_fit",
            ],
            "source_trace": source_trace,
        },
        None,
    )


def build_candidate(
    record: dict[str, Any], task_state: dict[str, Any], route: dict[str, Any], searched_at: str
) -> tuple[dict[str, Any] | None, str | None]:
    adapter = candidate_adapter_name(route)
    if adapter == "content_note":
        return build_content_note_candidate(record, task_state, route, searched_at)
    return build_business_candidate(record, task_state, route, searched_at)


def find_next_cursor(data: Any) -> str:
    cursor_keys = {"end_cursor", "endcursor", "next_cursor", "nextcursor", "pagination_token", "paginationtoken"}
    for item in nested_values(data):
        if not isinstance(item, dict):
            continue
        for key, value in item.items():
            if str(key).lower() in cursor_keys and isinstance(value, str) and value.strip():
                return value.strip()
    return ""


def extract_pagination_session(data: Any, route: dict[str, Any]) -> dict[str, Any]:
    """Pull page-session fields (e.g. XHS search_id/session_id) for the next request."""
    mapping = route.get("pagination_session_parameters") or {}
    if not isinstance(mapping, dict) or not mapping:
        return {}
    root = data if isinstance(data, dict) else {}
    session: dict[str, Any] = {}
    for param_name, field_names in mapping.items():
        names: list[str]
        if isinstance(field_names, str):
            names = [field_names]
        elif isinstance(field_names, list):
            names = [str(item) for item in field_names]
        else:
            continue
        value = first_value(root, names) if root else None
        if value in (None, "", [], {}):
            continue
        if isinstance(value, (int, float)):
            session[param_name] = value
        else:
            text = str(value).strip()
            if text:
                session[param_name] = text
    return session


def next_pagination_token(
    data: Any,
    route: dict[str, Any],
    current_token: str,
    records_on_page: int,
) -> str:
    style = pagination_style(route)
    if style == "page":
        if records_on_page <= 0:
            return ""
        start = int(route.get("pagination_start") or 1)
        try:
            current = int(current_token) if str(current_token).strip() else start
        except (TypeError, ValueError):
            current = start
        return str(current + 1)
    return find_next_cursor(data)


def request_parameters_for_route(
    route: dict[str, Any],
    normalized_query: str,
    cursor: str,
    session: dict[str, Any] | None = None,
) -> dict[str, Any]:
    parameters: dict[str, Any] = {route["query_parameter"]: normalized_query}
    static = route.get("static_parameters")
    if isinstance(static, dict):
        for key, value in static.items():
            if value is not None:
                parameters[str(key)] = value
    if session:
        for key, value in session.items():
            if value not in (None, ""):
                parameters[str(key)] = value
    style = pagination_style(route)
    page_param = route.get("pagination_parameter")
    if not page_param:
        return parameters
    if style == "page":
        start = int(route.get("pagination_start") or 1)
        try:
            page = int(cursor) if str(cursor).strip() else start
        except (TypeError, ValueError):
            page = start
        parameters[page_param] = page
    elif cursor:
        parameters[page_param] = cursor
    return parameters


def classify_business_error(code: Any, message: str) -> str:
    normalized = f"{code} {message}".lower()
    if re.search(r"余额|欠费|充值|余额不足|credit|balance|insufficient.{0,20}(fund|credit|balance)|payment|overdue", normalized):
        return "blocked_insufficient_credit"
    if re.search(r"429|rate.?limit|too many|too fast|频率|限流|配额|quota", normalized):
        return "blocked_rate_limit"
    if re.search(r"401|token|unauthori[sz]ed|认证|授权|激活", normalized):
        return "blocked_authentication"
    if re.search(r"403|permission|权限|forbidden", normalized):
        return "blocked_permission"
    return "failed_business_error"


def import_sdk(root: Path, lock: dict[str, Any]) -> Any:
    backend_path = root / lock["backend"]["path"]
    if str(backend_path) not in sys.path:
        sys.path.insert(0, str(backend_path))
    try:
        from justoneapi import JustOneAPIClient
    except Exception as exc:  # pragma: no cover - depends on local Python environment
        raise CliError(f"unable to import the locked JustOneAPI SDK: {safe_text(exc, limit=200)}") from exc
    return JustOneAPIClient


def call_provider(
    client: Any,
    route: dict[str, Any],
    normalized_query: str,
    cursor: str,
    session: dict[str, Any] | None = None,
) -> Any:
    resource = getattr(client, route["resource"], None)
    if resource is None:
        raise CliError(f"locked SDK does not provide resource {route['resource']}")
    method = getattr(resource, route["method"], None)
    if method is None:
        raise CliError(f"locked SDK does not provide method {route['resource']}.{route['method']}")
    parameters = request_parameters_for_route(route, normalized_query, cursor, session)
    return method(**parameters)


def candidate_merge_key(candidate: dict[str, Any], merge_by: str = "account") -> str | None:
    platform = str(candidate.get("platform") or "")
    if merge_by == "post":
        post_url = candidate.get("post_url")
        if isinstance(post_url, str) and post_url.strip():
            return f"{platform}:post:{post_url.strip()}"
        note_id = (candidate.get("content") or {}).get("note_id") if isinstance(candidate.get("content"), dict) else None
        if note_id:
            return f"{platform}:note:{note_id}"
        return None
    handle = candidate.get("account_handle")
    if not isinstance(handle, str) or not handle.strip():
        return None
    return f"{platform}:account:{handle.strip().lower()}"


def merge_candidates(
    task_states: list[dict[str, Any]],
    routes_by_platform: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    routes_by_platform = routes_by_platform or {}
    merged: dict[str, dict[str, Any]] = {}
    for task_state in task_states:
        platform = str(task_state.get("platform") or "")
        route = routes_by_platform.get(platform) or {}
        if route.get("merge_by") in {"account", "post"}:
            merge_by = str(route["merge_by"])
        elif route and candidate_adapter_name(route) == "content_note":
            merge_by = "post"
        else:
            merge_by = "account"
        # Content notes always dedupe by post URL / note id.
        for candidate in task_state.get("candidates", []):
            local_merge = merge_by
            if candidate.get("content") and local_merge == "account":
                local_merge = "post"
            key = candidate_merge_key(candidate, local_merge)
            if not key:
                continue
            if key not in merged:
                first = dict(candidate)
                first["source_traces"] = [candidate["source_trace"]]
                first["task_ids"] = [candidate["source_trace"]["task_id"]]
                first["buyer_type_ids"] = sorted(set(candidate.get("buyer_type_ids", [])))
                first["public_business_evidence"] = sorted(
                    set(candidate.get("public_business_evidence") or [])
                )
                merged[key] = first
                continue
            existing = merged[key]
            existing["source_traces"].append(candidate["source_trace"])
            existing["task_ids"] = sorted(
                set(existing["task_ids"] + [candidate["source_trace"]["task_id"]])
            )
            existing["buyer_type_ids"] = sorted(
                set(existing["buyer_type_ids"] + candidate.get("buyer_type_ids", []))
            )
            existing["public_business_evidence"] = sorted(
                set(
                    (existing.get("public_business_evidence") or [])
                    + (candidate.get("public_business_evidence") or [])
                )
            )
            if not existing.get("public_website_url") and candidate.get("public_website_url"):
                existing["public_website_url"] = candidate["public_website_url"]
            if not existing.get("profile_summary") and candidate.get("profile_summary"):
                existing["profile_summary"] = candidate["profile_summary"]
            if not existing.get("content") and candidate.get("content"):
                existing["content"] = candidate["content"]
    return sorted(
        merged.values(),
        key=lambda item: (
            item.get("platform") or "",
            (item.get("post_url") or item.get("account_handle") or "").lower(),
        ),
    )


def candidate_policy_from_routes(routes_used: list[dict[str, Any]]) -> dict[str, Any]:
    if not routes_used:
        return {
            "retain_only_explicit_business_accounts": True,
            "exclude_comments": True,
            "exclude_media": True,
            "exclude_private_contact_data": True,
            "official_website_verification_required": True,
        }
    adapters = sorted({candidate_adapter_name(route) for route in routes_used})
    policies = [
        route.get("public_data_policy")
        if isinstance(route.get("public_data_policy"), dict)
        else {}
        for route in routes_used
    ]
    business_only = all(
        policy.get(
            "retain_only_explicit_business_accounts",
            candidate_adapter_name(route) == "business_account",
        )
        for route, policy in zip(routes_used, policies)
    )
    return {
        "candidate_adapters": adapters,
        "retain_only_explicit_business_accounts": business_only,
        "retain_public_notes": any(policy.get("retain_public_notes") for policy in policies),
        "exclude_comments": all(policy.get("exclude_comments", True) for policy in policies),
        "exclude_media": all(not policy.get("retain_media", False) for policy in policies),
        "exclude_private_contact_data": all(
            policy.get("exclude_private_contact_data", True) for policy in policies
        ),
        "official_website_verification_required": business_only,
    }


def write_execution_log(
    output_directory: Path,
    cli_name: str,
    operation: str,
    input_path: Path,
    token_file: Path | str,
    max_pages: int,
    lock: dict[str, Any],
) -> None:
    path = output_directory / "execution-log.md"
    backend = lock["backend"]
    lines = [
        "# JustOneAPI 社交媒体采集：执行日志",
        "",
        "仅保存有明确公开企业属性的账号证据；不保存令牌、原始响应、媒体、评论、私人联系方式或未验证个人账号。",
        "",
        "## 运行命令",
        "",
        "```sh",
        f"{cli_name} {operation} --input {input_path} --output {output_directory} --token-file {token_file} --max-pages {max_pages}",
        "```",
        "",
        "令牌文件路径仅用于运行时读取首行，令牌值不写入日志。",
        "",
        "## 固定依赖",
        "",
        f"- CLI：`{cli_name}` `{lock['cli']['version']}`",
        f"- 官方 SDK：`{backend['repository']}` `{backend['commit']}`",
        f"- API 基地址：`{backend['api_base_url']}`",
        f"- 单任务最多页数：`{max_pages}`",
        "",
        "## 任务结果",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def append_log_summary(output_directory: Path, run: dict[str, Any], task_states: list[dict[str, Any]]) -> None:
    path = output_directory / "execution-log.md"
    counts = Counter(state["status"] for state in task_states)
    with path.open("a", encoding="utf-8") as handle:
        for state in task_states:
            suffix = ""
            if state.get("last_error"):
                suffix = f" 错误类别：`{state['last_error'].get('classification')}`。"
            handle.write(
                f"- `{state['task_id']}` — `{state['status']}`，公开企业候选 `{state.get('candidate_count', 0)}` 条。{suffix}\n"
            )
        handle.write("\n## 汇总\n\n")
        handle.write(f"- 运行状态：`{run['status']}`\n")
        handle.write(f"- 任务状态计数：`{json.dumps(dict(sorted(counts.items())), ensure_ascii=False)}`\n")
        handle.write(f"- 公开企业账号候选：`{run['business_candidate_count']}`\n")
        if run.get("resume_hint"):
            handle.write(f"- 恢复：{run['resume_hint']}\n")


def mark_pending_after_block(task_state: dict[str, Any], blocker: str) -> dict[str, Any]:
    if task_state["status"] == "succeeded":
        return task_state
    task_state["status"] = "pending"
    task_state["last_error"] = {
        "classification": "not_attempted_after_run_block",
        "blocked_by": blocker,
        "message": "Not sent because an earlier task blocked the run; use resume after resolving that condition.",
        "resume_required": True,
    }
    return task_state


def execute_task(
    *,
    client: Any,
    task_state: dict[str, Any],
    route: dict[str, Any],
    max_pages: int,
    commands_path: Path,
    token: str,
    tool_root: Path | None = None,
    use_cache: bool = True,
    refresh_cache: bool = False,
) -> dict[str, Any]:
    if task_state["status"] == "succeeded" and task_state.get("pages_completed", 0) >= max_pages:
        return task_state

    root = tool_root or Path(__file__).resolve().parent
    # Fresh task: try full/partial disk cache before spending API credit.
    if (
        use_cache
        and not refresh_cache
        and int(task_state.get("pages_completed") or 0) == 0
        and not task_state.get("candidates")
    ):
        entry = cache_get_task(
            tool_root=root,
            platform=str(task_state.get("platform") or ""),
            route=route,
            normalized_query=str(task_state.get("normalized_query") or ""),
            max_pages=max_pages,
            force_off=not use_cache,
        )
        if entry is not None:
            pages = int(entry.get("pages_completed") or 0)
            if pages >= max_pages:
                return apply_task_cache_hit(
                    task_state, entry, max_pages=max_pages, commands_path=commands_path
                )
            seed_task_from_partial_cache(task_state, entry)

    task_state["status"] = "running"
    task_state["started_at"] = task_state.get("started_at") or utc_now()
    cursor = task_state.get("next_cursor") or ""
    session = dict(task_state.get("pagination_session") or {})
    excluded_counts: Counter[str] = Counter(task_state.get("excluded_record_counts", {}))
    candidates = list(task_state.get("candidates", []))
    existing_post_urls = {candidate.get("post_url") for candidate in candidates}
    adapter = candidate_adapter_name(route)

    while task_state.get("pages_completed", 0) < max_pages:
        attempted_at = utc_now()
        request_parameters = request_parameters_for_route(
            route, task_state["normalized_query"], cursor, session
        )
        append_jsonl(
            commands_path,
            {
                "executed_at": attempted_at,
                "task_id": task_state["task_id"],
                "platform": task_state["platform"],
                "method": "GET",
                "endpoint_path": route["endpoint_path"],
                "sdk_method": f"{route['resource']}.{route['method']}",
                "parameters": request_parameters,
                "token_logged": False,
            },
        )
        try:
            response = call_provider(
                client, route, task_state["normalized_query"], cursor, session
            )
        except Exception as exc:  # SDK translates httpx failures into its own exceptions.
            message = safe_text(exc, token)
            classification = "failed_transport"
            task_state["attempts"].append(
                {
                    "attempted_at": attempted_at,
                    "status": classification,
                    "api_code": None,
                    "provider_message": message,
                    "request_id": None,
                }
            )
            task_state["status"] = classification
            task_state["last_error"] = {
                "classification": classification,
                "api_code": None,
                "message": message,
                "request_id": None,
                "resume_required": True,
            }
            task_state["finished_at"] = utc_now()
            task_state["excluded_record_counts"] = dict(sorted(excluded_counts.items()))
            task_state["candidates"] = candidates
            task_state["candidate_count"] = len(candidates)
            task_state["pagination_session"] = session
            append_jsonl(
                commands_path,
                {
                    "finished_at": utc_now(),
                    "task_id": task_state["task_id"],
                    "status": classification,
                    "api_code": None,
                    "provider_message": message,
                    "request_id": None,
                },
            )
            return task_state

        raw = getattr(response, "raw_json", {})
        code = getattr(response, "code", None)
        message = safe_text(getattr(response, "message", ""), token)
        request_id = safe_text(raw.get("requestId") if isinstance(raw, dict) else None, token, 200) or None
        if not getattr(response, "success", False):
            classification = classify_business_error(code, message)
            task_state["attempts"].append(
                {
                    "attempted_at": attempted_at,
                    "status": classification,
                    "api_code": code,
                    "provider_message": message,
                    "request_id": request_id,
                }
            )
            task_state["status"] = classification
            task_state["last_error"] = {
                "classification": classification,
                "api_code": code,
                "message": message,
                "request_id": request_id,
                "resume_required": classification in BLOCKING_STATUSES or classification == "failed_business_error",
            }
            task_state["finished_at"] = utc_now()
            task_state["excluded_record_counts"] = dict(sorted(excluded_counts.items()))
            task_state["candidates"] = candidates
            task_state["candidate_count"] = len(candidates)
            task_state["pagination_session"] = session
            append_jsonl(
                commands_path,
                {
                    "finished_at": utc_now(),
                    "task_id": task_state["task_id"],
                    "status": classification,
                    "api_code": code,
                    "provider_message": message,
                    "request_id": request_id,
                },
            )
            return task_state

        data = getattr(response, "data", None)
        records = find_post_records(data, route)
        searched_at = utc_now()
        newly_retained = 0
        for record in records:
            candidate, exclusion = build_candidate(record, task_state, route, searched_at)
            if candidate is None:
                excluded_counts[exclusion or "unknown"] += 1
                continue
            if candidate["post_url"] in existing_post_urls:
                continue
            existing_post_urls.add(candidate["post_url"])
            candidates.append(candidate)
            newly_retained += 1

        refreshed_session = extract_pagination_session(data, route)
        if refreshed_session:
            session.update(refreshed_session)
        task_state["records_seen"] = task_state.get("records_seen", 0) + len(records)
        task_state["pages_completed"] = task_state.get("pages_completed", 0) + 1
        cursor = next_pagination_token(data, route, cursor, len(records))
        task_state["next_cursor"] = cursor
        task_state["pagination_session"] = session
        attempt_meta = {
            "attempted_at": attempted_at,
            "status": "succeeded",
            "api_code": code,
            "provider_message": message or None,
            "request_id": request_id,
            "records_seen": len(records),
            "candidates_retained": newly_retained,
            "business_candidates_retained": newly_retained if adapter == "business_account" else 0,
            "content_candidates_retained": newly_retained if adapter == "content_note" else 0,
        }
        task_state["attempts"].append(attempt_meta)
        task_state["last_error"] = None
        append_jsonl(
            commands_path,
            {
                "finished_at": utc_now(),
                "task_id": task_state["task_id"],
                "status": "succeeded",
                "api_code": code,
                "provider_message": message or None,
                "request_id": request_id,
                "records_seen": len(records),
                "candidates_retained": newly_retained,
            },
        )
        if not cursor:
            task_state["status"] = "succeeded"
            task_state["pagination_truncated"] = False
            break
        if task_state["pages_completed"] >= max_pages:
            task_state["status"] = "succeeded"
            task_state["pagination_truncated"] = True
            break

    task_state["finished_at"] = utc_now()
    task_state["excluded_record_counts"] = dict(sorted(excluded_counts.items()))
    task_state["candidates"] = candidates
    task_state["candidate_count"] = len(candidates)
    task_state["pagination_session"] = session
    if task_state.get("status") == "succeeded" and use_cache:
        cache_key = cache_put_task(
            tool_root=root,
            platform=str(task_state.get("platform") or ""),
            route=route,
            normalized_query=str(task_state.get("normalized_query") or ""),
            max_pages=max_pages,
            task_state=task_state,
            force_off=not use_cache,
        )
        if cache_key:
            task_state["cache"] = {
                **(task_state.get("cache") if isinstance(task_state.get("cache"), dict) else {}),
                "stored": True,
                "cache_key": cache_key,
            }
    return task_state


def create_run_metadata(
    *,
    input_document: dict[str, Any],
    lock: dict[str, Any],
    version: str,
    output_directory: Path,
    input_snapshot: Path,
    token_file: Path | str,
    max_pages: int,
    operation: str,
    started_at: str,
    task_states: list[dict[str, Any]],
    routes_by_platform: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    states = Counter(state["status"] for state in task_states)
    candidates = merge_candidates(task_states, routes_by_platform)

    if states.get("blocked_insufficient_credit"):
        status = "blocked_insufficient_credit"
    elif states.get("blocked_authentication"):
        status = "blocked_authentication"
    elif states.get("blocked_permission"):
        status = "blocked_permission"
    elif states.get("blocked_rate_limit"):
        status = "blocked_rate_limit"
    elif any(name.startswith("failed_") for name in states):
        status = "completed_with_errors"
    elif states.get("pending"):
        status = "pending"
    else:
        status = "succeeded"

    resume_hint = None
    if status.startswith("blocked_") or status == "completed_with_errors":
        resume_hint = f"Resolve the provider condition, then run: {lock['cli']['name']} resume --output {output_directory}"
    return {
        "schema_version": "clue-justoneapi-cli.run.v1",
        "collection_id": input_document.get("collection_id"),
        "status": status,
        "started_at": started_at,
        "finished_at": utc_now(),
        "operation": operation,
        "cli": {"name": lock["cli"]["name"], "version": version},
        "backend": {
            "repository": lock["backend"]["repository"],
            "ref": lock["backend"]["ref"],
            "commit": lock["backend"]["commit"],
            "api_base_url": lock["backend"]["api_base_url"],
        },
        "request": {
            "input_snapshot": str(input_snapshot),
            "token_file": str(token_file),
            "token_logged": False,
            "max_pages_per_task": max_pages,
        },
        "task_status_counts": dict(sorted(states.items())),
        "business_candidate_count": len(
            [item for item in candidates if item.get("public_business_evidence")]
        ),
        "content_candidate_count": len(
            [item for item in candidates if item.get("content")]
        ),
        "candidate_count": len(candidates),
        "resume_hint": resume_hint,
    }


def run_collection(
    *,
    root: Path,
    lock: dict[str, Any],
    routes: dict[str, Any],
    version: str,
    output_directory: Path,
    input_path: Path,
    token_file: Path | str,
    max_pages: int,
    operation: str,
    resume: bool,
    use_cache: bool = True,
    refresh_cache: bool = False,
) -> int:
    assert_backend(root, lock)
    input_document = read_json(input_path)
    tasks = extract_tasks(input_document, routes)
    commands_path = output_directory / "commands.jsonl"
    if not resume:
        output_directory.mkdir(parents=True, exist_ok=False)
        input_snapshot = output_directory / "input.snapshot.json"
        shutil.copyfile(input_path, input_snapshot)
        started_at = utc_now()
        write_execution_log(output_directory, lock["cli"]["name"], operation, input_path, token_file, max_pages, lock)
    else:
        input_snapshot = output_directory / "input.snapshot.json"
        if not input_snapshot.is_file():
            raise CliError(f"input snapshot is missing: {input_snapshot}")
        previous_run = read_json(output_directory / "run.json") if (output_directory / "run.json").is_file() else {}
        started_at = previous_run.get("started_at") or utc_now()
        with (output_directory / "execution-log.md").open("a", encoding="utf-8") as handle:
            handle.write("\n## 恢复命令\n\n```sh\n")
            handle.write(f"{lock['cli']['name']} resume --output {output_directory} --token-file {token_file} --max-pages {max_pages}\n")
            handle.write("```\n\n")

    token = load_token(token_file)
    # Only construct the SDK client when at least one task may need the network.
    # Full cache hits still import/assert backend (version pin) but avoid HTTP.
    client_class = import_sdk(root, lock)
    client = client_class(
        token=token,
        base_url=lock["backend"]["api_base_url"],
        timeout=int(lock["run_defaults"]["request_timeout_seconds"]),
        raise_on_business_error=False,
    )
    task_states: list[dict[str, Any]] = []
    run_blocker: str | None = None
    try:
        for descriptor in tasks:
            task = descriptor["task"]
            route = descriptor["route"]
            state_file = task_path(output_directory, task["task_id"])
            if state_file.is_file():
                state = read_json(state_file)
            elif route is None:
                state = {
                    **task_template(task, {"resource": None, "method": None, "endpoint_path": None, "documentation_url": None}, task["query"]),
                    "status": "skipped_unsupported_platform",
                    "finished_at": utc_now(),
                    "last_error": {
                        "classification": "unsupported_platform",
                        "message": f"No enabled JustOneAPI route is configured for {task['platform']}.",
                        "resume_required": False,
                    },
                }
            else:
                state = task_template(task, route, descriptor["normalized_query"])

            if run_blocker:
                state = mark_pending_after_block(state, run_blocker)
                atomic_write_json(state_file, state)
                task_states.append(state)
                continue
            if route is None:
                atomic_write_json(state_file, state)
                task_states.append(state)
                continue
            state = execute_task(
                client=client,
                task_state=state,
                route=route,
                max_pages=max_pages,
                commands_path=commands_path,
                token=token,
                tool_root=root,
                use_cache=use_cache,
                refresh_cache=refresh_cache,
            )
            atomic_write_json(state_file, state)
            task_states.append(state)
            if state["status"] in BLOCKING_STATUSES:
                run_blocker = state["status"]
    finally:
        client.close()

    routes_by_platform = {
        name: route
        for name, route in (routes.get("platforms") or {}).items()
        if isinstance(route, dict) and route.get("enabled")
    }
    routes_used = [
        routes_by_platform[state["platform"]]
        for state in task_states
        if state.get("platform") in routes_by_platform
        and state.get("status") != "skipped_unsupported_platform"
    ]
    candidates = merge_candidates(task_states, routes_by_platform)
    atomic_write_json(
        output_directory / "social-media-candidates.json",
        {
            "schema_version": "clue.data-collection.social-media-candidates.v1",
            "collection_id": input_document.get("collection_id"),
            "source_type": "social_media",
            "generated_at": utc_now(),
            "candidate_count": len(candidates),
            "candidate_policy": candidate_policy_from_routes(routes_used),
            "candidates": candidates,
        },
    )
    run = create_run_metadata(
        input_document=input_document,
        lock=lock,
        version=version,
        output_directory=output_directory,
        input_snapshot=input_snapshot,
        token_file=token_file,
        max_pages=max_pages,
        operation=operation,
        started_at=started_at,
        task_states=task_states,
        routes_by_platform=routes_by_platform,
    )
    atomic_write_json(output_directory / "run.json", run)
    append_log_summary(output_directory, run, task_states)
    blocking_errors = [
        {
            "task_id": state["task_id"],
            "classification": state["last_error"]["classification"],
            "api_code": state["last_error"].get("api_code"),
            "provider_message": state["last_error"].get("message"),
            "request_id": state["last_error"].get("request_id"),
        }
        for state in task_states
        if state.get("last_error") and state["status"] in BLOCKING_STATUSES | {"failed_business_error", "failed_transport"}
    ]
    print_json(
        {
            "status": run["status"],
            "output": str(output_directory),
            "task_status_counts": run["task_status_counts"],
            "business_candidate_count": run["business_candidate_count"],
            "content_candidate_count": run.get("content_candidate_count", 0),
            "candidate_count": run.get("candidate_count", run["business_candidate_count"]),
            "cache": cache_stats(),
            "provider_errors": blocking_errors,
            "resume_hint": run["resume_hint"],
        }
    )
    if run["status"] == "blocked_insufficient_credit":
        return 75
    if run["status"].startswith("blocked_") or run["status"] == "completed_with_errors":
        return 1
    return 0


def parse_positive_integer(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a positive integer") from exc
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="clue-justoneapi-cli",
        description="Versioned, resumable JustOneAPI social-media collection wrapper.",
    )
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("version", help="Print CLI, SDK and enabled route versions.")
    subcommands.add_parser("backend-status", help="Verify the locked SDK checkout.")

    batch = subcommands.add_parser("batch", help="Run source_type=social_media tasks into a new output directory.")
    batch.add_argument("--workspace", help="Customer workspace ID. Uses acquisition/customer-data-collection under POLARIS_LITERATURE_WORKSPACES_ROOT.")
    batch.add_argument("--workspaces-root", help="Override POLARIS_LITERATURE_WORKSPACES_ROOT for --workspace.")
    batch.add_argument("--run-id", help="When used with --workspace and no --output, create this run directory under runs/.")
    batch.add_argument("--input", help="Collection input JSON.")
    batch.add_argument("--output", help="New output directory.")
    batch.add_argument("--token-file", help="Token file; default is the selected Polaris env file. Only its first line is read.")
    batch.add_argument("--max-pages", type=parse_positive_integer, help="Maximum API pages per task; default is the version lock.")
    batch.add_argument(
        "--no-cache",
        action="store_true",
        help="Do not read or write the shared social-media task cache.",
    )
    batch.add_argument(
        "--refresh-cache",
        action="store_true",
        help="Ignore cache hits and overwrite cache entries after a live fetch.",
    )

    resume = subcommands.add_parser("resume", help="Continue a blocked or failed existing run without redoing successful tasks.")
    resume.add_argument("--workspace", help="Customer workspace ID. Resolves --run-id under acquisition/customer-data-collection/runs/.")
    resume.add_argument("--workspaces-root", help="Override POLARIS_LITERATURE_WORKSPACES_ROOT for --workspace.")
    resume.add_argument("--run-id", help="Existing run directory ID when --workspace is used.")
    resume.add_argument("--output", help="Existing output directory.")
    resume.add_argument("--token-file", help="Token file; default is the selected Polaris env file. Only its first line is read.")
    resume.add_argument("--max-pages", type=parse_positive_integer, help="Maximum API pages per task; default is the original run setting.")
    resume.add_argument(
        "--no-cache",
        action="store_true",
        help="Do not read or write the shared social-media task cache.",
    )
    resume.add_argument(
        "--refresh-cache",
        action="store_true",
        help="Ignore cache hits and overwrite cache entries after a live fetch.",
    )
    return parser


def apply_workspace_defaults(args: argparse.Namespace) -> None:
    workspace = getattr(args, "workspace", None)
    workspaces_root = getattr(args, "workspaces_root", None)
    run_id = getattr(args, "run_id", None)
    if workspaces_root and not workspace:
        raise CliError("--workspaces-root requires --workspace")
    if run_id and not workspace:
        raise CliError("--run-id requires --workspace")
    if run_id and getattr(args, "output", None):
        raise CliError("--output and --run-id cannot be used together")
    if workspace:
        if collection_paths is None:
            raise CliError("workspace path helper is unavailable")
        try:
            scope = collection_paths(workspace, getattr(args, "workspaces_root", None))
        except WorkspacePathError as error:
            raise CliError(str(error)) from error
        if args.command == "batch" and not args.input:
            args.input = str(scope.input_json)
        if not args.output:
            if not args.run_id:
                raise CliError("--run-id is required with --workspace when --output is omitted")
            if not RUN_ID_PATTERN.fullmatch(args.run_id):
                raise CliError("--run-id may contain only letters, numbers, dot, underscore and hyphen")
            args.output = str(scope.runs / args.run_id)
    if args.command == "batch" and not args.input:
        raise CliError("--input is required unless --workspace is set")
    if not args.output:
        raise CliError("--output is required unless --workspace is used with --run-id")


def main(argv: list[str]) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parent
    lock, routes, version = load_configuration(root)

    if args.command == "version":
        print_json(
            {
                "cli": {"name": lock["cli"]["name"], "version": version},
                "backend": {
                    "repository": lock["backend"]["repository"],
                    "ref": lock["backend"]["ref"],
                    "commit": lock["backend"]["commit"],
                    "license": lock["backend"]["license"],
                    "api_base_url": lock["backend"]["api_base_url"],
                },
                "enabled_platforms": sorted(
                    name for name, route in routes["platforms"].items() if route.get("enabled")
                ),
            }
        )
        return 0
    if args.command == "backend-status":
        print_json({"cli": {"name": lock["cli"]["name"], "version": version}, "backend": backend_status(root, lock)})
        return 0

    apply_workspace_defaults(args)
    output_directory = absolute_path(args.output)
    token_file: Path | str
    if args.token_file == "-":
        token_file = "-"
    elif args.token_file:
        token_file = absolute_path(args.token_file)
    else:
        token_file = default_token_file(root, lock)
    use_cache = not bool(getattr(args, "no_cache", False))
    refresh_cache = bool(getattr(args, "refresh_cache", False))
    if args.command == "batch":
        input_path = absolute_path(args.input)
        if not input_path.is_file():
            raise CliError(f"input file is missing: {input_path}")
        if output_directory.exists():
            raise CliError(f"output directory already exists: {output_directory}")
        max_pages = args.max_pages or int(lock["run_defaults"]["max_pages_per_task"])
        reset_cache_stats()
        return run_collection(
            root=root,
            lock=lock,
            routes=routes,
            version=version,
            output_directory=output_directory,
            input_path=input_path,
            token_file=token_file,
            max_pages=max_pages,
            operation="batch",
            resume=False,
            use_cache=use_cache,
            refresh_cache=refresh_cache,
        )

    if not output_directory.is_dir():
        raise CliError(f"output directory is missing: {output_directory}")
    input_path = output_directory / "input.snapshot.json"
    if not input_path.is_file():
        raise CliError(f"input snapshot is missing: {input_path}")
    previous_run = read_json(output_directory / "run.json") if (output_directory / "run.json").is_file() else {}
    max_pages = args.max_pages or int(previous_run.get("request", {}).get("max_pages_per_task") or lock["run_defaults"]["max_pages_per_task"])
    reset_cache_stats()
    return run_collection(
        root=root,
        lock=lock,
        routes=routes,
        version=version,
        output_directory=output_directory,
        input_path=input_path,
        token_file=token_file,
        max_pages=max_pages,
        operation="resume",
        resume=True,
        use_cache=use_cache,
        refresh_cache=refresh_cache,
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except CliError as exc:
        print(f"error: {safe_text(exc, limit=500)}", file=sys.stderr)
        raise SystemExit(1)
