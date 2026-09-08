"""Phase 1 — collection: normalize sources, seed scope, list PDF links.

Orchestration entrypoints used by runner.phase_collection when
collection_kind is literature. See README.md (section Phase 1).
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from literature.support import (
    LiteratureError,
    OUTPUT_V2,
    PHASE_COLLECTION,
    log,
    read_json,
    required_list,
)


def record_candidate_links(record: dict[str, Any]) -> list[dict[str, str]]:
    """List source and structured metadata links without downloading them.

    Provider PDF URLs (Semantic Scholar openAccessPdf, Crossref link[] PDFs,
    arXiv pdf from externalIds) are listed first for phase-2 short-circuit.
    """
    candidates: list[dict[str, str]] = []
    seen: set[str] = set()

    def add_url(url: str, link_kind: str) -> None:
        parsed = urlparse(url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or url in seen
        ):
            return
        seen.add(url)
        candidates.append(
            {
                "url": url,
                "link_kind": link_kind,
                "validation": "not_downloaded",
            }
        )

    # 1) Explicit provider PDF endpoints (shared with pdf_capture).
    try:
        from literature.pdf_capture import provider_pdf_candidates

        for item in provider_pdf_candidates(record):
            if isinstance(item, dict) and isinstance(item.get("url"), str):
                add_url(item["url"], str(item.get("link_kind") or "provider-pdf"))
    except Exception:  # noqa: BLE001 — listing must not fail collection
        pass

    source_url = record.get("source_url")
    if isinstance(source_url, str):
        add_url(source_url, "record-source")

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                normalized_key = key.lower()
                if normalized_key in {
                    "full_text",
                    "abstract",
                    "content",
                    "text",
                    # Already handled via provider_pdf_candidates.
                    "openaccesspdf",
                    "pdf_links",
                }:
                    continue
                if isinstance(item, str):
                    add_url(item, "source-metadata")
                else:
                    visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)

    visit(record.get("payload", {}))
    return candidates


def collect_paper_links(output: dict[str, Any]) -> dict[str, Any]:
    """Attach unvalidated source and metadata links for manual download."""
    records: list[dict[str, Any]] = []
    for record in output["records"]:
        payload = dict(record["payload"])
        payload["pdf_links"] = {
            "status": "listed",
            "candidates": record_candidate_links(record),
            "validation": "not_downloaded",
        }
        records.append({**record, "payload": payload})
    return {**output, "records": records}



def apply_seed_literature_scope(
    collection: dict[str, Any],
    input_value: dict[str, Any],
) -> dict[str, Any]:
    """Filter phase-1 seed records with the same bounds as expansion.

    Controlled by payload.literature_scope.enabled (default true for literature).
    Rejected seeds go to rejected_records with scope_decision reasons.
    """
    payload = input_value.get("payload") if isinstance(input_value.get("payload"), dict) else {}
    scope_cfg = (
        payload.get("literature_scope")
        if isinstance(payload.get("literature_scope"), dict)
        else {}
    )
    if scope_cfg.get("enabled") is False:
        log(
            "phase1_scope_skipped",
            phase_id=PHASE_COLLECTION,
            phase="collection",
            reason="payload.literature_scope.enabled=false",
        )
        return collection

    from literature.scope import (
        VenueCatalog,
        bounds_from_input,
        filter_records,
        topic_keywords_from_input,
    )

    bounds = bounds_from_input(input_value)
    catalog = VenueCatalog.load(bounds.catalog_path)
    topic_keywords = topic_keywords_from_input(input_value)
    records = [r for r in (collection.get("records") or []) if isinstance(r, dict)]
    prior_rejected = [
        r for r in (collection.get("rejected_records") or []) if isinstance(r, dict)
    ]
    split = filter_records(
        records, bounds=bounds, catalog=catalog, topic_keywords=topic_keywords
    )
    accepted = split["accepted"]
    rejected = split["rejected"]
    # Soft cap on seed set only (expansion still has its own max_records policy).
    if bounds.max_records is not None and len(accepted) > bounds.max_records:
        overflow = accepted[bounds.max_records :]
        accepted = accepted[: bounds.max_records]
        for item in overflow:
            decision = dict(item.get("scope_decision") or {})
            reasons = list(decision.get("reasons") or [])
            reasons.append(f"seed_max_records:{bounds.max_records}")
            decision["in_bounds"] = False
            decision["reasons"] = reasons
            item = {**item, "scope_decision": decision}
            rejected.append(item)

    out = {
        **collection,
        "records": accepted,
        "rejected_records": prior_rejected + rejected,
        "literature_scope": {
            "stage": "seed",
            "bounds": split["bounds"],
            "topic_keywords": topic_keywords,
            "accepted_count": len(accepted),
            "rejected_count": len(rejected),
            "seed_total_before": len(records),
        },
    }
    gaps = list(out.get("information_gaps") or [])
    gaps.append(
        "Seed records filtered by literature_scope (CCF A/B/C, year window, "
        "arXiv CoRR, title/abstract topic keywords from input scope.include)."
    )
    out["information_gaps"] = list(dict.fromkeys(gaps))
    log(
        "phase1_scope_applied",
        phase_id=PHASE_COLLECTION,
        phase="collection",
        accepted=len(accepted),
        rejected=len(rejected),
        bounds=split["bounds"],
        topic_keywords=topic_keywords,
    )
    return out


def normalize_crossref(input_value: dict[str, Any], sources: list[str]) -> dict[str, Any]:
    """Builtin Crossref JSON → literature v2 candidate records (used by run)."""
    if input_value.get("collection_kind") != "literature":
        raise LiteratureError("Crossref normalization requires a literature v2 input")
    records: list[dict[str, Any]] = []
    artifacts: list[dict[str, str]] = []
    observed_at = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    for source in sources:
        path = Path(source).expanduser().resolve()
        document = read_json(str(path), "Crossref source")
        items = [document["work"]] if isinstance(document.get("work"), dict) else document.get("items", document.get("results", []))
        if not isinstance(items, list):
            raise LiteratureError(f"Crossref source has no work or items array: {path}")
        artifacts.append({"path": str(path), "sha256": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()})
        for item in items:
            if not isinstance(item, dict):
                continue
            raw_title = item.get("title", [])
            title = raw_title if isinstance(raw_title, str) and raw_title.strip() else next((entry for entry in raw_title if isinstance(entry, str) and entry.strip()), None)
            doi = item.get("DOI") if isinstance(item.get("DOI"), str) else None
            if doi is None and isinstance(item.get("doi"), str):
                doi = item["doi"].removeprefix("https://doi.org/")
            url = item.get("URL") if isinstance(item.get("URL"), str) else (f"https://doi.org/{doi}" if doi else item.get("id"))
            if not title or not url:
                continue
            digest = "sha256:" + hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()
            record_id = f"doi:{doi.lower()}" if doi else f"crossref:{digest[7:23]}"
            quote = item.get("abstract") if isinstance(item.get("abstract"), str) and item["abstract"].strip() else title
            records.append({"record_id": record_id, "record_kind": "literature-candidate", "source_url": url, "observed_at": observed_at, "content_hash": digest, "evidence": [{"quote": quote, "locator": "Crossref abstract" if quote != title else "Crossref title"}], "payload": item})
    unique = {record["record_id"]: record for record in records}
    return {"schema_version": OUTPUT_V2, "collection_id": input_value["collection_id"], "collection_kind": "literature", "status": "candidate_set", "records": list(unique.values()), "rejected_records": [], "run_artifacts": artifacts, "information_gaps": ["Candidates are unreviewed; this output does not assert topical relevance or corpus-wide recall."]}



def normalize_deepsec(input_value: dict[str, Any], source: str) -> dict[str, Any]:
    """Normalize DeepSec API paper results without asserting their relevance."""
    document = read_json(source, "DeepSec source")
    if document.get("schema_version") != "clue.deepsec.search.v1":
        raise LiteratureError("DeepSec source must use clue.deepsec.search.v1")
    papers = required_list(document, "papers", "DeepSec source")
    observed_at = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    records: list[dict[str, Any]] = []
    for paper in papers:
        if not isinstance(paper, dict):
            continue
        title = paper.get("title")
        url = paper.get("url")
        abstract = paper.get("abstract")
        quote = abstract if isinstance(abstract, str) and abstract.strip() else title
        if not all(isinstance(item, str) and item.strip() for item in (title, url, quote)):
            continue
        digest = "sha256:" + hashlib.sha256(
            json.dumps(paper, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()
        payload = dict(paper)
        payload["source_tool"] = "deepsec"
        records.append(
            {
                "record_id": "deepsec:" + hashlib.sha256(url.encode("utf-8")).hexdigest()[:24],
                "record_kind": "literature-candidate",
                "source_url": url,
                "observed_at": observed_at,
                "content_hash": digest,
                "evidence": [{"quote": quote, "locator": "DeepSec abstract"}],
                "payload": payload,
            }
        )
    unique = {record["record_id"]: record for record in records}
    return {
        "schema_version": OUTPUT_V2,
        "collection_id": input_value["collection_id"],
        "collection_kind": input_value["collection_kind"],
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
            "Candidates are unreviewed; this output does not assert topical relevance or corpus-wide recall."
        ],
    }


def normalize_semantic_scholar(input_value: dict[str, Any], source: str) -> dict[str, Any]:
    """Normalize Semantic Scholar search JSON into literature candidates."""
    document = read_json(source, "Semantic Scholar source")
    papers = document.get("papers") if isinstance(document.get("papers"), list) else []
    if document.get("schema_version") == "clue.semantic-scholar.paper.v1":
        paper = document.get("paper")
        papers = [paper] if isinstance(paper, dict) else []
    observed_at = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    records: list[dict[str, Any]] = []
    for item in papers:
        if not isinstance(item, dict):
            continue
        title = item.get("title")
        if not isinstance(title, str) or not title.strip():
            continue
        ext = item.get("externalIds") if isinstance(item.get("externalIds"), dict) else {}
        doi = ext.get("DOI") if isinstance(ext.get("DOI"), str) else None
        if doi:
            doi = doi.removeprefix("https://doi.org/").removeprefix("http://doi.org/")
            record_id = f"doi:{doi.lower()}"
            url = f"https://doi.org/{doi}"
        elif isinstance(item.get("paperId"), str) and item["paperId"]:
            record_id = f"s2:{item['paperId']}"
            url = item.get("url") if isinstance(item.get("url"), str) else (
                f"https://www.semanticscholar.org/paper/{item['paperId']}"
            )
        else:
            continue
        authors = [
            a.get("name")
            for a in (item.get("authors") or [])
            if isinstance(a, dict) and isinstance(a.get("name"), str)
        ]
        payload = dict(item)
        payload["source_tool"] = "semantic-scholar"
        payload["title"] = title.strip()
        if doi:
            payload["DOI"] = doi
        if item.get("venue"):
            payload["container-title"] = item["venue"]
        if authors:
            payload["authors"] = authors
        digest = "sha256:" + hashlib.sha256(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()
        quote = item.get("abstract") if isinstance(item.get("abstract"), str) else title
        records.append(
            {
                "record_id": record_id,
                "record_kind": "literature-candidate",
                "source_url": url,
                "observed_at": observed_at,
                "content_hash": digest,
                "evidence": [
                    {
                        "quote": str(quote)[:800],
                        "locator": "Semantic Scholar abstract" if quote != title else "Semantic Scholar title",
                    }
                ],
                "payload": payload,
            }
        )
    unique = {record["record_id"]: record for record in records}
    return {
        "schema_version": OUTPUT_V2,
        "collection_id": input_value["collection_id"],
        "collection_kind": "literature",
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
            "Candidates are unreviewed; this output does not assert topical relevance or corpus-wide recall."
        ],
    }
