"""Phase 1.5 — expansion: optional corpus growth after seed discovery.

Not implemented yet for ad-content-intel (no citation-style expand).
Reserved for: 对标账号时间线、话题/相关笔记扩库. See README.md.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ad_content.support import log


def expansion_enabled(input_value: dict[str, Any]) -> bool:
    """True when payload.ad_content_expansion.enabled is explicitly true."""
    payload = input_value.get("payload")
    if not isinstance(payload, dict):
        return False
    cfg = payload.get("ad_content_expansion")
    if not isinstance(cfg, dict):
        return False
    return cfg.get("enabled") is True


def run_expansion(
    *,
    input_value: dict[str, Any],
    collected: dict[str, Any],
    collection_base: Path,
    run_prefix: str,
    expand_dir: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Grow ad-content corpus after phase 1; currently a documented no-op.

    Returns (collection, phase_record) with phase name ``expansion``.
    """
    if not expansion_enabled(input_value):
        phase = {
            "phase_id": 1,
            "phase": "expansion",
            "status": "skipped",
            "reason": (
                "ad-content expansion not enabled "
                "(set payload.ad_content_expansion.enabled=true when implemented)"
            ),
            "record_count": len(collected.get("records") or []),
        }
        log(
            "expand_phase_skipped",
            phase="expansion",
            reason=phase["reason"],
            record_count=phase["record_count"],
        )
        return collected, phase

    # Placeholder for future account/topic expansion (mirrors literature expand).
    expand_dir.mkdir(parents=True, exist_ok=True)
    phase = {
        "phase_id": 1,
        "phase": "expansion",
        "status": "skipped",
        "reason": (
            "ad_content_expansion.enabled is true but expand engines are not "
            "wired yet (account timeline / related notes)"
        ),
        "record_count": len(collected.get("records") or []),
        "output": str(expand_dir),
        "run_prefix": run_prefix,
        "collection_base": str(collection_base),
    }
    log("expand_phase_not_implemented", **phase)
    return collected, phase
