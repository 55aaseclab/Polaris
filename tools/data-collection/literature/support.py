"""Shared helpers for the literature package (no import of runner)."""

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
PHASE_EXPANSION = "expansion"  # sub-step after phase 1; not a top-level phase_id


class LiteratureError(RuntimeError):
    """User-actionable literature pipeline failure."""


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def log(message: str, **fields: Any) -> None:
    payload: dict[str, Any] = {
        "ts": utc_now(),
        "level": "info",
        "msg": message,
        "component": "literature",
    }
    payload.update(fields)
    print(json.dumps(payload, ensure_ascii=False), file=sys.stderr, flush=True)


def read_json(path: str, label: str) -> dict[str, Any]:
    target = Path(path).expanduser().resolve()
    if not target.is_file():
        raise LiteratureError(f"{label} does not exist: {target}")
    try:
        value = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise LiteratureError(f"{label} is not valid JSON: {target}") from error
    if not isinstance(value, dict):
        raise LiteratureError(f"{label} must be a JSON object")
    return value


def required_list(value: dict[str, Any], key: str, label: str) -> list[Any]:
    result = value.get(key)
    if not isinstance(result, list):
        raise LiteratureError(f"{label} requires {key} array")
    return result
