"""Shared PDF cache for literature capture across workspaces.

Default root:
  $LITERATURE_PDF_CACHE
  or $POLARIS_LITERATURE_PDF_CACHE
  or $POLARIS_LITERATURE_CACHE_ROOT/literature-pdfs

Layout:
  <root>/
    by-doi/<prefix>/<rest>.pdf      # preferred key from DOI
    by-id/<safe-record-id>.pdf      # fallback when no DOI
    manifest.jsonl                  # append-only audit lines
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def resolve_shared_cache_root() -> Path:
    value = (os.environ.get("POLARIS_LITERATURE_CACHE_ROOT") or "").strip()
    if not value:
        raise RuntimeError(
            "POLARIS_LITERATURE_CACHE_ROOT is required for shared literature PDF cache"
        )
    return Path(value).expanduser().resolve()


def resolve_pdf_cache_root() -> Path:
    """Resolve the literature PDF cache directory."""
    for key in ("LITERATURE_PDF_CACHE", "POLARIS_LITERATURE_PDF_CACHE"):
        value = (os.environ.get(key) or "").strip()
        if value:
            return Path(value).expanduser().resolve()
    return (resolve_shared_cache_root() / "literature-pdfs").resolve()


def is_pdf_file(path: Path) -> bool:
    try:
        if not path.is_file() or path.stat().st_size < 64:
            return False
        return path.read_bytes()[:5] == b"%PDF-"
    except OSError:
        return False


def normalize_doi(value: str) -> str:
    doi = value.strip()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi.org/", "doi:"):
        if doi.lower().startswith(prefix):
            doi = doi[len(prefix) :]
            break
    return doi.strip().strip("/").lower()


def safe_filename(value: str, *, max_len: int = 160) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip())
    text = re.sub(r"_+", "_", text).strip("._")
    if not text:
        text = "unknown"
    return text[:max_len]


def record_doi(record: dict[str, Any]) -> str | None:
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    for key in ("DOI", "doi"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return normalize_doi(value)
    record_id = record.get("record_id")
    if isinstance(record_id, str) and record_id.lower().startswith("doi:"):
        return normalize_doi(record_id)
    return None


def record_cache_keys(record: dict[str, Any]) -> list[tuple[str, str]]:
    """Return ordered (kind, key) pairs for cache lookup/store."""
    keys: list[tuple[str, str]] = []
    doi = record_doi(record)
    if doi:
        keys.append(("doi", doi))
    record_id = record.get("record_id")
    if isinstance(record_id, str) and record_id.strip():
        keys.append(("id", record_id.strip()))
    return keys


def _path_for_key(root: Path, kind: str, key: str) -> Path:
    if kind == "doi":
        # Nest by first path segment of DOI prefix for smaller directories.
        # 10.1145/3808103 → by-doi/10.1145/3808103.pdf
        parts = key.split("/", 1)
        if len(parts) == 2:
            return root / "by-doi" / safe_filename(parts[0], max_len=40) / f"{safe_filename(parts[1])}.pdf"
        return root / "by-doi" / f"{safe_filename(key)}.pdf"
    return root / "by-id" / f"{safe_filename(key)}.pdf"


def ensure_cache_dirs(root: Path | None = None) -> Path:
    base = root or resolve_pdf_cache_root()
    (base / "by-doi").mkdir(parents=True, exist_ok=True)
    (base / "by-id").mkdir(parents=True, exist_ok=True)
    return base


def lookup_cached_pdf(
    record: dict[str, Any],
    *,
    root: Path | None = None,
) -> Path | None:
    """Return path to a valid cached PDF for *record*, or None."""
    base = ensure_cache_dirs(root)
    for kind, key in record_cache_keys(record):
        path = _path_for_key(base, kind, key)
        if is_pdf_file(path):
            return path
    return None


def _append_manifest(root: Path, entry: dict[str, Any]) -> None:
    path = root / "manifest.jsonl"
    line = json.dumps(entry, ensure_ascii=False)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def store_pdf(
    record: dict[str, Any],
    source_pdf: Path,
    *,
    root: Path | None = None,
    source_url: str | None = None,
) -> Path | None:
    """Copy *source_pdf* into the global cache under all known keys. Return primary path."""
    if not is_pdf_file(source_pdf):
        return None
    base = ensure_cache_dirs(root)
    keys = record_cache_keys(record)
    if not keys:
        return None

    # Atomic write to first key, then hardlink/copy to aliases.
    primary_kind, primary_key = keys[0]
    primary = _path_for_key(base, primary_kind, primary_key)
    primary.parent.mkdir(parents=True, exist_ok=True)
    if not is_pdf_file(primary):
        fd, tmp_name = tempfile.mkstemp(prefix=".pdf-cache-", suffix=".pdf", dir=str(primary.parent))
        os.close(fd)
        tmp_path = Path(tmp_name)
        try:
            shutil.copy2(source_pdf, tmp_path)
            tmp_path.replace(primary)
        finally:
            if tmp_path.exists():
                tmp_path.unlink(missing_ok=True)

    for kind, key in keys[1:]:
        alias = _path_for_key(base, kind, key)
        if is_pdf_file(alias):
            continue
        alias.parent.mkdir(parents=True, exist_ok=True)
        try:
            if alias.exists():
                alias.unlink()
            os.link(primary, alias)
        except OSError:
            shutil.copy2(primary, alias)

    try:
        sha = _file_sha256(primary)
        size = primary.stat().st_size
    except OSError:
        sha = None
        size = None
    _append_manifest(
        base,
        {
            "ts": utc_now(),
            "action": "store",
            "record_id": record.get("record_id"),
            "doi": record_doi(record),
            "path": str(primary),
            "bytes": size,
            "sha256": sha,
            "source_url": source_url,
            "keys": [{"kind": k, "key": v} for k, v in keys],
        },
    )
    return primary


def materialize_cached_pdf(
    record: dict[str, Any],
    dest: Path,
    *,
    root: Path | None = None,
) -> Path | None:
    """If cache hit, copy into *dest* and return dest; else None."""
    cached = lookup_cached_pdf(record, root=root)
    if cached is None:
        return None
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.resolve() != cached.resolve():
        shutil.copy2(cached, dest)
    if not is_pdf_file(dest):
        return None
    return dest
