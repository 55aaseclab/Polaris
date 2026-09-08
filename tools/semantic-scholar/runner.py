#!/usr/bin/env python3
"""Bounded Semantic Scholar graph client (paper, citations, references, search).

Follows Semantic Scholar API tutorial patterns:
  https://www.semanticscholar.org/product/api/tutorial
  - Header: x-api-key (optional but recommended)
  - Authenticated tier: 1 request/second cumulative across all endpoints
  - Prefer batch/bulk endpoints; request only needed fields
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


TOOL_NAME = "clue-semantic-scholar-cli"
BASE = "https://api.semanticscholar.org/graph/v1"
DEFAULT_FIELDS = (
    "paperId,title,year,abstract,citationCount,referenceCount,"
    "influentialCitationCount,authors,venue,publicationDate,externalIds,url,"
    "isOpenAccess,openAccessPdf"
)
# Nested papers on citations/references must include abstract for topic match.
CITE_FIELDS = (
    "title,year,abstract,authors,externalIds,citationCount,venue,url,"
    "publicationDate,isOpenAccess,openAccessPdf"
)

# Tutorial: key holders get 1 rps across all endpoints.
MIN_REQUEST_INTERVAL_S = 1.0
_last_request_mono: float = 0.0

# Disk cache for successful responses (survives restarts; skips rate limit on hit).
# Override with SEMANTIC_SCHOLAR_CACHE or S2_CACHE_DIR.
_CACHE_ROOT: Path | None = None
_MEM_CACHE: dict[str, Any] = {}


class CliError(Exception):
    """User-facing command error."""


def read_version(root: Path) -> str:
    return (root / "VERSION").read_text(encoding="utf-8").strip()


def cache_root() -> Path:
    """Shared cache: POLARIS_LITERATURE_CACHE_ROOT/semantic-scholar/ unless overridden."""
    global _CACHE_ROOT
    if _CACHE_ROOT is not None:
        return _CACHE_ROOT
    env = (os.environ.get("SEMANTIC_SCHOLAR_CACHE") or os.environ.get("S2_CACHE_DIR") or "").strip()
    if env:
        path = Path(env).expanduser().resolve()
    else:
        shared = (os.environ.get("POLARIS_LITERATURE_CACHE_ROOT") or "").strip()
        if not shared:
            raise RuntimeError("POLARIS_LITERATURE_CACHE_ROOT is required for semantic-scholar cache")
        path = Path(shared).expanduser().resolve() / "semantic-scholar"
    path.mkdir(parents=True, exist_ok=True)
    _CACHE_ROOT = path
    return path


def cache_enabled() -> bool:
    """Set SEMANTIC_SCHOLAR_CACHE=0 to disable."""
    flag = (os.environ.get("SEMANTIC_SCHOLAR_CACHE") or "").strip().lower()
    if flag in {"0", "false", "off", "no"}:
        return False
    return True


def _cache_key(method: str, url: str, body: dict[str, Any] | None) -> str:
    blob = method.upper() + "\n" + url + "\n"
    if body is not None:
        blob += json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# Process-wide counters for re-run diagnostics (disk + mem hits counted).
_CACHE_STATS: dict[str, int] = {"hits": 0, "misses": 0, "puts": 0}


def cache_stats() -> dict[str, int]:
    return dict(_CACHE_STATS)


def reset_cache_stats() -> None:
    _CACHE_STATS["hits"] = 0
    _CACHE_STATS["misses"] = 0
    _CACHE_STATS["puts"] = 0


def cache_get(method: str, url: str, body: dict[str, Any] | None) -> Any | None:
    if not cache_enabled():
        return None
    key = _cache_key(method, url, body)
    if key in _MEM_CACHE:
        _CACHE_STATS["hits"] += 1
        return _MEM_CACHE[key]
    path = cache_root() / f"{key[:2]}" / f"{key}.json"
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        _MEM_CACHE[key] = payload
        _CACHE_STATS["hits"] += 1
        return payload
    except (OSError, json.JSONDecodeError):
        return None


def cache_put(method: str, url: str, body: dict[str, Any] | None, payload: Any) -> None:
    if not cache_enabled():
        return
    key = _cache_key(method, url, body)
    _MEM_CACHE[key] = payload
    _CACHE_STATS["puts"] += 1
    path = cache_root() / f"{key[:2]}" / f"{key}.json"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8")
        tmp.replace(path)
    except OSError:
        pass


def api_key() -> str:
    """Env names used by tutorial / s2-folks examples and our monorepo."""
    return (
        os.environ.get("POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY")
        or os.environ.get("SEMANTIC_SCHOLAR_API_KEY")
        or ""
    ).strip()


def api_headers() -> dict[str, str]:
    # Tutorial: headers = {"x-api-key": api_key}
    headers = {
        "User-Agent": f"{TOOL_NAME}/0.1 (literature research)",
        "Accept": "application/json",
    }
    key = api_key()
    if key:
        headers["x-api-key"] = key
    return headers


def _wait_for_rate_slot() -> None:
    """Global 1 rps: wait until ≥1s since the previous request was sent."""
    global _last_request_mono
    now = time.monotonic()
    if _last_request_mono > 0:
        elapsed = now - _last_request_mono
        if elapsed < MIN_REQUEST_INTERVAL_S:
            time.sleep(MIN_REQUEST_INTERVAL_S - elapsed)
    _last_request_mono = time.monotonic()


def http_json(
    method: str,
    url: str,
    *,
    body: dict[str, Any] | None = None,
    retries: int = 3,
    use_cache: bool = True,
) -> Any:
    """GET/POST JSON with disk cache + shared 1 rps pacing.

    Successful responses are cached under POLARIS_LITERATURE_CACHE_ROOT/semantic-scholar/
    so restarts and re-fetches of the same URL/body do not burn the rate
    limit.
    """
    method = method.upper()
    if use_cache:
        hit = cache_get(method, url, body)
        if hit is not None:
            return hit
        _CACHE_STATS["misses"] += 1

    last: Exception | None = None
    for attempt in range(retries):
        try:
            _wait_for_rate_slot()
            data = None
            headers = api_headers()
            if body is not None:
                data = json.dumps(body).encode("utf-8")
                headers = {**headers, "Content-Type": "application/json"}
            request = urllib.request.Request(url, data=data, headers=headers, method=method)
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if use_cache:
                cache_put(method, url, body, payload)
            return payload
        except urllib.error.HTTPError as error:
            last = error
            err_body = error.read().decode("utf-8", errors="replace")[:200]
            if error.code in {429, 500, 503}:
                retry_after = error.headers.get("Retry-After") if error.headers else None
                if retry_after and str(retry_after).replace(".", "", 1).isdigit():
                    wait = min(30.0, float(retry_after))
                else:
                    # Short backoff: long retries were multi-minute stalls per DOI.
                    wait = min(20.0, 3.0 * (2 ** attempt))
                time.sleep(wait)
                continue
            raise CliError(f"Semantic Scholar HTTP {error.code}: {err_body}") from error
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last = error
            time.sleep(1.0 * (attempt + 1))
    raise CliError(f"Semantic Scholar request failed after retries: {last}") from last


def http_get_json(url: str, *, retries: int = 5) -> dict[str, Any]:
    payload = http_json("GET", url, retries=retries)
    if not isinstance(payload, dict):
        raise CliError("Semantic Scholar response must be a JSON object")
    return payload


def write_json(path: Path, value: dict[str, Any]) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def normalize_doi(doi: str) -> str:
    value = doi.strip()
    value = value.removeprefix("https://doi.org/").removeprefix("http://doi.org/")
    # Case-insensitive doi: prefix (batch ids often look like DOI:10.x).
    if value.lower().startswith("doi:"):
        value = value[4:]
    if not value:
        raise CliError("DOI must not be empty")
    return value


def paper_id_token(paper_id_or_doi: str) -> str:
    """Build path/batch id token: DOI:… / paperId / CorpusId:…"""
    text = paper_id_or_doi.strip()
    if text.lower().startswith("doi:") or text.startswith("10.") or "doi.org/" in text.lower():
        return f"DOI:{normalize_doi(text)}"
    return text


def paper_by_doi(doi: str, *, fields: str = DEFAULT_FIELDS) -> dict[str, Any]:
    doi = normalize_doi(doi)
    path = "/paper/" + urllib.parse.quote(f"DOI:{doi}", safe="")
    url = f"{BASE}{path}?fields={urllib.parse.quote(fields, safe=',')}"
    return http_get_json(url)


def paper_by_id(paper_id: str, *, fields: str = DEFAULT_FIELDS) -> dict[str, Any]:
    if not paper_id.strip():
        raise CliError("paperId must not be empty")
    url = (
        f"{BASE}/paper/{urllib.parse.quote(paper_id.strip(), safe='')}"
        f"?fields={urllib.parse.quote(fields, safe=',')}"
    )
    return http_get_json(url)


def paper_batch(
    ids: list[str],
    *,
    fields: str = DEFAULT_FIELDS,
    batch_size: int = 100,
) -> list[dict[str, Any] | None]:
    """POST /paper/batch — tutorial: prefer batch over N single paper GETs.

    Each id may be paperId or DOI:… / PMID:… etc. Returns list aligned with
    input order; missing papers are None.
    """
    if not ids:
        return []
    batch_size = max(1, min(500, int(batch_size)))
    out: list[dict[str, Any] | None] = []
    tokens = [paper_id_token(item) for item in ids]
    for start in range(0, len(tokens), batch_size):
        chunk = tokens[start : start + batch_size]
        url = f"{BASE}/paper/batch?fields={urllib.parse.quote(fields, safe=',')}"
        payload = http_json("POST", url, body={"ids": chunk})
        if not isinstance(payload, list):
            raise CliError("paper/batch response must be a JSON array")
        for item in payload:
            if item is None:
                out.append(None)
            elif isinstance(item, dict):
                out.append(item)
            else:
                out.append(None)
        # Pad if API returned fewer slots than requested.
        while len(out) < start + len(chunk):
            out.append(None)
    return out[: len(tokens)]


def paginate_related(
    paper_id: str,
    kind: str,
    *,
    limit: int,
    fields: str = CITE_FIELDS,
) -> list[dict[str, Any]]:
    """Fetch citations or references.

    Graph API allows a large per-request ``limit`` (up to 1000). Expand only
    needs tens–hundreds of neighbors, so we use **one request** (no offset
    paging) unless limit > 1000, in which case we page.
    """
    if kind not in {"citations", "references"}:
        raise CliError("kind must be citations or references")
    limit = max(1, min(1000, int(limit)))
    collected: list[dict[str, Any]] = []
    offset = 0
    # Prefer single shot: take min(limit, 1000) in one GET (1 rps slot).
    max_page = 1000
    while len(collected) < limit:
        take = min(max_page, limit - len(collected))
        url = (
            f"{BASE}/paper/{urllib.parse.quote(paper_id, safe='')}/{kind}"
            f"?fields={urllib.parse.quote(fields, safe=',')}"
            f"&limit={take}&offset={offset}"
        )
        batch = http_get_json(url)
        data = batch.get("data")
        if not isinstance(data, list) or not data:
            break
        for item in data:
            if isinstance(item, dict):
                collected.append(item)
        if len(data) < take:
            break
        offset += len(data)
        # Only continue if caller asked for more than one full page.
        if take < max_page:
            break
    return collected[:limit]


def search_papers(query: str, *, limit: int = 20, fields: str = DEFAULT_FIELDS) -> list[dict[str, Any]]:
    """Relevance search (GET /paper/search). For large recall prefer bulk search."""
    if not query.strip():
        raise CliError("query must not be empty")
    limit = max(1, min(100, int(limit)))
    params = urllib.parse.urlencode(
        {
            "query": query.strip(),
            "limit": str(limit),
            "fields": fields,
        }
    )
    payload = http_get_json(f"{BASE}/paper/search?{params}")
    data = payload.get("data")
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


def search_papers_bulk(
    query: str,
    *,
    fields: str = "paperId,title,year,abstract,venue,externalIds,url,openAccessPdf,citationCount",
    year: str | None = None,
    max_results: int = 100,
) -> list[dict[str, Any]]:
    """Bulk search (GET /paper/search/bulk) — tutorial-recommended for larger sets."""
    if not query.strip():
        raise CliError("query must not be empty")
    max_results = max(1, min(1000, int(max_results)))
    collected: list[dict[str, Any]] = []
    token: str | None = None
    while len(collected) < max_results:
        params: dict[str, str] = {
            "query": query.strip(),
            "fields": fields,
        }
        if year:
            params["year"] = year
        if token:
            params["token"] = token
        url = f"{BASE}/paper/search/bulk?{urllib.parse.urlencode(params)}"
        payload = http_get_json(url)
        data = payload.get("data")
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict):
                    collected.append(item)
                    if len(collected) >= max_results:
                        break
        next_token = payload.get("token")
        if not isinstance(next_token, str) or not next_token or not data:
            break
        token = next_token
    return collected[:max_results]


def paper_external_doi(paper: dict[str, Any] | None) -> str | None:
    if not isinstance(paper, dict):
        return None
    ext = paper.get("externalIds") if isinstance(paper.get("externalIds"), dict) else {}
    doi = ext.get("DOI")
    if isinstance(doi, str) and doi.strip():
        return normalize_doi(doi)
    return None


def command_paper(args: argparse.Namespace, root: Path) -> int:
    if args.doi:
        paper = paper_by_doi(args.doi)
    elif args.paper_id:
        paper = paper_by_id(args.paper_id)
    else:
        raise CliError("paper requires --doi or --paper-id")
    payload = {
        "schema_version": "clue.semantic-scholar.paper.v1",
        "tool": {"name": TOOL_NAME, "version": read_version(root)},
        "paper": paper,
        "authenticated": bool(api_key()),
    }
    destination = Path(args.output).expanduser().resolve()
    write_json(destination, payload)
    print(
        json.dumps(
            {
                "status": "succeeded",
                "output": str(destination),
                "paperId": paper.get("paperId"),
                "citationCount": paper.get("citationCount"),
                "referenceCount": paper.get("referenceCount"),
                "authenticated": bool(api_key()),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def command_citations(args: argparse.Namespace, root: Path) -> int:
    paper = paper_by_doi(args.doi) if args.doi else paper_by_id(args.paper_id)
    paper_id = paper.get("paperId")
    if not isinstance(paper_id, str) or not paper_id:
        raise CliError("Semantic Scholar paper has no paperId")
    rows = paginate_related(paper_id, "citations", limit=args.limit)
    citing = []
    for row in rows:
        citing_paper = row.get("citingPaper")
        if isinstance(citing_paper, dict):
            citing.append(citing_paper)
    payload = {
        "schema_version": "clue.semantic-scholar.citations.v1",
        "tool": {"name": TOOL_NAME, "version": read_version(root)},
        "seed": {
            "DOI": paper_external_doi(paper) or args.doi,
            "paperId": paper_id,
            "title": paper.get("title"),
            "citationCount": paper.get("citationCount"),
        },
        "citations": citing,
        "returned": len(citing),
    }
    destination = Path(args.output).expanduser().resolve()
    write_json(destination, payload)
    print(
        json.dumps(
            {"status": "succeeded", "output": str(destination), "returned": len(citing)},
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def command_references(args: argparse.Namespace, root: Path) -> int:
    paper = paper_by_doi(args.doi) if args.doi else paper_by_id(args.paper_id)
    paper_id = paper.get("paperId")
    if not isinstance(paper_id, str) or not paper_id:
        raise CliError("Semantic Scholar paper has no paperId")
    rows = paginate_related(paper_id, "references", limit=args.limit)
    refs = []
    for row in rows:
        cited = row.get("citedPaper")
        if isinstance(cited, dict):
            refs.append(cited)
    payload = {
        "schema_version": "clue.semantic-scholar.references.v1",
        "tool": {"name": TOOL_NAME, "version": read_version(root)},
        "seed": {
            "DOI": paper_external_doi(paper) or args.doi,
            "paperId": paper_id,
            "title": paper.get("title"),
            "referenceCount": paper.get("referenceCount"),
        },
        "references": refs,
        "returned": len(refs),
    }
    destination = Path(args.output).expanduser().resolve()
    write_json(destination, payload)
    print(
        json.dumps(
            {"status": "succeeded", "output": str(destination), "returned": len(refs)},
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def command_search(args: argparse.Namespace, root: Path) -> int:
    if getattr(args, "bulk", False):
        papers = search_papers_bulk(args.query, max_results=args.limit)
        schema = "clue.semantic-scholar.search-bulk.v1"
    else:
        papers = search_papers(args.query, limit=args.limit)
        schema = "clue.semantic-scholar.search.v1"
    payload = {
        "schema_version": schema,
        "tool": {"name": TOOL_NAME, "version": read_version(root)},
        "query": args.query,
        "papers": papers,
        "returned": len(papers),
        "authenticated": bool(api_key()),
    }
    destination = Path(args.output).expanduser().resolve()
    write_json(destination, payload)
    print(
        json.dumps(
            {
                "status": "succeeded",
                "output": str(destination),
                "returned": len(papers),
                "authenticated": bool(api_key()),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def command_batch(args: argparse.Namespace, root: Path) -> int:
    ids = [item.strip() for item in args.ids if item and item.strip()]
    if not ids and args.ids_file:
        text = Path(args.ids_file).expanduser().read_text(encoding="utf-8")
        ids = [line.strip() for line in text.splitlines() if line.strip()]
    if not ids:
        raise CliError("batch requires --ids or --ids-file")
    papers = paper_batch(ids, fields=args.fields or DEFAULT_FIELDS)
    payload = {
        "schema_version": "clue.semantic-scholar.batch.v1",
        "tool": {"name": TOOL_NAME, "version": read_version(root)},
        "ids": ids,
        "papers": papers,
        "returned": sum(1 for item in papers if isinstance(item, dict)),
        "authenticated": bool(api_key()),
    }
    destination = Path(args.output).expanduser().resolve()
    write_json(destination, payload)
    print(
        json.dumps(
            {
                "status": "succeeded",
                "output": str(destination),
                "requested": len(ids),
                "returned": payload["returned"],
                "authenticated": bool(api_key()),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=TOOL_NAME,
        description="Semantic Scholar paper graph: lookup, citations, references, search, batch.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("version", help="Print tool version.")

    def add_id_args(target: argparse.ArgumentParser) -> None:
        target.add_argument("--doi", help="DOI (with or without https://doi.org/).")
        target.add_argument("--paper-id", help="Semantic Scholar paperId.")
        target.add_argument("--output", required=True, help="Output JSON path.")
        target.add_argument("--limit", type=int, default=50, help="Max related papers (1-500).")

    paper = sub.add_parser("paper", help="Fetch one paper by DOI or paperId.")
    paper.add_argument("--doi")
    paper.add_argument("--paper-id")
    paper.add_argument("--output", required=True)

    cites = sub.add_parser("citations", help="Papers that cite the seed (inbound).")
    add_id_args(cites)

    refs = sub.add_parser("references", help="Bibliography of the seed (outbound).")
    add_id_args(refs)

    search = sub.add_parser("search", help="Keyword search.")
    search.add_argument("--query", required=True)
    search.add_argument("--limit", type=int, default=20)
    search.add_argument("--bulk", action="store_true", help="Use /paper/search/bulk.")
    search.add_argument("--output", required=True)

    batch = sub.add_parser("batch", help="POST /paper/batch for many IDs/DOIs.")
    batch.add_argument("--ids", nargs="*", default=[], help="IDs e.g. DOI:10.x or paperId.")
    batch.add_argument("--ids-file", help="File with one id per line.")
    batch.add_argument("--fields", default=DEFAULT_FIELDS)
    batch.add_argument("--output", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    root = Path(__file__).resolve().parent
    args = build_parser().parse_args(argv)
    try:
        if args.command == "version":
            print(
                json.dumps(
                    {
                        "tool": {"name": TOOL_NAME, "version": read_version(root)},
                        "backend_lock": json.loads((root / "backend.lock.json").read_text(encoding="utf-8")),
                        "authenticated": bool(api_key()),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
        if args.command == "paper":
            return command_paper(args, root)
        if args.command == "citations":
            if not args.doi and not args.paper_id:
                raise CliError("citations requires --doi or --paper-id")
            return command_citations(args, root)
        if args.command == "references":
            if not args.doi and not args.paper_id:
                raise CliError("references requires --doi or --paper-id")
            return command_references(args, root)
        if args.command == "search":
            return command_search(args, root)
        if args.command == "batch":
            return command_batch(args, root)
        raise CliError(f"unsupported command: {args.command}")
    except CliError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
