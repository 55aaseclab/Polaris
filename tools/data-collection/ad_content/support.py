"""Shared helpers for the ad-content-intel package (no import of runner)."""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

OUTPUT_V2 = "clue.data-collection.output.v2"
PHASE_COLLECTION = 1
PHASE_AUGMENTATION = 2
PHASE_MANUAL_REVIEW = 3
# Sub-step after phase 1; not a top-level phase_id in PIPELINE_PHASES.
PHASE_EXPANSION = "expansion"

SOURCE_TYPES = frozenset({"social_media", "web-search", "curated-web-search"})


class AdContentError(RuntimeError):
    """User-actionable ad-content-intel pipeline failure."""


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def log(message: str, **fields: Any) -> None:
    payload: dict[str, Any] = {
        "ts": utc_now(),
        "level": "info",
        "msg": message,
        "component": "ad_content",
    }
    payload.update(fields)
    print(json.dumps(payload, ensure_ascii=False), file=sys.stderr, flush=True)


def read_json(path: str, label: str) -> dict[str, Any]:
    target = Path(path).expanduser().resolve()
    if not target.is_file():
        raise AdContentError(f"{label} does not exist: {target}")
    try:
        value = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AdContentError(f"{label} is not valid JSON: {target}") from error
    if not isinstance(value, dict):
        raise AdContentError(f"{label} must be a JSON object")
    return value


def required_list(value: dict[str, Any], key: str, label: str) -> list[Any]:
    result = value.get(key)
    if not isinstance(result, list):
        raise AdContentError(f"{label} requires {key} array")
    return result


def tools_root() -> Path:
    # ad_content/ → data-collection/ → tools/
    return Path(__file__).resolve().parents[2]
