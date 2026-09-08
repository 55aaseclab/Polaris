#!/usr/bin/env python3
"""Opt-in Xiaohongshu post capture through the locked JustOneAPI SDK.

The regular ``tools/social-media`` discovery route intentionally discards
comments and media.  This module is a separate, explicit single-post capture
path for a URL supplied by the operator.  It stores only normalized public
content, omits raw provider responses and profile identifiers, and writes
media as locally referenced files.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import sys
import tempfile
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse, urlunparse
from urllib.request import Request, urlopen


TEXT_SCHEMA = "clue.xiaohongshu.post-text.v1"
MEDIA_SCHEMA = "clue.xiaohongshu.media-manifest.v1"
CAPTURE_SCHEMA = "clue.xiaohongshu.post-capture.v1"
DEFAULT_TIMEOUT_S = 90
DEFAULT_MEDIA_MAX_BYTES = 25 * 1024 * 1024
DETAIL_METHODS = (
    "get_note_detail_v7",
    "get_note_detail_v4",
    "get_note_detail_v5",
    "get_note_detail_v3",
    "get_note_detail_v2",
    "get_note_detail_v1",
)
COMMENT_METHODS = (
    "get_note_comment_v4",
    "get_note_comment_v3",
    "get_note_comment_v2",
)
SUB_COMMENT_METHODS = ("get_note_sub_comment_v2",)
NOTE_ID_PATTERN = re.compile(r"\b([0-9a-zA-Z]{16,64})\b")
TOKEN_RE = re.compile(r"(?i)(token=)[^&\s]+")


class XhsCaptureError(RuntimeError):
    """A safe, user-actionable capture failure."""


class ResponseLike(Protocol):
    success: bool
    code: Any
    message: str
    data: Any
    raw_json: dict[str, Any]


Fetcher = Callable[[str, int, int], tuple[bytes, str | None]]
Progress = Callable[[str, dict[str, Any]], None]


@dataclass(frozen=True)
class MediaCandidate:
    """A logical image with one or more provider URL fallbacks."""

    media_id: str
    kind: str
    owner_locator: str
    source_field: str
    urls: tuple[str, ...]


def repo_root() -> Path:
    """ad_content/xhs_capture.py → repository root."""
    return Path(__file__).resolve().parents[3]


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def iso_timestamp(value: Any) -> str | None:
    """Convert an XHS Unix-second timestamp to ISO-8601, when available."""
    if isinstance(value, bool):
        return None
    try:
        timestamp = int(value)
    except (TypeError, ValueError):
        return None
    if timestamp <= 0:
        return None
    return datetime.fromtimestamp(timestamp, UTC).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def safe_error(value: Any, token: str = "") -> str:
    text = str(value or "")
    if token:
        text = text.replace(token, "[REDACTED]")
    text = TOKEN_RE.sub(r"\1[REDACTED]", text)
    return " ".join(text.split())[:500]


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def parse_env_value(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def read_token(token_file: str | None = None) -> str:
    """Resolve a token without ever returning it in an output structure."""
    value = os.environ.get("JUSTONEAPI_TOKEN", "").strip()
    if value:
        return value

    candidates: list[Path] = []
    if token_file and token_file != "-":
        candidates.append(Path(token_file).expanduser().resolve())
    candidates.extend(
        [repo_root() / ".env", repo_root() / "tools" / "social-media" / ".env"]
    )
    for path in candidates:
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, _, raw = stripped.partition("=")
            if key.strip() == "JUSTONEAPI_TOKEN":
                value = parse_env_value(raw)
                if value:
                    return value
    if token_file == "-":
        value = sys.stdin.readline().strip()
        if value:
            return value
    raise XhsCaptureError(
        "JUSTONEAPI_TOKEN is required (environment, repository .env, or --token-file)"
    )


def import_sdk_client() -> Any:
    """Load the exact SDK checkout recorded by tools/social-media."""
    backend = repo_root() / "tools" / "social-media" / "backend" / "justoneapi-python"
    if not backend.is_dir():
        raise XhsCaptureError(f"locked JustOneAPI SDK checkout is missing: {backend}")
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))
    try:
        from justoneapi import JustOneAPIClient
    except Exception as error:  # pragma: no cover - depends on local runtime
        raise XhsCaptureError(
            "unable to import the locked JustOneAPI SDK; run through "
            "clue-data-collection capture-xhs-post or use the social-media venv: "
            f"{safe_error(error)}"
        ) from error
    return JustOneAPIClient


def clean_text(value: Any) -> str:
    """Keep text while removing XHS search-highlight markup."""
    if not isinstance(value, str):
        return ""
    text = re.sub(r"\[搜索高亮\]", "", value)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def first_text(mapping: dict[str, Any], *keys: str) -> str:
    for key in keys:
        result = clean_text(mapping.get(key))
        if result:
            return result
    return ""


def iter_mappings(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from iter_mappings(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_mappings(child)


def url_note_id(value: str) -> str | None:
    """Extract a note ID from a canonical XHS URL or query parameter."""
    try:
        parsed = urlparse(value)
    except ValueError:
        return None
    query = parse_qs(parsed.query)
    for key in ("note_id", "noteId", "id"):
        values = query.get(key)
        if values:
            candidate = values[0].strip()
            if NOTE_ID_PATTERN.fullmatch(candidate):
                return candidate
    pieces = [piece for piece in parsed.path.split("/") if piece]
    for marker in ("explore", "item"):
        if marker in pieces:
            index = pieces.index(marker)
            if index + 1 < len(pieces) and NOTE_ID_PATTERN.fullmatch(pieces[index + 1]):
                return pieces[index + 1]
    return None


def canonical_note_url(note_id: str) -> str:
    return f"https://www.xiaohongshu.com/explore/{note_id}"


def response_ok(response: Any) -> bool:
    return bool(getattr(response, "success", False)) and getattr(response, "data", None) is not None


def response_error(response: Any) -> str:
    return safe_error(
        f"code={getattr(response, 'code', None)} message={getattr(response, 'message', '')}"
    )


def call_method(
    resource: Any,
    method_name: str,
    kwargs: dict[str, Any],
    *,
    retries: int,
    sleep: Callable[[float], None],
) -> tuple[Any | None, list[str]]:
    """Call one SDK method with bounded retries, returning safe errors only."""
    method = getattr(resource, method_name, None)
    if method is None:
        return None, [f"SDK method unavailable: xiaohongshu.{method_name}"]
    errors: list[str] = []
    for attempt in range(max(1, retries)):
        try:
            response = method(**kwargs)
        except Exception as error:  # pragma: no cover - provider/network dependent
            errors.append(f"{method_name} transport error: {safe_error(error)}")
        else:
            if response_ok(response):
                return response, errors
            errors.append(f"{method_name} {response_error(response)}")
        if attempt + 1 < max(1, retries):
            sleep(min(2.0, 0.25 * (2**attempt)))
    return None, errors


def call_fallback_methods(
    resource: Any,
    methods: Iterable[str],
    kwargs: dict[str, Any],
    *,
    retries: int,
    sleep: Callable[[float], None],
) -> tuple[Any, str, list[str]]:
    errors: list[str] = []
    for method_name in methods:
        response, failures = call_method(
            resource, method_name, kwargs, retries=retries, sleep=sleep
        )
        errors.extend(failures)
        if response is not None:
            return response, method_name, errors
    tried = ", ".join(methods)
    detail = "; ".join(errors[-4:]) or "no successful provider response"
    raise XhsCaptureError(f"JustOneAPI call failed after {tried}: {detail}")


def resolve_note(
    client: Any,
    shared_url: str,
    *,
    retries: int,
    sleep: Callable[[float], None],
) -> tuple[str, str, str, list[str]]:
    """Resolve a short/share link and return note id + canonical URL + route."""
    direct_id = url_note_id(shared_url)
    if direct_id:
        return direct_id, canonical_note_url(direct_id), "direct_url", []
    resource = getattr(client, "xiaohongshu", None)
    if resource is None:
        raise XhsCaptureError("locked SDK does not provide xiaohongshu resource")
    response, errors = call_method(
        resource,
        "share_url_transfer_v1",
        {"share_url": shared_url},
        retries=retries,
        sleep=sleep,
    )
    if response is None:
        detail = "; ".join(errors[-3:])
        raise XhsCaptureError(f"could not resolve Xiaohongshu share URL: {detail}")
    data = getattr(response, "data", None)
    strings: list[str] = []
    for mapping in iter_mappings(data):
        for key in ("redirect_url", "url", "share_url", "note_id", "noteId", "id"):
            value = mapping.get(key)
            if isinstance(value, str) and value.strip():
                strings.append(value.strip())
    for value in strings:
        candidate = url_note_id(value)
        if candidate:
            # Resolver URLs routinely contain expiring share parameters.  The
            # canonical form is sufficient for citation and avoids retaining
            # those transient parameters in the normalized corpus.
            return candidate, canonical_note_url(candidate), "share_url_transfer_v1", errors
        if NOTE_ID_PATTERN.fullmatch(value):
            return value, canonical_note_url(value), "share_url_transfer_v1", errors
    raise XhsCaptureError("share URL resolved but the provider response contained no note id")


def find_note_payload(data: Any, note_id: str) -> dict[str, Any]:
    """Locate the actual note card across response-version wrapper shapes."""
    candidates: list[dict[str, Any]] = []
    for mapping in iter_mappings(data):
        candidate_id = mapping.get("id") or mapping.get("note_id") or mapping.get("noteId")
        if str(candidate_id or "") != note_id:
            continue
        if any(key in mapping for key in ("desc", "title", "images_list", "user", "type")):
            candidates.append(mapping)
    if not candidates:
        raise XhsCaptureError("note detail response did not contain the requested note")
    return max(
        candidates,
        key=lambda item: sum(
            1 for key in ("title", "desc", "images_list", "user", "liked_count") if key in item
        ),
    )


def unique_urls(values: Iterable[Any]) -> tuple[str, ...]:
    found: list[str] = []
    for value in values:
        if not isinstance(value, str):
            continue
        url = value.strip()
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            continue
        if url not in found:
            found.append(url)
    return tuple(found)


def urls_in_media_value(value: Any) -> list[str]:
    """Read URLs from API media values without following arbitrary objects."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        result: list[str] = []
        for item in value:
            result.extend(urls_in_media_value(item))
        return result
    if not isinstance(value, dict):
        return []
    result: list[str] = []
    for key in (
        "url",
        "original",
        "src",
        "image_url",
        "picture_url",
        "url_default",
        "url_pre",
        "url_list",
        "url_multi_level",
    ):
        if key in value:
            result.extend(urls_in_media_value(value[key]))
    return result


def note_media_candidates(note: dict[str, Any], note_id: str) -> list[MediaCandidate]:
    """Return logical note images, including share-thumbnail fallbacks."""
    raw_images = note.get("images_list")
    if not isinstance(raw_images, list):
        raw_images = note.get("images") if isinstance(note.get("images"), list) else []
    fallbacks: list[str] = []
    for parent_key, child_key in (
        ("share_info", "image"),
        ("mini_program_info", "thumb"),
        ("qq_mini_program_info", "thumb"),
    ):
        parent = note.get(parent_key)
        if isinstance(parent, dict):
            value = parent.get(child_key)
            if isinstance(value, str):
                fallbacks.append(value)
    candidates: list[MediaCandidate] = []
    for index, image in enumerate(raw_images, start=1):
        if not isinstance(image, dict):
            continue
        source_urls = urls_in_media_value(image)
        if index == 1:
            source_urls.extend(fallbacks)
        urls = unique_urls(source_urls)
        if urls:
            candidates.append(
                MediaCandidate(
                    media_id=f"note-{note_id}-image-{index:03d}",
                    kind="note_image",
                    owner_locator=f"note:{note_id}",
                    source_field="images_list",
                    urls=urls,
                )
            )
    if not candidates and fallbacks:
        candidates.append(
            MediaCandidate(
                media_id=f"note-{note_id}-image-001",
                kind="note_image",
                owner_locator=f"note:{note_id}",
                source_field="share_info.image",
                urls=unique_urls(fallbacks),
            )
        )
    return candidates


COMMENT_MEDIA_KEYS = {
    "image",
    "images",
    "image_list",
    "image_info",
    "picture",
    "pictures",
    "picture_list",
    "photo",
    "photos",
    "media",
    "media_list",
}


def comment_media_candidates(comment: dict[str, Any], comment_id: str) -> list[MediaCandidate]:
    """Extract only declared comment attachments, never user avatar fields."""
    candidates: list[MediaCandidate] = []
    index = 0
    for key, value in comment.items():
        if key.lower() not in COMMENT_MEDIA_KEYS:
            continue
        urls = unique_urls(urls_in_media_value(value))
        if not urls:
            continue
        index += 1
        candidates.append(
            MediaCandidate(
                media_id=f"comment-{comment_id}-image-{index:03d}",
                kind="comment_image",
                owner_locator=f"comment:{comment_id}",
                source_field=key,
                urls=urls,
            )
        )
    return candidates


def normalize_note(note: dict[str, Any], note_id: str) -> dict[str, Any]:
    user = note.get("user") if isinstance(note.get("user"), dict) else {}
    return {
        "id": note_id,
        "title": first_text(note, "title", "display_title"),
        "text": first_text(note, "desc", "content", "description"),
        "author_display_name": first_text(user, "nickname", "name"),
        "published_at": iso_timestamp(note.get("time")),
        "note_type": first_text(note, "type") or "other",
        "tags": [
            first_text(item, "name")
            for item in note.get("topics", [])
            if isinstance(item, dict) and first_text(item, "name")
        ],
        "engagement": {
            "likes": int(note.get("liked_count") or 0),
            "collects": int(note.get("collected_count") or 0),
            "comments": int(note.get("comments_count") or 0),
            "shares": int(note.get("shared_count") or 0),
        },
        "evidence": [
            item
            for item in (
                {"quote": first_text(note, "title"), "locator": "note.title"}
                if first_text(note, "title")
                else None,
                {"quote": first_text(note, "desc"), "locator": "note.body"}
                if first_text(note, "desc")
                else None,
            )
            if item is not None
        ],
    }


def normalize_comment(
    comment: dict[str, Any],
    *,
    parent_id: str | None,
    depth: int,
) -> dict[str, Any] | None:
    comment_id = str(comment.get("id") or "").strip()
    if not comment_id:
        return None
    audio = comment.get("audio_info") if isinstance(comment.get("audio_info"), dict) else {}
    transcript = first_text(audio, "asr_text")
    text = first_text(comment, "content") or transcript
    attachment_marker = "[image attachment]" if comment_media_candidates(comment, comment_id) else ""
    if not text and attachment_marker:
        text = attachment_marker
    tags = [
        first_text(item, "name")
        for item in comment.get("hash_tags", [])
        if isinstance(item, dict) and first_text(item, "name")
    ]
    result: dict[str, Any] = {
        "id": comment_id,
        "parent_id": parent_id,
        "depth": depth,
        "text": text,
        "audio_transcript": transcript or None,
        "published_at": iso_timestamp(comment.get("time")),
        "like_count": int(comment.get("like_count") or 0),
        "reply_count_reported": int(comment.get("sub_comment_count") or 0),
        "tags": tags,
        "source_locator": f"comment:{comment_id}",
        "attachments": [],
    }
    # ``status`` is public visibility state, not a profile or location field.
    if isinstance(comment.get("status"), int):
        result["provider_status"] = comment["status"]
    return result


def cursor_from(data: Any) -> str:
    if not isinstance(data, dict):
        return ""
    value = data.get("cursor") or data.get("last_cursor") or data.get("lastCursor")
    return value.strip() if isinstance(value, str) else ""


def bool_from(data: Any, *keys: str) -> bool:
    if not isinstance(data, dict):
        return False
    return any(bool(data.get(key)) for key in keys)


def int_from(data: Any, *keys: str) -> int | None:
    if not isinstance(data, dict):
        return None
    for key in keys:
        value = data.get(key)
        if isinstance(value, bool):
            continue
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return None


def collect_replies(
    *,
    resource: Any,
    note_id: str,
    parent: dict[str, Any],
    initial: Iterable[dict[str, Any]],
    retries: int,
    max_pages: int | None,
    sleep: Callable[[float], None],
    progress: Progress | None = None,
) -> tuple[list[dict[str, Any]], list[str], bool]:
    """Complete one reply thread only when inline replies are insufficient."""
    parent_id = str(parent.get("id") or "").strip()
    expected = int_from(parent, "sub_comment_count") or 0
    replies = {
        str(item.get("id")): item
        for item in initial
        if isinstance(item, dict) and str(item.get("id") or "").strip()
    }
    if not parent_id or expected <= len(replies):
        return list(replies.values()), [], False

    errors: list[str] = []
    cursor: str | None = None
    seen_cursors: set[str] = set()
    pages = 0
    truncated = False
    while len(replies) < expected:
        if max_pages is not None and pages >= max_pages:
            errors.append(f"reply page limit reached for comment:{parent_id} ({max_pages})")
            truncated = True
            break
        response, _reply_method, failures = call_fallback_methods(
            resource,
            SUB_COMMENT_METHODS,
            {"note_id": note_id, "comment_id": parent_id, "last_cursor": cursor},
            retries=retries,
            sleep=sleep,
        )
        errors.extend(failures)
        data = getattr(response, "data", None)
        if not isinstance(data, dict):
            errors.append(f"reply endpoint returned non-object data for comment:{parent_id}")
            truncated = True
            break
        pages += 1
        raw = data.get("comments")
        if isinstance(raw, list):
            for item in raw:
                if isinstance(item, dict) and str(item.get("id") or "").strip():
                    replies[str(item["id"])] = item
        if progress is not None:
            progress(
                "xhs_reply_page",
                {
                    "parent_comment_id": parent_id,
                    "page": pages,
                    "reply_count": len(replies),
                    "reported_reply_count": expected,
                },
            )
        has_more = bool_from(data, "has_more", "hasMore")
        next_cursor = cursor_from(data)
        if not has_more:
            break
        if not next_cursor or next_cursor in seen_cursors:
            errors.append(f"reply pagination ended with a missing or repeated cursor for comment:{parent_id}")
            truncated = True
            break
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    if len(replies) < expected:
        truncated = True
    return list(replies.values()), errors, truncated


def normalize_http_url(url: str) -> str:
    """Prefer TLS for CDN assets while retaining the provider URL in metadata."""
    parsed = urlparse(url)
    if parsed.scheme == "http":
        parsed = parsed._replace(scheme="https")
    return urlunparse(parsed)


def fetch_remote_media(url: str, timeout_s: int, max_bytes: int) -> tuple[bytes, str | None]:
    request = Request(
        normalize_http_url(url),
        headers={"User-Agent": "Mozilla/5.0 (compatible; clue-data-collection/1.0)"},
    )
    try:
        with urlopen(request, timeout=timeout_s) as response:  # noqa: S310 - URL comes from provider data
            content_type = response.headers.get_content_type()
            if content_type and content_type != "application/octet-stream" and not content_type.startswith("image/"):
                raise XhsCaptureError(f"media endpoint returned non-image content type: {content_type}")
            chunks: list[bytes] = []
            size = 0
            while True:
                chunk = response.read(64 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise XhsCaptureError(f"media exceeds configured byte limit ({max_bytes})")
                chunks.append(chunk)
            if not chunks:
                raise XhsCaptureError("media endpoint returned an empty body")
            return b"".join(chunks), content_type
    except (HTTPError, URLError, TimeoutError, OSError) as error:
        raise XhsCaptureError(f"media download failed: {safe_error(error)}") from error


def extension_for(content_type: str | None, source_url: str) -> str:
    normalized = (content_type or "").split(";", 1)[0].strip().lower()
    mapping = {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/heif": ".heif",
        "image/heic": ".heic",
        "image/avif": ".avif",
    }
    if normalized in mapping:
        return mapping[normalized]
    suffix = Path(urlparse(source_url).path).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heif", ".heic", ".avif"}:
        return ".jpg" if suffix == ".jpeg" else suffix
    guessed = mimetypes.guess_extension(normalized)
    return guessed if guessed in mapping.values() else ".img"


def download_media(
    candidate: MediaCandidate,
    *,
    output_dir: Path,
    timeout_s: int,
    max_bytes: int,
    fetcher: Fetcher = fetch_remote_media,
) -> dict[str, Any]:
    """Download the first working provider URL and retain an auditable reference."""
    errors: list[str] = []
    for url in candidate.urls:
        try:
            body, content_type = fetcher(url, timeout_s, max_bytes)
        except Exception as error:
            errors.append(safe_error(error))
            continue
        extension = extension_for(content_type, url)
        relative = Path("media") / candidate.kind / f"{candidate.media_id}{extension}"
        destination = output_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(
            prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
        )
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(body)
            os.replace(temporary, destination)
        except BaseException:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise
        return {
            "media_id": candidate.media_id,
            "kind": candidate.kind,
            "owner_locator": candidate.owner_locator,
            "source_field": candidate.source_field,
            "status": "downloaded",
            "source_url": url,
            "local_path": relative.as_posix(),
            "mime_type": content_type,
            "bytes": len(body),
            "sha256": "sha256:" + hashlib.sha256(body).hexdigest(),
            "attempted_source_urls": list(candidate.urls),
        }
    return {
        "media_id": candidate.media_id,
        "kind": candidate.kind,
        "owner_locator": candidate.owner_locator,
        "source_field": candidate.source_field,
        "status": "failed",
        "attempted_source_urls": list(candidate.urls),
        "errors": errors[-5:],
    }


def attach_media_references(
    note: dict[str, Any],
    comments: list[dict[str, Any]],
    media: list[dict[str, Any]],
) -> None:
    by_owner: dict[str, list[str]] = {}
    for item in media:
        if item.get("status") == "downloaded":
            by_owner.setdefault(str(item.get("owner_locator")), []).append(str(item["media_id"]))
    note["attachments"] = by_owner.get(f"note:{note['id']}", [])
    for comment in comments:
        comment["attachments"] = by_owner.get(str(comment["source_locator"]), [])


def read_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise XhsCaptureError(f"{label} is not valid JSON: {path}") from error
    if not isinstance(value, dict):
        raise XhsCaptureError(f"{label} must be a JSON object: {path}")
    return value


def repair_incomplete_replies(
    *,
    output_dir: Path,
    client: Any,
    download_images: bool = True,
    timeout_s: int = DEFAULT_TIMEOUT_S,
    max_media_bytes: int = DEFAULT_MEDIA_MAX_BYTES,
    max_reply_pages: int | None = None,
    retries: int = 3,
    sleep: Callable[[float], None] = time.sleep,
    fetcher: Fetcher = fetch_remote_media,
    progress: Progress | None = None,
) -> dict[str, Any]:
    """Retry only reply threads whose stored count is below the provider count.

    This is deliberately an append-and-dedupe repair: it never repeats the
    36-page parent-comment scan or drops already archived evidence.
    """
    text_path = output_dir / "text.json"
    media_path = output_dir / "media-manifest.json"
    report_path = output_dir / "capture-report.json"
    text_document = read_json_object(text_path, "capture text")
    if text_document.get("schema_version") != TEXT_SCHEMA:
        raise XhsCaptureError(f"capture text must use {TEXT_SCHEMA}")
    source = text_document.get("source")
    if not isinstance(source, dict) or not isinstance(source.get("note_id"), str):
        raise XhsCaptureError("capture text has no source.note_id")
    note_id = source["note_id"]
    resource = getattr(client, "xiaohongshu", None)
    if resource is None:
        raise XhsCaptureError("locked SDK does not provide xiaohongshu resource")
    comments = [item for item in text_document.get("comments", []) if isinstance(item, dict)]
    existing_ids = {str(item.get("id")) for item in comments if str(item.get("id") or "")}
    reply_ids_by_parent: dict[str, set[str]] = {}
    for comment in comments:
        parent_id = comment.get("parent_id")
        if isinstance(parent_id, str) and parent_id:
            reply_ids_by_parent.setdefault(parent_id, set()).add(str(comment.get("id") or ""))
    repair_errors: list[str] = []
    repair_truncated = False
    new_candidates: list[MediaCandidate] = []
    repaired_parent_count = 0
    for parent in [item for item in comments if item.get("depth") == 0]:
        parent_id = str(parent.get("id") or "").strip()
        expected = int_from(parent, "reply_count_reported") or 0
        present = reply_ids_by_parent.get(parent_id, set())
        if not parent_id or len(present) >= expected:
            continue
        repaired_parent_count += 1
        if progress is not None:
            progress(
                "xhs_reply_repair_start",
                {
                    "parent_comment_id": parent_id,
                    "captured_reply_count": len(present),
                    "reported_reply_count": expected,
                },
            )
        try:
            raw_replies, errors, truncated = collect_replies(
                resource=resource,
                note_id=note_id,
                parent={"id": parent_id, "sub_comment_count": expected},
                # Existing normalized replies only need their IDs here.  They
                # count toward the provider-reported total while new API pages
                # supply full raw cards for any missing replies.
                initial=[{"id": reply_id} for reply_id in present],
                retries=retries,
                max_pages=max_reply_pages,
                sleep=sleep,
                progress=progress,
            )
        except XhsCaptureError as error:
            repair_errors.append(f"comment:{parent_id} reply repair failed: {safe_error(error)}")
            repair_truncated = True
            continue
        repair_errors.extend(errors)
        repair_truncated = repair_truncated or truncated
        for raw_reply in raw_replies:
            normalized = normalize_comment(raw_reply, parent_id=parent_id, depth=1)
            if normalized is None or normalized["id"] in existing_ids:
                continue
            comments.append(normalized)
            existing_ids.add(normalized["id"])
            reply_ids_by_parent.setdefault(parent_id, set()).add(normalized["id"])
            new_candidates.extend(comment_media_candidates(raw_reply, normalized["id"]))

    media_document = read_json_object(media_path, "media manifest") if media_path.is_file() else {}
    media = media_document.get("items") if isinstance(media_document.get("items"), list) else []
    media = [item for item in media if isinstance(item, dict)]
    known_media_ids = {str(item.get("media_id")) for item in media if item.get("media_id")}
    for candidate in new_candidates:
        if candidate.media_id in known_media_ids:
            continue
        if download_images:
            item = download_media(
                candidate,
                output_dir=output_dir,
                timeout_s=timeout_s,
                max_bytes=max_media_bytes,
                fetcher=fetcher,
            )
        else:
            item = {
                "media_id": candidate.media_id,
                "kind": candidate.kind,
                "owner_locator": candidate.owner_locator,
                "source_field": candidate.source_field,
                "status": "not_downloaded",
                "attempted_source_urls": list(candidate.urls),
            }
        media.append(item)
        known_media_ids.add(candidate.media_id)
        if progress is not None:
            progress(
                "xhs_media_download",
                {"media_id": candidate.media_id, "kind": candidate.kind, "status": item.get("status")},
            )

    note = text_document.get("note") if isinstance(text_document.get("note"), dict) else {}
    attach_media_references(note, comments, media)
    text_document["note"] = note
    text_document["comments"] = comments
    coverage = text_document.get("coverage") if isinstance(text_document.get("coverage"), dict) else {}
    expected_total = int_from(coverage, "reported_total_comments")
    expected_first = int_from(coverage, "reported_first_level_comments")
    total_count = len(comments)
    first_level_count = sum(1 for item in comments if item.get("depth") == 0)
    reply_count_complete = all(
        len(reply_ids_by_parent.get(str(parent.get("id") or ""), set()))
        >= (int_from(parent, "reply_count_reported") or 0)
        for parent in comments
        if parent.get("depth") == 0
    )
    gaps: list[str] = []
    if repair_truncated or not reply_count_complete:
        gaps.append("Comment reply pagination did not reach a confirmed terminal cursor.")
    if isinstance(expected_first, int) and first_level_count < expected_first:
        gaps.append(f"Provider reports {expected_first} first-level comments; captured {first_level_count}.")
    if isinstance(expected_total, int) and total_count < expected_total:
        gaps.append(f"Provider reports {expected_total} total comments; captured {total_count}.")
    failed_media = [item for item in media if item.get("status") == "failed"]
    if failed_media:
        gaps.append(f"{len(failed_media)} media attachment(s) could not be downloaded.")
    if not any(item.get("kind") == "comment_image" for item in media):
        gaps.append("The provider response exposed no comment-image attachment fields.")
    coverage.update(
        {
            "captured_total_comments": total_count,
            "captured_first_level_comments": first_level_count,
            "missing_comment_estimate": max(0, expected_total - total_count)
            if isinstance(expected_total, int)
            else None,
            "comment_capture_complete": (
                not repair_truncated
                and reply_count_complete
                and not (
                    isinstance(expected_first, int) and first_level_count < expected_first
                )
                and not (
                    isinstance(expected_total, int) and total_count < expected_total
                )
            ),
            "media_candidates": len(media),
            "downloaded_media": sum(item.get("status") == "downloaded" for item in media),
            "downloaded_comment_images": sum(
                item.get("status") == "downloaded" and item.get("kind") == "comment_image"
                for item in media
            ),
            "reply_repair_parent_count": repaired_parent_count,
        }
    )
    text_document["coverage"] = coverage
    text_document["information_gaps"] = gaps
    history = text_document.get("capture_errors")
    text_document["capture_errors"] = [
        *[item for item in history if isinstance(item, str)],
        *repair_errors,
    ]
    media_document = {
        "schema_version": MEDIA_SCHEMA,
        "captured_at": text_document.get("captured_at") or utc_now(),
        "source_note_id": note_id,
        "items": media,
    }
    report = {
        "schema_version": CAPTURE_SCHEMA,
        "status": "partial" if gaps else "succeeded",
        "text_output": "text.json",
        "media_manifest": "media-manifest.json",
        "note_id": note_id,
        "coverage": coverage,
        "information_gaps": gaps,
        "capture_error_count": len(text_document["capture_errors"]),
        "repair": {"repaired_parent_count": repaired_parent_count},
    }
    atomic_write_json(text_path, text_document)
    atomic_write_json(media_path, media_document)
    atomic_write_json(report_path, report)
    return {
        "text": text_document,
        "media": media_document,
        "report": report,
        "paths": {"text": text_path, "media": media_path, "report": report_path},
    }


def capture_post(
    *,
    shared_url: str,
    output_dir: Path,
    client: Any,
    download_images: bool = True,
    timeout_s: int = DEFAULT_TIMEOUT_S,
    max_media_bytes: int = DEFAULT_MEDIA_MAX_BYTES,
    max_comment_pages: int | None = None,
    max_reply_pages: int | None = None,
    retries: int = 3,
    sleep: Callable[[float], None] = time.sleep,
    fetcher: Fetcher = fetch_remote_media,
    progress: Progress | None = None,
) -> dict[str, Any]:
    """Capture one public XHS note into text JSON and a media manifest.

    ``client`` and ``fetcher`` are injected for deterministic unit tests.  No
    raw SDK response is returned or written by this function.
    """
    if not shared_url.strip():
        raise XhsCaptureError("a non-empty Xiaohongshu shared URL is required")
    resource = getattr(client, "xiaohongshu", None)
    if resource is None:
        raise XhsCaptureError("locked SDK does not provide xiaohongshu resource")
    output_dir.mkdir(parents=True, exist_ok=True)
    note_id, resolved_url, resolver_method, resolver_errors = resolve_note(
        client, shared_url.strip(), retries=retries, sleep=sleep
    )
    detail_response, detail_method, detail_errors = call_fallback_methods(
        resource,
        DETAIL_METHODS,
        {"note_id": note_id},
        retries=retries,
        sleep=sleep,
    )
    raw_note = find_note_payload(getattr(detail_response, "data", None), note_id)
    note = normalize_note(raw_note, note_id)

    comment_probe, comment_method, comment_errors = call_fallback_methods(
        resource,
        COMMENT_METHODS,
        {"note_id": note_id, "last_cursor": None, "sort": "latest"},
        retries=retries,
        sleep=sleep,
    )
    # The probe is deliberately retained as page one rather than spending a
    # duplicate paid request.  The remaining pagination starts from its cursor.
    first_data = getattr(comment_probe, "data", None)
    if not isinstance(first_data, dict):
        raise XhsCaptureError("comment endpoint returned non-object data")
    first_page = first_data.get("comments")
    top_level_raw = [item for item in first_page if isinstance(item, dict)] if isinstance(first_page, list) else []
    comment_metadata = {
        "reported_total": int_from(first_data, "comment_count"),
        "reported_first_level": int_from(first_data, "comment_count_l1"),
        "sort": first_data.get("current_sort_strategy"),
        "pages_fetched": 1,
    }
    pagination_errors: list[str] = []
    comment_truncated = False
    if progress is not None:
        progress(
            "xhs_comment_page",
            {
                "page": 1,
                "comments_in_page": len(top_level_raw),
                "reported_total": comment_metadata["reported_total"],
                "reported_first_level": comment_metadata["reported_first_level"],
            },
        )
    first_next = cursor_from(first_data)
    first_has_more = bool_from(first_data, "has_more", "hasMore")
    if first_has_more:
        # ``collect_paginated_comments`` starts at page one.  Inline continuation
        # keeps cursor behavior explicit and avoids duplicate initial requests.
        cursor = first_next
        seen_cursors = {cursor} if cursor else set()
        while True:
            if max_comment_pages is not None and comment_metadata["pages_fetched"] >= max_comment_pages:
                comment_truncated = True
                pagination_errors.append(
                    f"top-level comment page limit reached ({max_comment_pages})"
                )
                break
            if not cursor or cursor in seen_cursors - {cursor}:
                comment_truncated = True
                pagination_errors.append(
                    "top-level comment pagination ended with a missing or repeated cursor"
                )
                break
            response, failures = call_method(
                resource,
                comment_method,
                {"note_id": note_id, "last_cursor": cursor, "sort": "latest"},
                retries=retries,
                sleep=sleep,
            )
            comment_errors.extend(failures)
            if response is None:
                comment_truncated = True
                break
            data = getattr(response, "data", None)
            if not isinstance(data, dict):
                comment_truncated = True
                pagination_errors.append("comment pagination returned non-object data")
                break
            raw = data.get("comments")
            if isinstance(raw, list):
                top_level_raw.extend(item for item in raw if isinstance(item, dict))
            comment_metadata["pages_fetched"] += 1
            if progress is not None:
                progress(
                    "xhs_comment_page",
                    {
                        "page": comment_metadata["pages_fetched"],
                        "comments_in_page": len(raw) if isinstance(raw, list) else 0,
                        "captured_first_level_before_dedupe": len(top_level_raw),
                    },
                )
            if not bool_from(data, "has_more", "hasMore"):
                break
            next_cursor = cursor_from(data)
            if not next_cursor or next_cursor in seen_cursors:
                comment_truncated = True
                pagination_errors.append(
                    "top-level comment pagination ended with a missing or repeated cursor"
                )
                break
            seen_cursors.add(next_cursor)
            cursor = next_cursor

    # Preserve first-seen order and merge duplicate parent cards from unstable
    # provider pages.
    parent_raw: dict[str, dict[str, Any]] = {}
    parent_order: list[str] = []
    for item in top_level_raw:
        comment_id = str(item.get("id") or "").strip()
        if comment_id and comment_id not in parent_raw:
            parent_raw[comment_id] = item
            parent_order.append(comment_id)

    comments: list[dict[str, Any]] = []
    all_media_candidates = note_media_candidates(raw_note, note_id)
    reply_errors: list[str] = []
    reply_truncated = False
    for parent_id in parent_order:
        raw_parent = parent_raw[parent_id]
        parent = normalize_comment(raw_parent, parent_id=None, depth=0)
        if parent is None:
            continue
        comments.append(parent)
        all_media_candidates.extend(comment_media_candidates(raw_parent, parent_id))
        inline = raw_parent.get("sub_comments")
        inline_replies = [item for item in inline if isinstance(item, dict)] if isinstance(inline, list) else []
        try:
            replies, errors, truncated = collect_replies(
                resource=resource,
                note_id=note_id,
                parent=raw_parent,
                initial=inline_replies,
                retries=retries,
                max_pages=max_reply_pages,
                sleep=sleep,
                progress=progress,
            )
        except XhsCaptureError as error:
            # One inaccessible thread must not discard all already-collected
            # public comments.  Retain inline replies and mark coverage partial.
            replies = inline_replies
            errors = [f"comment:{parent_id} reply capture failed: {safe_error(error)}"]
            truncated = True
        reply_errors.extend(errors)
        reply_truncated = reply_truncated or truncated
        seen_reply_ids: set[str] = set()
        for raw_reply in replies:
            reply = normalize_comment(raw_reply, parent_id=parent_id, depth=1)
            if reply is None or reply["id"] in seen_reply_ids:
                continue
            seen_reply_ids.add(reply["id"])
            comments.append(reply)
            all_media_candidates.extend(comment_media_candidates(raw_reply, reply["id"]))

    # A provider may repeat media fields under aliases.  One media id should map
    # to one downloaded object while still retaining its owner reference.
    unique_candidates: dict[str, MediaCandidate] = {}
    for candidate in all_media_candidates:
        unique_candidates.setdefault(candidate.media_id, candidate)
    media: list[dict[str, Any]] = []
    if download_images:
        for candidate in unique_candidates.values():
            item = download_media(
                candidate,
                output_dir=output_dir,
                timeout_s=timeout_s,
                max_bytes=max_media_bytes,
                fetcher=fetcher,
            )
            media.append(item)
            if progress is not None:
                progress(
                    "xhs_media_download",
                    {
                        "media_id": candidate.media_id,
                        "kind": candidate.kind,
                        "status": item.get("status"),
                    },
                )
    else:
        media = [
            {
                "media_id": candidate.media_id,
                "kind": candidate.kind,
                "owner_locator": candidate.owner_locator,
                "source_field": candidate.source_field,
                "status": "not_downloaded",
                "attempted_source_urls": list(candidate.urls),
            }
            for candidate in unique_candidates.values()
        ]
    attach_media_references(note, comments, media)

    expected_total = comment_metadata.get("reported_total")
    expected_first = comment_metadata.get("reported_first_level")
    first_level_count = sum(1 for comment in comments if comment["depth"] == 0)
    total_count = len(comments)
    missing_estimate = (
        max(0, expected_total - total_count) if isinstance(expected_total, int) else None
    )
    gaps: list[str] = []
    all_errors = resolver_errors + detail_errors + comment_errors + pagination_errors + reply_errors
    if comment_truncated or reply_truncated:
        gaps.append("Comment pagination did not reach a confirmed terminal cursor.")
    if isinstance(expected_first, int) and first_level_count < expected_first:
        gaps.append(
            f"Provider reports {expected_first} first-level comments; captured {first_level_count}."
        )
    if isinstance(expected_total, int) and total_count < expected_total:
        gaps.append(f"Provider reports {expected_total} total comments; captured {total_count}.")
    failed_media = [item for item in media if item.get("status") == "failed"]
    if failed_media:
        gaps.append(f"{len(failed_media)} media attachment(s) could not be downloaded.")
    if not any(item.get("kind") == "comment_image" for item in media):
        gaps.append("The provider response exposed no comment-image attachment fields.")

    captured_at = utc_now()
    comment_coverage_complete = (
        not comment_truncated
        and not reply_truncated
        and not (
            isinstance(expected_first, int) and first_level_count < expected_first
        )
        and not (isinstance(expected_total, int) and total_count < expected_total)
    )
    text_document = {
        "schema_version": TEXT_SCHEMA,
        "captured_at": captured_at,
        "source": {
            "platform": "xiaohongshu",
            "shared_url": shared_url.strip(),
            "resolved_url": resolved_url,
            "canonical_url": canonical_note_url(note_id),
            "note_id": note_id,
            "api_routes": {
                "share_resolution": resolver_method,
                "note_detail": detail_method,
                "comments": comment_method,
                "replies": "get_note_sub_comment_v2",
            },
        },
        "note": note,
        "comments": comments,
        "media_manifest": "media-manifest.json",
        "coverage": {
            "reported_total_comments": expected_total,
            "reported_first_level_comments": expected_first,
            "captured_total_comments": total_count,
            "captured_first_level_comments": first_level_count,
            "missing_comment_estimate": missing_estimate,
            "top_level_pages_fetched": comment_metadata["pages_fetched"],
            "comment_capture_complete": comment_coverage_complete,
            "media_candidates": len(media),
            "downloaded_media": sum(item.get("status") == "downloaded" for item in media),
            "downloaded_comment_images": sum(
                item.get("status") == "downloaded" and item.get("kind") == "comment_image"
                for item in media
            ),
        },
        "information_gaps": gaps,
        "capture_errors": all_errors,
        "data_minimization": {
            "raw_provider_payloads_written": False,
            "profile_ids_written": False,
            "avatar_urls_written": False,
            "ip_locations_written": False,
        },
    }
    media_document = {
        "schema_version": MEDIA_SCHEMA,
        "captured_at": captured_at,
        "source_note_id": note_id,
        "items": media,
    }
    report = {
        "schema_version": CAPTURE_SCHEMA,
        "status": "partial" if gaps else "succeeded",
        "text_output": "text.json",
        "media_manifest": "media-manifest.json",
        "note_id": note_id,
        "coverage": text_document["coverage"],
        "information_gaps": gaps,
        "capture_error_count": len(all_errors),
    }
    atomic_write_json(output_dir / "text.json", text_document)
    atomic_write_json(output_dir / "media-manifest.json", media_document)
    atomic_write_json(output_dir / "capture-report.json", report)
    return {
        "text": text_document,
        "media": media_document,
        "report": report,
        "paths": {
            "text": output_dir / "text.json",
            "media": output_dir / "media-manifest.json",
            "report": output_dir / "capture-report.json",
        },
    }


def positive_or_none(value: int | None, label: str) -> int | None:
    if value is None:
        return None
    if value < 1:
        raise argparse.ArgumentTypeError(f"{label} must be at least 1")
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="capture-xhs-post",
        description="Capture one public Xiaohongshu post, comments, and referenced images.",
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--url", help="Xiaohongshu shared or canonical note URL.")
    source.add_argument(
        "--repair-output-dir",
        help="Existing capture directory; retry only incomplete reply threads.",
    )
    parser.add_argument("--output-dir", help="Directory for a new text.json and media capture.")
    parser.add_argument("--token-file", help="Optional token file; use - to read one token from stdin.")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_S, help="HTTP timeout in seconds.")
    parser.add_argument("--retries", type=int, default=3, help="Attempts per provider call.")
    parser.add_argument(
        "--max-comment-pages",
        type=int,
        help="Optional top-level page cap; omit for every reachable page.",
    )
    parser.add_argument(
        "--max-reply-pages",
        type=int,
        help="Optional per-thread page cap; omit for every reachable page.",
    )
    parser.add_argument(
        "--max-media-bytes",
        type=int,
        default=DEFAULT_MEDIA_MAX_BYTES,
        help="Maximum size per downloaded image.",
    )
    parser.add_argument(
        "--no-download-images",
        action="store_true",
        help="Keep image URL references but do not download binary assets.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Allow writing into a directory that already contains capture outputs.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.timeout < 1 or args.retries < 1 or args.max_media_bytes < 1:
            raise XhsCaptureError("--timeout, --retries, and --max-media-bytes must be positive")
        max_comment_pages = positive_or_none(args.max_comment_pages, "--max-comment-pages")
        max_reply_pages = positive_or_none(args.max_reply_pages, "--max-reply-pages")
        if args.repair_output_dir:
            output_dir = Path(args.repair_output_dir).expanduser().resolve()
            if not (output_dir / "text.json").is_file():
                raise XhsCaptureError("--repair-output-dir must contain text.json")
        else:
            if not args.output_dir:
                raise XhsCaptureError("--output-dir is required with --url")
            output_dir = Path(args.output_dir).expanduser().resolve()
            existing = [
                output_dir / name
                for name in ("text.json", "media-manifest.json", "capture-report.json")
            ]
            if not args.force and any(path.exists() for path in existing):
                raise XhsCaptureError(
                    "output directory already contains a capture; use a fresh directory or --force"
                )
        token = read_token(args.token_file)
        client_type = import_sdk_client()

        def progress(event: str, fields: dict[str, Any]) -> None:
            print(
                json.dumps(
                    {"event": event, **fields}, ensure_ascii=False, sort_keys=True
                ),
                file=sys.stderr,
                flush=True,
            )

        with client_type(token=token, timeout=args.timeout) as client:
            if args.repair_output_dir:
                result = repair_incomplete_replies(
                    output_dir=output_dir,
                    client=client,
                    download_images=not args.no_download_images,
                    timeout_s=args.timeout,
                    max_media_bytes=args.max_media_bytes,
                    max_reply_pages=max_reply_pages,
                    retries=args.retries,
                    progress=progress,
                )
            else:
                result = capture_post(
                    shared_url=args.url,
                    output_dir=output_dir,
                    client=client,
                    download_images=not args.no_download_images,
                    timeout_s=args.timeout,
                    max_media_bytes=args.max_media_bytes,
                    max_comment_pages=max_comment_pages,
                    max_reply_pages=max_reply_pages,
                    retries=args.retries,
                    progress=progress,
                )
        print(
            json.dumps(
                {
                    "status": result["report"]["status"],
                    "text_output": str(result["paths"]["text"]),
                    "media_manifest": str(result["paths"]["media"]),
                    "report": str(result["paths"]["report"]),
                    "coverage": result["report"]["coverage"],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    except XhsCaptureError as error:
        print(f"error: {safe_error(error)}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
