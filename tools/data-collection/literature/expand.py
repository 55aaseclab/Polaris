"""Expand literature corpus via Crossref + Semantic Scholar (dual source).

Trusted discovery / expand tools:
  - Crossref (DOI metadata, bibliographic search, reference lists)
  - Semantic Scholar (inbound citations + outbound references)
  - DeepSec (cybersecurity paper API, seeds only)

Expansion:
  1. Collect DOIs from seed records.
  2. For each DOI: Semantic Scholar citations + references, Crossref work.references.
  3. Merge / dedupe by DOI (dual-source quality); hydrate title/abstract from
     S2 + Crossref; apply literature_scope (year/venue) + topic keywords on
     title+abstract (from input scope.include).
  4. Graph edges: A→B means A references B. Only accepted papers join frontier.
  5. Repeat until frontier empty (or max_rounds).
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from literature.graph import LiteratureGraph
from literature.scope import (
    LiteratureBounds,
    VenueCatalog,
    default_bounds,
    evaluate_record,
    record_abstract,
    record_title,
    record_year,
    strip_markup,
)

# literature/ → data-collection/ → tools/
_TOOLS = Path(__file__).resolve().parents[2]
_S2_MODULE: ModuleType | None = None


def _load_semantic_scholar() -> ModuleType:
    """Load tools/semantic-scholar/runner.py without clashing with data-collection/runner."""
    global _S2_MODULE
    if _S2_MODULE is not None:
        return _S2_MODULE
    path = _TOOLS / "semantic-scholar" / "runner.py"
    if not path.is_file():
        raise ImportError(f"semantic-scholar runner missing: {path}")
    spec = importlib.util.spec_from_file_location("clue_semantic_scholar_runner", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load semantic-scholar runner: {path}")
    module = importlib.util.module_from_spec(spec)
    # Register before exec so dataclasses / typing edge cases resolve.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    _S2_MODULE = module
    return module


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def log(message: str, **fields: Any) -> None:
    payload: dict[str, Any] = {
        "ts": utc_now(),
        "level": "info",
        "msg": message,
        "component": "literature_expand",
    }
    payload.update(fields)
    print(json.dumps(payload, ensure_ascii=False), file=sys.stderr, flush=True)


def tools_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def normalize_doi(value: str | None) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    doi = value.strip()
    doi = re.sub(r"^https?://(dx\.)?doi\.org/", "", doi, flags=re.I)
    doi = re.sub(r"^doi:\s*", "", doi, flags=re.I)
    doi = doi.strip().rstrip(".")
    if not doi or " " in doi:
        return None
    # Reject obvious garbage (truncated Crossref refs)
    if doi.count("/") < 1 or len(doi) < 6:
        return None
    if doi.lower() in {"10.1016/j", "10.1016/j."}:
        return None
    # Canonicalize for merge keys. Preserve arXiv registrant casing Crossref uses.
    m = re.search(r"^10\.48550/arxiv\.(.+)$", doi, re.I)
    if m:
        return f"10.48550/arXiv.{m.group(1)}"
    return doi.lower() if doi.startswith("10.") else doi


def record_doi(record: dict[str, Any]) -> str | None:
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    for key in ("DOI", "doi"):
        doi = normalize_doi(payload.get(key) if isinstance(payload.get(key), str) else None)
        if doi:
            return doi
    rid = record.get("record_id")
    if isinstance(rid, str) and rid.lower().startswith("doi:"):
        return normalize_doi(rid[4:])
    ext = payload.get("externalIds") if isinstance(payload.get("externalIds"), dict) else {}
    return normalize_doi(ext.get("DOI") if isinstance(ext.get("DOI"), str) else None)


def _title_of(record: dict[str, Any]) -> str | None:
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    title = payload.get("title") or payload.get("display_name")
    if isinstance(title, list) and title:
        return str(title[0])
    if isinstance(title, str) and title.strip():
        return title
    return None


def write_expand_checkpoint(
    work_dir: Path,
    *,
    collection: dict[str, Any],
    records: list[dict[str, Any]],
    graph: LiteratureGraph,
    stats: dict[str, Any],
    bounds: LiteratureBounds,
    frontier: set[str],
    seen: set[str],
    round_idx: int,
    full: bool = True,
) -> None:
    work_dir.mkdir(parents=True, exist_ok=True)
    progress = {
        "ts": utc_now(),
        "round": round_idx,
        "corpus": len(records),
        "frontier": len(frontier),
        "seen": len(seen),
        "stats": dict(stats),
        "bounds": bounds.to_dict(),
    }
    _atomic_write_json(work_dir / "progress.json", progress)
    # Resume state: full DOI lists so a restart can skip completed seeds.
    state = {
        "ts": utc_now(),
        "round": round_idx,
        "seen": sorted(seen),
        "frontier": sorted(frontier),
        "stats": dict(stats),
    }
    _atomic_write_json(work_dir / "expand-state.json", state)
    with (work_dir / "progress.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(progress, ensure_ascii=False) + "\n")
    if not full:
        return
    for record in records:
        rid = str(record.get("record_id") or "")
        if rid in graph.nodes:
            graph.nodes[rid]["in_corpus"] = True
    graph_json = work_dir / "literature-graph.json"
    graph_dot = work_dir / "literature-graph.dot"
    graph.write_json(graph_json)
    graph.write_dot(graph_dot)
    document = {
        **collection,
        "records": records,
        "status": collection.get("status") or "candidate_set",
        "literature_expansion": {
            "tool": "literature_expand",
            "generated_at": utc_now(),
            "checkpoint": True,
            "stats": dict(stats),
            "bounds": bounds.to_dict(),
            "graph_json": str(graph_json),
            "graph_dot": str(graph_dot),
            "record_count": len(records),
            "edge_count": len(graph.edges),
            "node_count": len(graph.nodes),
            "frontier_remaining": len(frontier),
            "round": round_idx,
            "sources": ["crossref", "semantic-scholar"],
            "seen_count": len(seen),
        },
    }
    _atomic_write_json(work_dir / "expanded-collection.checkpoint.json", document)
    log(
        "expand_checkpoint",
        round=round_idx,
        corpus=len(records),
        frontier=len(frontier),
        stats=stats,
    )


# --- Crossref -----------------------------------------------------------------

def fetch_crossref_work(doi: str) -> dict[str, Any] | None:
    """Fetch one Crossref work (includes reference[] when deposited)."""
    doi = normalize_doi(doi) or doi
    # Keep slash unescaped; try canonical then lowercase fallback for registries.
    attempts = [doi]
    if doi != doi.lower():
        attempts.append(doi.lower())
    if "arXiv." in doi:
        attempts.append(doi.replace("arXiv.", "arxiv."))
    headers = {"User-Agent": "clue-literature-expand/0.1 (mailto:research@localhost; Crossref)"}
    last_error: Exception | None = None
    for candidate in dict.fromkeys(attempts):
        url = f"https://api.crossref.org/works/{quote(candidate, safe='/')}"
        try:
            with urlopen(Request(url, headers=headers), timeout=40) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if payload.get("status") == "ok" and isinstance(payload.get("message"), dict):
                return payload["message"]
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
            continue
    log(
        "expand_crossref_failed",
        doi=doi,
        error=str(last_error)[:200] if last_error else "unknown",
    )
    return None


def crossref_reference_dois(work: dict[str, Any]) -> list[str]:
    refs = work.get("reference") if isinstance(work.get("reference"), list) else []
    out: list[str] = []
    seen: set[str] = set()
    for item in refs:
        if not isinstance(item, dict):
            continue
        doi = normalize_doi(item.get("DOI") if isinstance(item.get("DOI"), str) else None)
        if doi and doi not in seen:
            seen.add(doi)
            out.append(doi)
    return out


# --- Semantic Scholar ---------------------------------------------------------

def fetch_s2_paper(doi: str) -> dict[str, Any] | None:
    try:
        s2 = _load_semantic_scholar()
        return s2.paper_by_doi(doi)
    except Exception as error:  # noqa: BLE001
        log("expand_s2_paper_failed", doi=doi, error=str(error)[:200])
        return None


def fetch_s2_graph(
    doi: str,
    *,
    citation_limit: int = 50,
    reference_limit: int = 100,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """One paper resolve + citations + references (tutorial-efficient path).

    Previously citations and references each called paper_by_doi separately
    (2× waste). Now: 1× paper + paginated cites + paginated refs.
    """
    s2 = _load_semantic_scholar()
    paper = s2.paper_by_doi(doi)
    paper_id = paper.get("paperId")
    if not isinstance(paper_id, str) or not paper_id:
        return [], []
    citing: list[dict[str, Any]] = []
    refs: list[dict[str, Any]] = []
    if citation_limit > 0:
        try:
            rows = s2.paginate_related(paper_id, "citations", limit=citation_limit)
            citing = [
                row.get("citingPaper")
                for row in rows
                if isinstance(row.get("citingPaper"), dict)
            ]
        except Exception as error:  # noqa: BLE001
            log("expand_s2_citations_failed", doi=doi, error=str(error)[:200])
    if reference_limit > 0:
        try:
            rows = s2.paginate_related(paper_id, "references", limit=reference_limit)
            refs = [
                row.get("citedPaper")
                for row in rows
                if isinstance(row.get("citedPaper"), dict)
            ]
        except Exception as error:  # noqa: BLE001
            log("expand_s2_references_failed", doi=doi, error=str(error)[:200])
    return citing, refs


# --- Record builders / dual merge --------------------------------------------

def s2_paper_to_record(paper: dict[str, Any], *, observed_at: str, source_role: str) -> dict[str, Any] | None:
    title = paper.get("title")
    if not isinstance(title, str) or not title.strip():
        return None
    title = title.strip()
    ext = paper.get("externalIds") if isinstance(paper.get("externalIds"), dict) else {}
    doi = normalize_doi(ext.get("DOI") if isinstance(ext.get("DOI"), str) else None)
    arxiv = ext.get("ArXiv") if isinstance(ext.get("ArXiv"), str) else None
    if doi:
        record_id = f"doi:{doi}"
        url = f"https://doi.org/{doi}"
    elif arxiv:
        record_id = f"arxiv:{arxiv}"
        url = f"https://arxiv.org/abs/{arxiv}"
    elif isinstance(paper.get("paperId"), str) and paper["paperId"]:
        record_id = f"s2:{paper['paperId']}"
        url = paper.get("url") if isinstance(paper.get("url"), str) else f"https://www.semanticscholar.org/paper/{paper['paperId']}"
    else:
        return None
    authors = []
    for author in paper.get("authors") or []:
        if isinstance(author, dict) and isinstance(author.get("name"), str):
            authors.append(author["name"])
    raw_abstract = paper.get("abstract")
    abstract = strip_markup(raw_abstract) if isinstance(raw_abstract, str) and raw_abstract.strip() else None
    payload: dict[str, Any] = {
        "title": title,
        "year": paper.get("year"),
        "venue": paper.get("venue"),
        "abstract": abstract,
        "authors": authors,
        "DOI": doi,
        "externalIds": ext,
        "paperId": paper.get("paperId"),
        "citationCount": paper.get("citationCount"),
        "openAccessPdf": paper.get("openAccessPdf"),
        "source_tool": "semantic-scholar",
        "source_role": source_role,
        "container-title": paper.get("venue"),
    }
    if doi:
        payload["DOI"] = doi
    digest = "sha256:" + hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()
    quote = abstract if abstract else title
    locator = (
        f"Semantic Scholar {source_role} abstract"
        if abstract
        else f"Semantic Scholar {source_role} title"
    )
    return {
        "record_id": record_id,
        "record_kind": "literature-candidate",
        "source_url": url,
        "observed_at": observed_at,
        "content_hash": digest,
        "evidence": [{"quote": str(quote)[:800], "locator": locator}],
        "payload": payload,
    }


def crossref_work_to_record(work: dict[str, Any], *, observed_at: str, source_role: str) -> dict[str, Any] | None:
    raw_title = work.get("title", [])
    if isinstance(raw_title, list):
        title = next((t for t in raw_title if isinstance(t, str) and t.strip()), None)
    elif isinstance(raw_title, str):
        title = raw_title.strip() or None
    else:
        title = None
    doi = normalize_doi(work.get("DOI") if isinstance(work.get("DOI"), str) else None)
    if not title:
        return None
    title = strip_markup(title)
    if doi:
        record_id = f"doi:{doi}"
        url = work.get("URL") if isinstance(work.get("URL"), str) else f"https://doi.org/{doi}"
    else:
        digest_seed = json.dumps(work, sort_keys=True)[:200]
        record_id = "crossref:" + hashlib.sha256(digest_seed.encode()).hexdigest()[:16]
        url = work.get("URL") if isinstance(work.get("URL"), str) else None
        if not url:
            return None
    payload = dict(work)
    payload["title"] = title  # plain string for topic matching
    payload["source_tool"] = "crossref"
    payload["source_role"] = source_role
    if doi:
        payload["DOI"] = doi
    # year convenience for scope
    if "year" not in payload:
        for key in ("published-print", "published-online", "created"):
            parts = (work.get(key) or {}).get("date-parts") if isinstance(work.get(key), dict) else None
            if isinstance(parts, list) and parts and parts[0]:
                payload["year"] = parts[0][0]
                break
    raw_abstract = work.get("abstract")
    abstract = strip_markup(raw_abstract) if isinstance(raw_abstract, str) and raw_abstract.strip() else None
    if abstract:
        payload["abstract"] = abstract
    digest = "sha256:" + hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()
    quote = abstract if abstract else title
    locator = f"Crossref {source_role} abstract" if abstract else f"Crossref {source_role} title"
    return {
        "record_id": record_id,
        "record_kind": "literature-candidate",
        "source_url": url,
        "observed_at": observed_at,
        "content_hash": digest,
        "evidence": [{"quote": str(quote)[:800], "locator": locator}],
        "payload": payload,
    }


def enrich_record_text_from_providers(
    record: dict[str, Any],
    *,
    observed_at: str,
    use_semantic_scholar: bool = True,
) -> dict[str, Any]:
    """Fill missing title/abstract before topic checks.

    Performance: **never** call S2 here. S2 cit/ref/batch already return
    title+abstract fields. Per-record S2 hydrate was the main 429 source.
    Only Crossref is used for missing abstract (no S2 quota).
    """
    del use_semantic_scholar  # kept for call-site compatibility
    if record_title(record) and record_abstract(record):
        return record
    # Title alone is enough for topic keyword match; skip network if titled.
    if record_title(record) and not record_abstract(record):
        # Optional Crossref abstract fill (cheap vs S2 429).
        doi = record_doi(record)
        if not doi:
            return record
        work = fetch_crossref_work(doi)
        if work:
            cr_rec = crossref_work_to_record(work, observed_at=observed_at, source_role="hydrate")
            if cr_rec:
                record = merge_records(record, cr_rec)
        return record
    doi = record_doi(record)
    if doi:
        work = fetch_crossref_work(doi)
        if work:
            cr_rec = crossref_work_to_record(work, observed_at=observed_at, source_role="hydrate")
            if cr_rec:
                record = merge_records(record, cr_rec)
    return record


def merge_records(primary: dict[str, Any], secondary: dict[str, Any]) -> dict[str, Any]:
    """Prefer non-empty fields; tag dual-source quality."""
    a = dict(primary)
    b = secondary
    ap = a.get("payload") if isinstance(a.get("payload"), dict) else {}
    bp = b.get("payload") if isinstance(b.get("payload"), dict) else {}
    merged_payload = dict(bp)
    merged_payload.update({k: v for k, v in ap.items() if v not in (None, "", [], {})})
    # Prefer longer abstract / richer author lists
    for key in ("abstract", "title"):
        av, bv = ap.get(key), bp.get(key)
        if isinstance(av, str) and isinstance(bv, str) and len(bv) > len(av):
            merged_payload[key] = bv
        elif isinstance(av, str) and av.strip():
            merged_payload[key] = av
    tools = {
        ap.get("source_tool"),
        bp.get("source_tool"),
        "semantic-scholar" if "s2" in str(a.get("record_id")) else None,
    }
    merged_payload["source_tools"] = sorted({t for t in tools if isinstance(t, str)})
    merged_payload["dual_source"] = len(merged_payload["source_tools"]) > 1
    a["payload"] = merged_payload
    # Prefer doi: record ids
    if str(a.get("record_id", "")).startswith("doi:"):
        pass
    elif str(b.get("record_id", "")).startswith("doi:"):
        a["record_id"] = b["record_id"]
        a["source_url"] = b.get("source_url") or a.get("source_url")
    evidence = []
    for rec in (primary, secondary):
        for item in rec.get("evidence") or []:
            if isinstance(item, dict):
                evidence.append(item)
    a["evidence"] = evidence[:4]
    return a


def expand_collection(
    collection: dict[str, Any],
    *,
    work_dir: Path,
    bounds: LiteratureBounds | None = None,
    catalog: VenueCatalog | None = None,
    max_rounds: int | None = None,
    topic_keywords: list[str] | None = None,
    use_semantic_scholar: bool = True,
    checkpoint_every: int = 10,
    s2_citation_limit: int = 50,
    s2_reference_limit: int = 100,
    sleep_s: float = 0.8,
    input_value: dict[str, Any] | None = None,
    topic_judge_work_dir: Path | None = None,
    topic_judge_scope_path: Path | None = None,
    **_ignored: Any,
) -> dict[str, Any]:
    """Expand via Crossref references + optional Semantic Scholar citations/refs.

    Topic keywords (from input scope.include) are matched against each
    candidate's title + abstract from S2/Crossref. Non-matching papers are
    graph-linked but not added to the corpus or expand frontier.

    When ``input_value`` enables ``topic_judge.stages`` including ``expand``,
    keyword-pass candidates are batched through tools/codex before joining
    the corpus/frontier (disk-cached).

    Set use_semantic_scholar=False for Crossref-only expand (no S2 API calls).
    """
    bounds = bounds or default_bounds()
    catalog = catalog or VenueCatalog.load(bounds.catalog_path)
    keywords = [k for k in (topic_keywords or []) if isinstance(k, str) and k.strip()]
    use_s2 = bool(use_semantic_scholar)
    work_dir.mkdir(parents=True, exist_ok=True)

    llm_buffer = None
    if isinstance(input_value, dict):
        try:
            from literature.topic_judge import ExpandTopicJudgeBuffer, topic_judge_config

            tj_cfg = topic_judge_config(input_value)
            if tj_cfg.get("enabled") and "expand" in (tj_cfg.get("stages") or []):
                tj_dir = topic_judge_work_dir or (work_dir / "topic-judge-expand")
                llm_buffer = ExpandTopicJudgeBuffer(
                    input_value,
                    work_dir=tj_dir,
                    scope_path=topic_judge_scope_path,
                    config=tj_cfg,
                )
                log(
                    "expand_topic_judge_enabled",
                    batch_size=tj_cfg.get("batch_size"),
                    model=tj_cfg.get("model"),
                    work_dir=str(tj_dir),
                )
        except Exception as error:  # noqa: BLE001
            log("expand_topic_judge_init_failed", error=str(error)[:300])
            llm_buffer = None
    with (work_dir / "progress.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"ts": utc_now(), "msg": "expand_run_separator"}) + "\n")

    graph = LiteratureGraph()
    records = [r for r in (collection.get("records") or []) if isinstance(r, dict)]
    # Prefer checkpoint corpus if present (avoids restarting from seeds only).
    ck_path = work_dir / "expanded-collection.checkpoint.json"
    if ck_path.is_file():
        try:
            ck = json.loads(ck_path.read_text(encoding="utf-8"))
            ck_recs = [r for r in (ck.get("records") or []) if isinstance(r, dict)]
            if len(ck_recs) > len(records):
                records = ck_recs
                log("expand_resume_records", from_checkpoint=len(ck_recs))
        except (OSError, json.JSONDecodeError, TypeError):
            pass
    index: dict[str, dict[str, Any]] = {
        str(r.get("record_id")): r for r in records if r.get("record_id")
    }
    doi_index: dict[str, str] = {}
    for rid, rec in index.items():
        graph.add_node(rid, in_corpus=True, title=_title_of(rec), year=record_year(rec))
        doi = record_doi(rec)
        if doi:
            doi_index[doi] = rid

    # First run: seed frontier with every corpus DOI. On resume, trust expand-state
    # frontier (including empty) so a finished expand does not reopen all DOIs.
    frontier: set[str] = set(doi_index.keys())
    source_label = "crossref+semantic-scholar" if use_s2 else "crossref"
    stats = {
        "rounds": 0,
        "dois_fetched": 0,
        "s2_citation_hits": 0,
        "s2_reference_hits": 0,
        "s2_batch_hits": 0,
        "crossref_reference_hits": 0,
        "accepted": 0,
        "rejected": 0,
        "rejected_topic": 0,
        "rejected_topic_judge": 0,
        "topic_judge_batches": 0,
        "topic_judge_cache_hits": 0,
        "topic_judge_cache_misses": 0,
        "hydrated_text": 0,
        "fetch_errors": 0,
        "dual_source_merges": 0,
        "source": source_label,
        "use_semantic_scholar": use_s2,
        "topic_keywords": keywords,
        "topic_judge_expand": bool(llm_buffer and llm_buffer.enabled),
    }
    seen: set[str] = set()
    round_idx = 0
    # Resume seen/frontier so restarts skip finished seeds (no wasted 1 rps).
    state_path = work_dir / "expand-state.json"
    if state_path.is_file():
        try:
            st = json.loads(state_path.read_text(encoding="utf-8"))
            prior_seen = {str(x) for x in (st.get("seen") or []) if x}
            # Distinguish missing frontier key (legacy) from explicit empty list
            # (expand finished). Only re-seed from corpus when frontier is absent.
            has_frontier_key = "frontier" in st
            prior_frontier = {str(x) for x in (st.get("frontier") or []) if x}
            if prior_seen or has_frontier_key:
                seen |= prior_seen
                if has_frontier_key:
                    # Trust saved frontier (may be empty when expansion completed).
                    frontier = set(prior_frontier) - seen
                else:
                    frontier = frontier - seen
                if isinstance(st.get("stats"), dict):
                    for k, v in st["stats"].items():
                        if isinstance(v, int) and k in stats:
                            stats[k] = max(int(stats[k]), v)
                round_idx = int(st.get("round") or 0)
                log(
                    "expand_resume_state",
                    seen=len(seen),
                    frontier=len(frontier),
                    round=round_idx,
                    frontier_from_state=has_frontier_key,
                )
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            pass
    checkpoint_every = max(1, int(checkpoint_every))
    observed_at = utc_now()

    log(
        "expand_start",
        seed_records=len(records),
        frontier=len(frontier),
        bounds=bounds.to_dict(),
        max_rounds=max_rounds,
        topic_keywords=keywords,
        use_semantic_scholar=use_s2,
        source=source_label,
        work_dir=str(work_dir),
    )
    write_expand_checkpoint(
        work_dir,
        collection=collection,
        records=records,
        graph=graph,
        stats=stats,
        bounds=bounds,
        frontier=frontier,
        seen=seen,
        round_idx=0,
        full=True,
    )

    def commit_accept(candidate: dict[str, Any], decision: dict[str, Any]) -> None:
        """Admit a fully-vetted candidate into corpus + frontier."""
        nonlocal records
        rid = str(candidate["record_id"])
        cand_doi = record_doi(candidate)
        if rid in index:
            return
        if cand_doi and cand_doi in doi_index and doi_index[cand_doi] in index:
            return
        candidate = {**candidate, "scope_decision": decision}
        index[rid] = candidate
        records.append(candidate)
        stats["accepted"] += 1
        graph.add_node(
            rid,
            title=_title_of(candidate) or record_title(candidate),
            year=decision.get("year"),
            venue_abbr=(decision.get("venue") or {}).get("abbr") if decision.get("venue") else None,
            in_corpus=True,
        )
        if cand_doi:
            doi_index[cand_doi] = rid
            if cand_doi not in seen:
                frontier.add(cand_doi)

    def flush_llm_buffer() -> None:
        """Run pending expand topic-judge batches and commit acceptances."""
        if llm_buffer is None or not llm_buffer.enabled:
            return
        accepted, rejected = llm_buffer.flush()
        for rec in accepted:
            decision = dict(rec.get("scope_decision") or {})
            tj = rec.get("topic_judgment") or {}
            decision["topic_judge"] = tj
            decision["in_bounds"] = True
            commit_accept(rec, decision)
        for rec in rejected:
            stats["rejected"] += 1
            stats["rejected_topic_judge"] += 1
            rid = str(rec.get("record_id") or "")
            if rid:
                graph.add_node(
                    rid,
                    title=_title_of(rec) or record_title(rec),
                    year=(rec.get("scope_decision") or {}).get("year"),
                    in_corpus=False,
                )
        stats["topic_judge_batches"] = llm_buffer.stats.get("batches", 0)
        stats["topic_judge_cache_hits"] = llm_buffer.stats.get("cache_hits", 0)
        stats["topic_judge_cache_misses"] = llm_buffer.stats.get("cache_misses", 0)

    def accept_candidate(
        candidate: dict[str, Any],
        *,
        seed_doi: str,
        edge_kind: str,
    ) -> None:
        """edge_kind: 'cites_seed' (candidate → seed) or 'seed_cites' (seed → candidate)."""
        nonlocal records
        # Hydrate title/abstract before scope/topic checks (S2 optional).
        before_abs = bool(record_abstract(candidate))
        candidate = enrich_record_text_from_providers(
            candidate,
            observed_at=observed_at,
            use_semantic_scholar=use_s2,
        )
        if not before_abs and record_abstract(candidate):
            stats["hydrated_text"] += 1

        rid = str(candidate["record_id"])
        cand_doi = record_doi(candidate)
        seed_rid = doi_index.get(seed_doi) or f"doi:{seed_doi}"
        if edge_kind == "cites_seed":
            graph.add_edge(rid, seed_rid, "references")
        else:
            graph.add_edge(seed_rid, rid, "references")

        if rid in index:
            before = index[rid]
            merged = merge_records(before, candidate)
            if merged.get("payload", {}).get("dual_source"):
                stats["dual_source_merges"] += 1
            index[rid] = merged
            for i, rec in enumerate(records):
                if rec.get("record_id") == rid:
                    records[i] = merged
                    break
            return

        if cand_doi and cand_doi in doi_index:
            existing_rid = doi_index[cand_doi]
            if existing_rid in index:
                merged = merge_records(index[existing_rid], candidate)
                if merged.get("payload", {}).get("dual_source"):
                    stats["dual_source_merges"] += 1
                index[existing_rid] = merged
                for i, rec in enumerate(records):
                    if rec.get("record_id") == existing_rid:
                        records[i] = merged
                        break
                return

        decision = evaluate_record(
            candidate, bounds=bounds, catalog=catalog, topic_keywords=keywords
        )
        graph.add_node(
            rid,
            title=_title_of(candidate) or record_title(candidate),
            year=decision.get("year"),
            venue_abbr=(decision.get("venue") or {}).get("abbr") if decision.get("venue") else None,
            in_corpus=False,  # only True after LLM (if enabled) or keyword accept
        )
        if not decision["in_bounds"]:
            stats["rejected"] += 1
            reasons = decision.get("reasons") or []
            if any(str(r).startswith("topic_") for r in reasons):
                stats["rejected_topic"] += 1
            return
        candidate = {**candidate, "scope_decision": decision}
        # Optional LLM gate before corpus/frontier admission.
        if llm_buffer is not None and llm_buffer.enabled:
            llm_buffer.enqueue(candidate)
            if llm_buffer.pending_count >= llm_buffer.batch_size:
                flush_llm_buffer()
            return
        commit_accept(candidate, decision)

    while frontier:
        if max_rounds is not None and round_idx >= max_rounds:
            log("expand_stop", reason="max_rounds", round=round_idx)
            break
        round_idx += 1
        stats["rounds"] = round_idx
        batch = [d for d in frontier if d not in seen]
        frontier = set()
        if not batch:
            break
        log("expand_round_start", round=round_idx, queue=len(batch), corpus=len(records))
        accepted_before = stats["accepted"]

        for item_idx, doi in enumerate(batch, start=1):
            seen.add(doi)
            log(
                "expand_item_start",
                round=round_idx,
                index=item_idx,
                total=len(batch),
                corpus=len(records),
                doi=doi,
            )
            stats["dois_fetched"] += 1
            errors = 0

            # Ensure seed node id
            if doi not in doi_index:
                doi_index[doi] = f"doi:{doi}"
                graph.add_node(doi_index[doi], in_corpus=doi_index[doi] in index, title=None)

            # 1–2) S2 graph: paper + citations + references (1 rps, cached).
            s2_got_refs = False
            if use_s2:
                try:
                    citing, s2_refs = fetch_s2_graph(
                        doi,
                        citation_limit=s2_citation_limit,
                        reference_limit=s2_reference_limit,
                    )
                except Exception as error:  # noqa: BLE001
                    log("expand_s2_graph_failed", doi=doi, error=str(error)[:200])
                    citing, s2_refs = [], []
                stats["s2_citation_hits"] += len(citing)
                for paper in citing:
                    if not isinstance(paper, dict):
                        continue
                    rec = s2_paper_to_record(
                        paper, observed_at=observed_at, source_role="citation"
                    )
                    if rec:
                        accept_candidate(rec, seed_doi=doi, edge_kind="cites_seed")
                stats["s2_reference_hits"] += len(s2_refs)
                for paper in s2_refs:
                    if not isinstance(paper, dict):
                        continue
                    rec = s2_paper_to_record(
                        paper, observed_at=observed_at, source_role="reference"
                    )
                    if rec:
                        accept_candidate(rec, seed_doi=doi, edge_kind="seed_cites")
                        s2_got_refs = True

            # 3) Crossref: seed metadata always; outbound refs only if S2 refs empty
            # (avoid dual outbound crawl + S2 paper_batch per seed — main slowness).
            work = fetch_crossref_work(doi)
            if work is None:
                errors += 1
            else:
                seed_rec = crossref_work_to_record(
                    work, observed_at=observed_at, source_role="seed"
                )
                if seed_rec and doi_index.get(doi) in index:
                    index[doi_index[doi]] = merge_records(index[doi_index[doi]], seed_rec)
                if not s2_got_refs:
                    ref_dois = [
                        d for d in crossref_reference_dois(work) if d and d not in seen
                    ]
                    stats["crossref_reference_hits"] += len(ref_dois)
                    # One S2 batch for missing ref metadata (≤100 DOIs / request).
                    s2_by_doi: dict[str, dict[str, Any]] = {}
                    if use_s2 and ref_dois:
                        try:
                            s2 = _load_semantic_scholar()
                            papers = s2.paper_batch(
                                [f"DOI:{d}" for d in ref_dois[:100]],
                                fields=(
                                    "paperId,title,year,abstract,authors,venue,"
                                    "externalIds,url,openAccessPdf,citationCount"
                                ),
                                batch_size=100,
                            )
                            for ref_doi, paper in zip(ref_dois[:100], papers):
                                if isinstance(paper, dict) and paper.get("title"):
                                    s2_by_doi[ref_doi] = paper
                            stats["s2_batch_hits"] = stats.get("s2_batch_hits", 0) + len(
                                s2_by_doi
                            )
                        except Exception as error:  # noqa: BLE001
                            log(
                                "expand_s2_batch_failed",
                                doi=doi,
                                error=str(error)[:200],
                            )
                    for ref_doi in ref_dois[:100]:
                        rec = None
                        if ref_doi in s2_by_doi:
                            rec = s2_paper_to_record(
                                s2_by_doi[ref_doi],
                                observed_at=observed_at,
                                source_role="reference",
                            )
                        if rec is None:
                            ref_work = fetch_crossref_work(ref_doi)
                            time.sleep(0.1)
                            if not ref_work:
                                errors += 1
                                continue
                            rec = crossref_work_to_record(
                                ref_work,
                                observed_at=observed_at,
                                source_role="reference",
                            )
                        if rec:
                            accept_candidate(
                                rec, seed_doi=doi, edge_kind="seed_cites"
                            )

            # Flush LLM batch so this seed's keyword-pass candidates are resolved
            # before the next DOI (and so frontier is accurate for next round).
            flush_llm_buffer()

            if errors:
                stats["fetch_errors"] += errors
            s2_cache = None
            if use_s2:
                try:
                    s2_cache = _load_semantic_scholar().cache_stats()
                except Exception:  # noqa: BLE001
                    s2_cache = None
            log(
                "expand_item_done",
                round=round_idx,
                index=item_idx,
                total=len(batch),
                doi=doi,
                corpus=len(records),
                accepted=stats["accepted"] - accepted_before,
                s2_cache=s2_cache,
                topic_judge=(
                    dict(llm_buffer.stats)
                    if llm_buffer is not None and llm_buffer.enabled
                    else None
                ),
            )
            if item_idx % checkpoint_every == 0 or item_idx == len(batch):
                write_expand_checkpoint(
                    work_dir,
                    collection=collection,
                    records=records,
                    graph=graph,
                    stats=stats,
                    bounds=bounds,
                    frontier=frontier | {d for d in batch[item_idx:] if d not in seen},
                    seen=seen,
                    round_idx=round_idx,
                    full=True,
                )

        flush_llm_buffer()
        accepted_this_round = stats["accepted"] - accepted_before
        log(
            "expand_round_done",
            round=round_idx,
            accepted_this_round=accepted_this_round,
            corpus=len(records),
            frontier_next=len(frontier),
            stats=stats,
        )
        if accepted_this_round == 0 and not frontier:
            break

    flush_llm_buffer()

    for rid in index:
        if rid in graph.nodes:
            graph.nodes[rid]["in_corpus"] = True
    graph_json = work_dir / "literature-graph.json"
    graph_dot = work_dir / "literature-graph.dot"
    graph.write_json(graph_json)
    graph.write_dot(graph_dot)
    output = {
        **collection,
        "records": records,
        "status": collection.get("status") or "candidate_set",
        "literature_expansion": {
            "tool": "literature_expand",
            "generated_at": utc_now(),
            "checkpoint": False,
            "stats": stats,
            "bounds": bounds.to_dict(),
            "topic_keywords": keywords,
            "topic_judge": (
                dict(llm_buffer.stats)
                if llm_buffer is not None and llm_buffer.enabled
                else None
            ),
            "graph_json": str(graph_json),
            "graph_dot": str(graph_dot),
            "record_count": len(records),
            "edge_count": len(graph.edges),
            "node_count": len(graph.nodes),
            "sources": ["crossref", "semantic-scholar"] if use_s2 else ["crossref"],
        },
    }
    out_path = work_dir / "expanded-collection.json"
    _atomic_write_json(out_path, output)
    write_expand_checkpoint(
        work_dir,
        collection=collection,
        records=records,
        graph=graph,
        stats=stats,
        bounds=bounds,
        frontier=set(),
        seen=seen,
        round_idx=round_idx,
        full=True,
    )
    s2_cache_final = None
    if use_s2:
        try:
            s2_cache_final = _load_semantic_scholar().cache_stats()
        except Exception:  # noqa: BLE001
            s2_cache_final = None
    log(
        "expand_done",
        records=len(records),
        edges=len(graph.edges),
        nodes=len(graph.nodes),
        stats=stats,
        s2_cache=s2_cache_final,
        graph_dot=str(graph_dot),
        output=str(out_path),
    )
    return output
