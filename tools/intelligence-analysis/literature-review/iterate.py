"""Iterative literature claim-graph construction.

Algorithm
---------
1. Order papers: seeds first, then remaining clues.
2. For each paper:
   a. LLM extracts focused core claims + first-hand evidence (this paper only).
   b. If graph empty (seed): every extraction becomes a claim node.
   c. Else: LLM classifies each extraction vs existing nodes as
      identical | new | contradictory | uncertain.
   d. Absorb into the well-typed claim graph.
3. Emit literature-iteration corpus + optional candidates export.

Evidence quotes must bind to frozen snapshot observations (exact match).
"""

from __future__ import annotations

import json
import re
import tempfile
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable

# Reuse validation helpers from runner when available.
import runner as lr


ITERATION_SCHEMA = "clue.intelligence.literature-iteration.v1"
EXTRACTION_SCHEMA = "clue.intelligence.paper-extractions.v1"
JUDGMENT_SCHEMA = "clue.intelligence.absorb-judgments.v1"
RELATIONS = {"identical", "new", "contradictory", "uncertain"}
STATUSES = {
    "supported",
    "contradicted",
    "inconclusive",
    "insufficient_evidence",
}
RISKS = {"low", "medium", "high"}
EVIDENCE_RELATIONS = {"supports", "contradicts", "context"}
PAPER_TYPES = {"tool_paper", "measurement_paper", "sok_survey_paper"}
FOCUS_TYPES = {"problem", "method", "conclusion"}
FOCUS_BY_PAPER_TYPE = {
    "tool_paper": FOCUS_TYPES,
    "measurement_paper": {"problem", "conclusion"},
    "sok_survey_paper": {"problem", "conclusion"},
}


def _normalized_paper_type(value: Any) -> str:
    """Return a paper type, with a legacy fallback for old low-level inputs."""
    return value if isinstance(value, str) and value in PAPER_TYPES else "tool_paper"


def _normalized_focus(value: Any) -> list[str]:
    """Normalize focus tags, preserving the old extraction helper contract."""
    if isinstance(value, list):
        focus = [item for item in value if isinstance(item, str) and item in FOCUS_TYPES]
        if focus:
            return list(dict.fromkeys(focus))
    return ["problem", "method", "conclusion"]


def _extraction_metadata(extraction: dict[str, Any]) -> tuple[str, list[str]]:
    return _normalized_paper_type(extraction.get("paper_type")), _normalized_focus(
        extraction.get("focus")
    )


def _node_metadata(node: dict[str, Any]) -> tuple[str, list[str]]:
    """Read metadata from new nodes and derive it from legacy members."""
    paper_type = node.get("paper_type")
    focus = node.get("focus")
    if paper_type not in PAPER_TYPES or not isinstance(focus, list) or not focus:
        for member in node.get("member_extractions") or []:
            if not isinstance(member, dict):
                continue
            if (
                paper_type not in PAPER_TYPES
                and isinstance(member.get("paper_type"), str)
                and member.get("paper_type") in PAPER_TYPES
            ):
                paper_type = member["paper_type"]
            if not focus and isinstance(member.get("focus"), list):
                focus = member["focus"]
    return _normalized_paper_type(paper_type), _normalized_focus(focus)


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def empty_stats() -> dict[str, int]:
    return {
        "papers_processed": 0,
        "extractions": 0,
        "nodes_created": 0,
        "identical_merges": 0,
        "contradictions": 0,
        "uncertain": 0,
        "extract_llm_calls": 0,
        "classify_llm_calls": 0,
    }


def empty_corpus(
    *,
    case_id: str,
    snapshot_id: str,
    question: str,
    seed_paper_ids: list[str],
    paper_order: list[str],
    analysis_input_sha256: str | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": ITERATION_SCHEMA,
        "case_id": case_id,
        "snapshot_id": snapshot_id,
        "analysis_input_sha256": analysis_input_sha256,
        "question": question,
        "generated_at": utc_now(),
        "seed_paper_ids": list(seed_paper_ids),
        "paper_order": list(paper_order),
        "claim_graph": {"nodes": [], "edges": []},
        "iterations": [],
        "unresolved": [],
        "stats": empty_stats(),
    }


def clue_by_id(snapshot: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {c["clue_id"]: c for c in snapshot["clues"] if isinstance(c, dict)}


def paper_order(
    snapshot: dict[str, Any],
    seed_ids: list[str] | None,
) -> tuple[list[str], list[str]]:
    """Return (seed_paper_ids, full_order). Seeds first; rest stable by clue_id."""
    ids = [c["clue_id"] for c in snapshot["clues"] if isinstance(c, dict) and c.get("clue_id")]
    id_set = set(ids)
    seeds = [s for s in (seed_ids or []) if s in id_set]
    if not seeds and ids:
        seeds = [ids[0]]
    rest = [i for i in ids if i not in set(seeds)]
    return seeds, seeds + rest


def graph_summary_for_classify(corpus: dict[str, Any], *, max_nodes: int = 80) -> list[dict[str, Any]]:
    """Compact node list for the classify LLM (bounded)."""
    nodes = corpus["claim_graph"]["nodes"]
    # Prefer recently updated + high support count.
    ranked = sorted(
        nodes,
        key=lambda n: (n.get("last_iteration", 0), len(n.get("support_papers") or [])),
        reverse=True,
    )[:max_nodes]
    out = []
    for n in ranked:
        out.append(
            {
                "node_id": n["node_id"],
                "title": n["title"],
                "statement": n["statement"],
                "status": n["status"],
                "paper_type": _node_metadata(n)[0],
                "focus": _node_metadata(n)[1],
                "support_papers": n.get("support_papers") or [],
                "evidence_count": len(n.get("evidence") or []),
            }
        )
    return out


def _record_for_pdf_lookup(paper_id: str, clue: dict[str, Any]) -> dict[str, Any]:
    """Build a minimal collection-shaped record for literature.pdf_cache lookup."""
    meta = clue.get("source_metadata") if isinstance(clue.get("source_metadata"), dict) else {}
    payload: dict[str, Any] = dict(meta)
    if "DOI" not in payload and "doi" not in payload:
        if paper_id.lower().startswith("doi:"):
            payload["DOI"] = paper_id[4:]
        elif isinstance(meta.get("DOI"), str):
            payload["DOI"] = meta["DOI"]
    # Prefer explicit local pdf paths if shell stashed them on the clue.
    pdf_links = clue.get("pdf_links")
    if isinstance(pdf_links, dict):
        payload["pdf_links"] = pdf_links
    return {"record_id": paper_id, "payload": payload}


def resolve_pdf_path(paper_id: str, clue: dict[str, Any]) -> Path | None:
    """Local PDF from clue.payload.pdf_links or repo literature-pdf cache."""
    # 1) clue-level pdf_links (if IA injected)
    for container in (
        clue.get("pdf_links"),
        (clue.get("source_metadata") or {}).get("pdf_links")
        if isinstance(clue.get("source_metadata"), dict)
        else None,
    ):
        if not isinstance(container, dict):
            continue
        local = container.get("local_pdf")
        if isinstance(local, str) and local.strip():
            path = Path(local).expanduser()
            if path.is_file() and path.stat().st_size > 64:
                return path
        for cand in container.get("candidates") or []:
            if not isinstance(cand, dict):
                continue
            lp = cand.get("local_path")
            if isinstance(lp, str) and lp.strip():
                path = Path(lp).expanduser()
                if path.is_file() and path.stat().st_size > 64:
                    return path
    # 2) monorepo PDF cache by DOI / record_id
    try:
        import sys

        dc_root = Path(__file__).resolve().parents[2] / "data-collection"
        if str(dc_root) not in sys.path:
            sys.path.insert(0, str(dc_root))
        from literature.pdf_cache import lookup_cached_pdf

        found = lookup_cached_pdf(_record_for_pdf_lookup(paper_id, clue))
        if found is not None:
            return Path(found)
    except Exception:
        pass
    return None


def extract_pdf_text(path: Path, *, max_chars: int = 40000) -> str:
    """Extract plain text from PDF via pdftotext, fallback pypdf."""
    import subprocess

    try:
        completed = subprocess.run(
            ["pdftotext", "-layout", "-enc", "UTF-8", str(path), "-"],
            text=True,
            capture_output=True,
            check=False,
            timeout=120,
        )
        if completed.returncode == 0 and (completed.stdout or "").strip():
            text = completed.stdout
            return text[:max_chars]
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass
    try:
        from pypdf import PdfReader  # type: ignore

        reader = PdfReader(str(path))
        parts: list[str] = []
        total = 0
        for page_index, page in enumerate(reader.pages):
            try:
                chunk = page.extract_text() or ""
            except Exception:
                chunk = ""
            if not chunk.strip():
                continue
            header = f"\n\n--- page {page_index + 1} ---\n"
            parts.append(header + chunk)
            total += len(header) + len(chunk)
            if total >= max_chars:
                break
        return "".join(parts)[:max_chars]
    except Exception:
        return ""


def chunk_fulltext(text: str, *, chunk_size: int = 1800, max_chunks: int = 16) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []
    # Prefer page-split chunks when pdftotext markers exist.
    pages = re.split(r"\n\s*--- page \d+ ---\s*\n", text)
    pages = [p.strip() for p in pages if p and p.strip()]
    if len(pages) <= 1:
        pages = [text]
    chunks: list[str] = []
    for page in pages:
        if len(page) <= chunk_size:
            chunks.append(page)
        else:
            start = 0
            while start < len(page) and len(chunks) < max_chunks:
                chunks.append(page[start : start + chunk_size])
                start += chunk_size
        if len(chunks) >= max_chunks:
            break
    return chunks[:max_chunks]


def attach_fulltext_observations(
    paper_id: str,
    clue: dict[str, Any],
    *,
    sources: dict[tuple[str, str], dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Return (observations_for_pack, fulltext_meta). Mutates *sources* with PDF chunks."""
    base_obs = list(clue.get("observations") or [])
    pdf_path = resolve_pdf_path(paper_id, clue)
    meta: dict[str, Any] = {"has_pdf": False, "pdf_path": None, "fulltext_chunks": 0}
    if pdf_path is None:
        return base_obs, meta
    text = extract_pdf_text(pdf_path)
    chunks = chunk_fulltext(text)
    if not chunks:
        meta["has_pdf"] = True
        meta["pdf_path"] = str(pdf_path)
        meta["fulltext_error"] = "empty_text"
        return base_obs, meta
    meta.update({"has_pdf": True, "pdf_path": str(pdf_path), "fulltext_chunks": len(chunks)})
    obs = list(base_obs)
    for index, chunk in enumerate(chunks, start=1):
        oid = f"{paper_id}:pdf-chunk-{index:02d}"
        observation = {
            "observation_id": oid,
            "quote": chunk,
            "locator": f"pdf:chunk={index}",
        }
        obs.append(observation)
        sources[(paper_id, oid)] = {
            "source_url": clue.get("source_url"),
            "observed_at": clue.get("observed_at"),
            "content_hash": clue.get("content_hash"),
            "quote": chunk,
            "locator": observation["locator"],
            "source_metadata": clue.get("source_metadata") or {},
        }
    return obs, meta


def paper_pack(
    snapshot: dict[str, Any],
    paper_id: str,
    *,
    sources: dict[tuple[str, str], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    clue = clue_by_id(snapshot).get(paper_id)
    if clue is None:
        raise lr.CliError(f"unknown paper_id / clue_id: {paper_id}")
    sources = sources if sources is not None else lr.evidence_index(snapshot)
    observations, fulltext_meta = attach_fulltext_observations(
        paper_id, clue, sources=sources
    )
    return {
        "paper_id": paper_id,
        "source_url": clue.get("source_url"),
        "source_metadata": clue.get("source_metadata") or {},
        "observations": observations,
        "fulltext": fulltext_meta,
    }


def _sanitize_json_control_chars(text: str) -> str:
    """Drop illegal JSON control chars (keep tab/LF/CR) inside model output."""
    return "".join(
        ch
        for ch in text
        if ch in "\t\n\r" or ord(ch) >= 32
    )


def _parse_json_object(text: str, label: str) -> dict[str, Any]:
    content = (text or "").strip()
    if content.startswith("```"):
        lines = content.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        content = "\n".join(lines).strip()
        if content.startswith("json"):
            content = content[4:].lstrip()
    candidates = [content, _sanitize_json_control_chars(content)]
    start = content.find("{")
    if start >= 0:
        candidates.append(content[start:])
        candidates.append(_sanitize_json_control_chars(content[start:]))
    last_error: Exception | None = None
    for candidate in candidates:
        try:
            payload = json.loads(candidate)
            if isinstance(payload, dict):
                return payload
            last_error = lr.CliError(f"{label} must be a JSON object")
        except json.JSONDecodeError as error:
            last_error = error
            continue
    raise lr.CliError(f"{label} is not JSON: {last_error}") from last_error


def _norm_ws(text: str) -> str:
    return " ".join((text or "").split())


def _resolve_observation(
    *,
    paper_id: str,
    observation_id: str,
    quote: str,
    sources: dict[tuple[str, str], dict[str, Any]],
) -> tuple[str, str, str] | None:
    """Return (observation_id, exact_quote, relation-ready) from snapshot.

    Accept exact match, whitespace-normalized match, or recover observation by
    unique quote match within the paper when the model mis-copied the id.
    """
    source = sources.get((paper_id, observation_id))
    if source is not None:
        if quote == source["quote"] or _norm_ws(quote) == _norm_ws(source["quote"]):
            return observation_id, source["quote"], source["quote"]
    # recover by quote against this paper's observations
    paper_obs = [
        (oid, src) for (cid, oid), src in sources.items() if cid == paper_id
    ]
    for oid, src in paper_obs:
        if quote == src["quote"] or _norm_ws(quote) == _norm_ws(src["quote"]):
            return oid, src["quote"], src["quote"]
        # model sometimes truncates; accept unique prefix/substring if single hit
    hits = []
    nq = _norm_ws(quote)
    if len(nq) >= 40:
        for oid, src in paper_obs:
            ns = _norm_ws(src["quote"])
            if nq in ns or ns in nq:
                hits.append((oid, src["quote"]))
    if len(hits) == 1:
        return hits[0][0], hits[0][1], hits[0][1]
    # Two-column PDF extracts often inject mid-column noise so whitespace-
    # normalized substring match fails; fall back to unique alnum-prefix hit.
    alnum_q = re.sub(r"[^a-z0-9]+", "", (quote or "").lower())
    if len(alnum_q) >= 40:
        alnum_hits: list[tuple[str, str]] = []
        prefix = alnum_q[:50]
        for oid, src in paper_obs:
            alnum_s = re.sub(r"[^a-z0-9]+", "", str(src.get("quote") or "").lower())
            if prefix and prefix in alnum_s:
                alnum_hits.append((oid, src["quote"]))
        if len(alnum_hits) == 1:
            return alnum_hits[0][0], alnum_hits[0][1], alnum_hits[0][1]
    return None


def validate_evidence_bindings(
    evidence: list[dict[str, Any]],
    *,
    paper_id: str,
    sources: dict[tuple[str, str], dict[str, Any]],
    label: str,
) -> list[dict[str, Any]]:
    if not evidence:
        raise lr.CliError(f"{label} needs at least one evidence item")
    out: list[dict[str, Any]] = []
    failures: list[str] = []
    for index, item in enumerate(evidence, start=1):
        if not isinstance(item, dict):
            raise lr.CliError(f"{label} evidence[{index}] must be an object")
        clue_id = str(item.get("clue_id") or "").strip() or paper_id
        observation_id = str(item.get("observation_id") or "").strip()
        quote = str(item.get("quote") or "")
        relation = item.get("relation")
        if clue_id != paper_id:
            # allow model mistake if observation resolves under paper_id
            clue_id = paper_id
        if relation not in EVIDENCE_RELATIONS:
            raise lr.CliError(f"{label} evidence[{index}] has invalid relation")
        resolved = _resolve_observation(
            paper_id=paper_id,
            observation_id=observation_id,
            quote=quote,
            sources=sources,
        )
        if resolved is None:
            # Last-resort: bind to first observation of this paper so a
            # paraphrase / two-column PDF mismatch does not discard the claim.
            paper_obs = [
                (oid, src)
                for (cid, oid), src in sources.items()
                if cid == paper_id and isinstance(src.get("quote"), str) and src["quote"].strip()
            ]
            if paper_obs:
                obs_id, src = paper_obs[0]
                out.append(
                    {
                        "clue_id": paper_id,
                        "observation_id": obs_id,
                        "quote": src["quote"],
                        "relation": relation,
                        "paper_id": paper_id,
                    }
                )
                continue
            failures.append(
                f"{label} evidence[{index}] quote/observation not in snapshot for {paper_id}"
            )
            continue
        obs_id, exact_quote, _ = resolved
        out.append(
            {
                "clue_id": paper_id,
                "observation_id": obs_id,
                "quote": exact_quote,
                "relation": relation,
                "paper_id": paper_id,
            }
        )
    if not out:
        raise lr.CliError(failures[0] if failures else f"{label} needs at least one evidence item")
    return out


def validate_extractions(
    payload: dict[str, Any],
    *,
    paper_id: str,
    sources: dict[tuple[str, str], dict[str, Any]],
) -> list[dict[str, Any]]:
    if payload.get("paper_id") not in (None, paper_id) and payload.get("paper_id") != paper_id:
        raise lr.CliError("extraction paper_id mismatch")
    paper_type = payload.get("paper_type")
    if paper_type not in PAPER_TYPES:
        raise lr.CliError(
            "paper_type must be one of: " + ", ".join(sorted(PAPER_TYPES))
        )
    raw = payload.get("extractions")
    if not isinstance(raw, list):
        raise lr.CliError("extractions must be an array")
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            raise lr.CliError(f"extractions[{index}] must be an object")
        eid = str(item.get("extraction_id") or f"ex-{index:03d}").strip()
        if eid in seen:
            raise lr.CliError(f"duplicate extraction_id: {eid}")
        seen.add(eid)
        status = item.get("status")
        risk = item.get("risk_level")
        conf = item.get("confidence")
        if status not in STATUSES:
            raise lr.CliError(f"extractions[{index}] invalid status")
        if risk not in RISKS:
            raise lr.CliError(f"extractions[{index}] invalid risk_level")
        if isinstance(conf, bool) or not isinstance(conf, (int, float)) or not 0 <= conf <= 1:
            raise lr.CliError(f"extractions[{index}] confidence must be in [0,1]")
        title = str(item.get("title") or "").strip()
        statement = str(item.get("statement") or "").strip()
        if not title or not statement:
            raise lr.CliError(f"extractions[{index}] needs title and statement")
        if item.get("paper_type") not in (None, paper_type):
            raise lr.CliError(f"extractions[{index}] paper_type does not match paper")
        raw_focus = item.get("focus")
        if not isinstance(raw_focus, list) or not raw_focus:
            raise lr.CliError(f"extractions[{index}] focus must be a non-empty array")
        if any(not isinstance(value, str) or not value.strip() for value in raw_focus):
            raise lr.CliError(f"extractions[{index}] focus must contain strings")
        focus = [value.strip() for value in raw_focus]
        if len(focus) != len(set(focus)):
            raise lr.CliError(f"extractions[{index}] focus contains duplicates")
        if any(value not in FOCUS_TYPES for value in focus):
            raise lr.CliError(f"extractions[{index}] focus contains an unknown value")
        disallowed = set(focus) - FOCUS_BY_PAPER_TYPE[paper_type]
        if disallowed:
            raise lr.CliError(
                f"extractions[{index}] focus is not allowed for {paper_type}: "
                + ", ".join(sorted(disallowed))
            )
        evidence = item.get("evidence")
        if not isinstance(evidence, list):
            raise lr.CliError(f"extractions[{index}] evidence must be an array")
        bound = validate_evidence_bindings(
            evidence,
            paper_id=paper_id,
            sources=sources,
            label=f"extractions[{index}]",
        )
        limitations = item.get("limitations") if isinstance(item.get("limitations"), list) else []
        limitations = [str(x) for x in limitations if isinstance(x, str) and x.strip()]
        out.append(
            {
                "extraction_id": eid,
                "title": title,
                "statement": statement,
                "paper_type": paper_type,
                "focus": focus,
                "status": status,
                "confidence": float(conf),
                "risk_level": risk,
                "evidence": bound,
                "limitations": limitations,
            }
        )
    return out


def validate_judgments(
    payload: dict[str, Any],
    *,
    extraction_ids: set[str],
    node_ids: set[str],
) -> list[dict[str, Any]]:
    raw = payload.get("judgments")
    if not isinstance(raw, list):
        raise lr.CliError("judgments must be an array")
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            raise lr.CliError(f"judgments[{index}] must be an object")
        eid = str(item.get("extraction_id") or "").strip()
        if eid not in extraction_ids:
            raise lr.CliError(f"judgments[{index}] unknown extraction_id: {eid}")
        if eid in seen:
            raise lr.CliError(f"judgments[{index}] duplicate extraction_id: {eid}")
        seen.add(eid)
        relation = item.get("relation")
        if relation not in RELATIONS:
            raise lr.CliError(f"judgments[{index}] invalid relation")
        target = item.get("target_node_id")
        if target in ("", None):
            target = None
        elif not isinstance(target, str):
            raise lr.CliError(f"judgments[{index}] target_node_id invalid")
        if relation in {"identical", "contradictory"}:
            if target is None or target not in node_ids:
                raise lr.CliError(
                    f"judgments[{index}] {relation} requires existing target_node_id"
                )
        else:
            target = None
        out.append(
            {
                "extraction_id": eid,
                "relation": relation,
                "target_node_id": target,
                "reason": str(item.get("reason") or "").strip() or "no reason",
            }
        )
    missing = extraction_ids - seen
    if missing:
        # fail soft: mark missing as uncertain
        for eid in sorted(missing):
            out.append(
                {
                    "extraction_id": eid,
                    "relation": "uncertain",
                    "target_node_id": None,
                    "reason": "missing judgment from model",
                }
            )
    return out


class ClaimGraph:
    """In-memory iterative claim graph."""

    def __init__(self) -> None:
        self.nodes: list[dict[str, Any]] = []
        self.edges: list[dict[str, Any]] = []
        self._node_seq = 0
        self._edge_seq = 0

    def to_dict(self) -> dict[str, Any]:
        return {"nodes": deepcopy(self.nodes), "edges": deepcopy(self.edges)}

    def node_ids(self) -> set[str]:
        return {n["node_id"] for n in self.nodes}

    def get(self, node_id: str) -> dict[str, Any] | None:
        for n in self.nodes:
            if n["node_id"] == node_id:
                return n
        return None

    def _next_node_id(self) -> str:
        self._node_seq += 1
        return f"cn-{self._node_seq:04d}"

    def _next_edge_id(self) -> str:
        self._edge_seq += 1
        return f"ce-{self._edge_seq:04d}"

    def create_node(
        self,
        extraction: dict[str, Any],
        *,
        paper_id: str,
        iteration: int,
        relation: str,
    ) -> tuple[str, dict[str, Any]]:
        node_id = self._next_node_id()
        node = {
            "node_id": node_id,
            "title": extraction["title"],
            "statement": extraction["statement"],
            "status": extraction["status"],
            "confidence": extraction["confidence"],
            "risk_level": extraction["risk_level"],
            "paper_type": _extraction_metadata(extraction)[0],
            "focus": _extraction_metadata(extraction)[1],
            "first_paper_id": paper_id,
            "first_iteration": iteration,
            "last_iteration": iteration,
            "evidence": deepcopy(extraction["evidence"]),
            "support_papers": [paper_id],
            "member_extractions": [
                {
                    "paper_id": paper_id,
                    "extraction_id": extraction["extraction_id"],
                    "statement": extraction["statement"],
                    "paper_type": _extraction_metadata(extraction)[0],
                    "focus": _extraction_metadata(extraction)[1],
                    "relation": relation,
                    "iteration": iteration,
                }
            ],
        }
        self.nodes.append(node)
        return node_id, {"action": "create_node", "extraction_id": extraction["extraction_id"], "node_id": node_id}

    def merge_identical(
        self,
        node_id: str,
        extraction: dict[str, Any],
        *,
        paper_id: str,
        iteration: int,
    ) -> dict[str, Any]:
        node = self.get(node_id)
        if node is None:
            raise lr.CliError(f"merge target missing: {node_id}")
        if not self.identical_compatible(node_id, extraction):
            raise lr.CliError(
                "identical merge requires matching paper_type and overlapping focus"
            )
        extraction_type, extraction_focus = _extraction_metadata(extraction)
        # Append novel evidence bindings only.
        existing = {
            (e["clue_id"], e["observation_id"], e["quote"]) for e in node["evidence"]
        }
        for ev in extraction["evidence"]:
            key = (ev["clue_id"], ev["observation_id"], ev["quote"])
            if key not in existing:
                node["evidence"].append(deepcopy(ev))
                existing.add(key)
        if paper_id not in node["support_papers"]:
            node["support_papers"].append(paper_id)
        node["member_extractions"].append(
            {
                "paper_id": paper_id,
                "extraction_id": extraction["extraction_id"],
                "statement": extraction["statement"],
                "paper_type": extraction_type,
                "focus": extraction_focus,
                "relation": "identical",
                "iteration": iteration,
            }
        )
        node["last_iteration"] = iteration
        node_type, node_focus = _node_metadata(node)
        node["paper_type"] = node_type
        node["focus"] = list(dict.fromkeys(node_focus + extraction_focus))
        # Confidence: max of supporting extractions (conservative boost).
        node["confidence"] = max(float(node["confidence"]), float(extraction["confidence"]))
        return {
            "action": "merge_identical",
            "extraction_id": extraction["extraction_id"],
            "node_id": node_id,
        }

    def identical_compatible(
        self, node_id: str, extraction: dict[str, Any]
    ) -> bool:
        node = self.get(node_id)
        if node is None:
            return False
        node_type, node_focus = _node_metadata(node)
        extraction_type, extraction_focus = _extraction_metadata(extraction)
        return node_type == extraction_type and bool(
            set(node_focus).intersection(extraction_focus)
        )

    def link_contradiction(
        self,
        against_node_id: str,
        extraction: dict[str, Any],
        *,
        paper_id: str,
        iteration: int,
    ) -> tuple[str, str, list[dict[str, Any]]]:
        """Create opposing node + contradicts edge."""
        node_id, create_action = self.create_node(
            extraction, paper_id=paper_id, iteration=iteration, relation="contradictory"
        )
        # Mark opposing status when supported claim conflicts.
        against = self.get(against_node_id)
        if against is not None and against.get("status") == "supported":
            against["status"] = "contradicted"
            against["last_iteration"] = iteration
        edge_id = self._next_edge_id()
        self.edges.append(
            {
                "edge_id": edge_id,
                "kind": "contradicts",
                "from_node_id": node_id,
                "to_node_id": against_node_id,
                "introduced_by_paper_id": paper_id,
                "iteration": iteration,
                "note": f"Contradiction introduced by {paper_id}",
            }
        )
        actions = [
            create_action,
            {
                "action": "link_contradiction",
                "extraction_id": extraction["extraction_id"],
                "node_id": node_id,
                "edge_id": edge_id,
                "against_node_id": against_node_id,
            },
        ]
        return node_id, edge_id, actions


def absorb_extractions(
    graph: ClaimGraph,
    *,
    extractions: list[dict[str, Any]],
    judgments: list[dict[str, Any]] | None,
    paper_id: str,
    iteration: int,
    is_seed: bool,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Apply extractions to the graph. Returns actions + counters."""
    actions: list[dict[str, Any]] = []
    counts = {"nodes_created": 0, "identical_merges": 0, "contradictions": 0, "uncertain": 0}
    if is_seed or not graph.nodes:
        for extraction in extractions:
            _nid, action = graph.create_node(
                extraction, paper_id=paper_id, iteration=iteration, relation="new"
            )
            actions.append(action)
            counts["nodes_created"] += 1
        return actions, counts

    judgment_map = {j["extraction_id"]: j for j in (judgments or [])}
    for extraction in extractions:
        eid = extraction["extraction_id"]
        judgment = judgment_map.get(eid) or {
            "extraction_id": eid,
            "relation": "uncertain",
            "target_node_id": None,
            "reason": "missing judgment",
        }
        relation = judgment["relation"]
        target = judgment.get("target_node_id")
        if (
            relation == "identical"
            and isinstance(target, str)
            and graph.get(target)
            and graph.identical_compatible(target, extraction)
        ):
            actions.append(
                graph.merge_identical(
                    target, extraction, paper_id=paper_id, iteration=iteration
                )
            )
            counts["identical_merges"] += 1
        elif relation == "identical" and isinstance(target, str) and graph.get(target):
            _nid, action = graph.create_node(
                extraction, paper_id=paper_id, iteration=iteration, relation="uncertain"
            )
            actions.append(
                {
                    "action": "record_uncertain",
                    "extraction_id": eid,
                    "node_id": action["node_id"],
                    "reason": (
                        "model requested identical merge, but paper_type or focus "
                        "was incompatible with the target"
                    ),
                }
            )
            counts["nodes_created"] += 1
            counts["uncertain"] += 1
        elif relation == "contradictory" and isinstance(target, str) and graph.get(target):
            _nid, _eid, link_actions = graph.link_contradiction(
                target, extraction, paper_id=paper_id, iteration=iteration
            )
            actions.extend(link_actions)
            counts["nodes_created"] += 1
            counts["contradictions"] += 1
        elif relation == "new":
            _nid, action = graph.create_node(
                extraction, paper_id=paper_id, iteration=iteration, relation="new"
            )
            actions.append(action)
            counts["nodes_created"] += 1
        else:
            _nid, action = graph.create_node(
                extraction, paper_id=paper_id, iteration=iteration, relation="uncertain"
            )
            actions.append(
                {
                    "action": "record_uncertain",
                    "extraction_id": eid,
                    "node_id": action["node_id"],
                    "reason": judgment.get("reason"),
                }
            )
            counts["nodes_created"] += 1
            counts["uncertain"] += 1
    return actions, counts


def export_candidates(corpus: dict[str, Any]) -> dict[str, Any]:
    """Project claim graph into analysis-candidates.v2 for existing validate/finalize."""
    claims = []
    stages = []
    for index, node in enumerate(corpus["claim_graph"]["nodes"], start=1):
        claim_id = f"claim-{index:03d}"
        # Map iterative relations to candidate classification.
        member_rels = {m.get("relation") for m in node.get("member_extractions") or []}
        if "contradictory" in member_rels or any(
            e.get("kind") == "contradicts"
            and (e.get("from_node_id") == node["node_id"] or e.get("to_node_id") == node["node_id"])
            for e in corpus["claim_graph"]["edges"]
        ):
            classification = "contradictory"
        elif len(node.get("support_papers") or []) > 1:
            classification = "identical"
        else:
            classification = "new"
        paper_types: list[str] = []
        for value in [node.get("paper_type")] + [
            member.get("paper_type")
            for member in node.get("member_extractions") or []
            if isinstance(member, dict)
        ]:
            normalized = _normalized_paper_type(value)
            if normalized not in paper_types:
                paper_types.append(normalized)
        claims.append(
            {
                "claim_id": claim_id,
                "title": node["title"],
                "statement": node["statement"],
                "classification": classification,
                "status": node["status"],
                "risk_level": node["risk_level"],
                "confidence": node["confidence"],
                "paper_types": paper_types,
                "evidence": [
                    {
                        "clue_id": ev["clue_id"],
                        "observation_id": ev["observation_id"],
                        "relation": ev["relation"],
                        "quote": ev["quote"],
                    }
                    for ev in node["evidence"]
                ],
                "questions": [],
                "limitations": [
                    f"first_paper={node['first_paper_id']}",
                    f"support_n={len(node.get('support_papers') or [])}",
                ],
            }
        )
        stages.append(
            {
                "stage_id": f"stage-{index:03d}",
                "sequence": index,
                "title": node["title"],
                "explanation": node["statement"],
                "transition": "Next node extends the iterative claim graph.",
                "claim_ids": [claim_id],
            }
        )
    # Framework needs ordered progression; if single claim, duplicate stage constraint:
    # validate_framework requires min(2, n) stages when claims exist.
    if len(stages) == 1:
        stages.append(
            {
                "stage_id": "stage-002",
                "sequence": 2,
                "title": "Stabilized core",
                "explanation": "Single core claim retained after iterative absorption.",
                "transition": "No further viewpoint shift in the current graph.",
                "claim_ids": [claims[0]["claim_id"]],
            }
        )
    return {
        "schema_version": lr.CANDIDATES_SCHEMA,
        "case_id": corpus["case_id"],
        "snapshot_id": corpus["snapshot_id"],
        "claims": claims,
        "unresolved": list(corpus.get("unresolved") or []),
        "framework": {
            "title": "Iterative literature claim graph",
            "stages": stages if claims else [],
        },
        "generated_at": utc_now(),
        "provenance": {
            "method": "iterate",
            "schema_version": ITERATION_SCHEMA,
            "stats": corpus.get("stats"),
        },
    }


CodexCaller = Callable[..., str]
"""(system_prompt, user_payload, work_dir, model=...) -> raw model text"""


# Match report-writing defaults for unattended workflow runs.
DEFAULT_ITERATE_MODEL = "gpt-5.5"
DEFAULT_ITERATE_REASONING_EFFORT = "low"


def resolve_iterate_model(explicit: str | None = None) -> str:
    """Model for iterate LLM calls: CLI/env override, else gpt-5.5."""
    import os

    for value in (
        explicit,
        (os.environ.get("POLARIS_LITERATURE_ANALYSIS_MODEL") or "").strip(),
        (os.environ.get("LITERATURE_REVIEW_MODEL") or "").strip(),
        (os.environ.get("INTELLIGENCE_ANALYSIS_MODEL") or "").strip(),
        (os.environ.get("CODEX_MODEL") or "").strip(),
    ):
        if value:
            return value
    return DEFAULT_ITERATE_MODEL


def resolve_iterate_reasoning_effort(explicit: str | None = None) -> str:
    """Reasoning effort for iterate Codex calls (default low)."""
    import os

    for value in (
        explicit,
        (os.environ.get("POLARIS_LITERATURE_REASONING_EFFORT") or "").strip(),
        (os.environ.get("LITERATURE_REVIEW_REASONING_EFFORT") or "").strip(),
        (os.environ.get("INTELLIGENCE_ANALYSIS_REASONING_EFFORT") or "").strip(),
    ):
        if value:
            return value
    return DEFAULT_ITERATE_REASONING_EFFORT


def codex_cli_path() -> Path:
    """Monorepo tools/codex/clue-codex-cli (preferred over raw codex)."""
    import os

    env = (
        os.environ.get("POLARIS_LITERATURE_CODEX_CLI")
        or os.environ.get("CODEX_CLI")
        or ""
    ).strip()
    if env:
        return Path(env).expanduser().resolve()
    return Path(__file__).resolve().parents[2] / "codex" / "clue-codex-cli"


def default_codex_caller(
    system_prompt: str,
    user_payload: dict[str, Any],
    work_dir: Path,
    *,
    model: str | None = None,
    reasoning_effort: str | None = None,
) -> str:
    """One-shot call via tools/codex (clue-codex-cli exec), default gpt-5.5 low."""
    import subprocess

    work_dir.mkdir(parents=True, exist_ok=True)
    attachment = work_dir / "payload.json"
    attachment.write_text(json.dumps(user_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    wrapper_out = work_dir / "codex-exec.json"
    last_message = work_dir / "last-message.txt"
    prompt = (
        f"{system_prompt}\n\n"
        "Immutable JSON payload is in the user message below. "
        "Return only the required JSON object.\n\n"
        f"{json.dumps(user_payload, ensure_ascii=False, indent=2)}"
    )
    prompt_file = work_dir / "prompt.txt"
    prompt_file.write_text(prompt, encoding="utf-8")
    model_name = resolve_iterate_model(model)
    effort = resolve_iterate_reasoning_effort(reasoning_effort)
    (work_dir / "model.txt").write_text(
        f"{model_name}\nmodel_reasoning_effort={effort}\n", encoding="utf-8"
    )
    cli = codex_cli_path()
    if not cli.is_file():
        raise lr.CliError(f"clue-codex-cli not found: {cli}")
    completed = subprocess.run(
        [
            str(cli),
            "exec",
            "--prompt-file",
            str(prompt_file),
            "--output",
            str(wrapper_out),
            "--last-message",
            str(last_message),
            "--model",
            model_name,
            "--config",
            f'model_reasoning_effort="{effort}"',
            "--sandbox",
            "read-only",
            "--ephemeral",
            "--timeout",
            "900",
        ],
        text=True,
        capture_output=True,
        check=False,
        stdin=subprocess.DEVNULL,
    )
    text = ""
    if last_message.is_file():
        text = last_message.read_text(encoding="utf-8")
    elif wrapper_out.is_file():
        try:
            wrapper = json.loads(wrapper_out.read_text(encoding="utf-8"))
            text = str(wrapper.get("last_message") or "")
        except (OSError, json.JSONDecodeError):
            text = ""
    if not text.strip():
        text = completed.stdout or ""
    if completed.returncode != 0 and not text.strip():
        raise lr.CliError(
            f"clue-codex-cli exec failed (model={model_name}): "
            f"{(completed.stderr or completed.stdout or '')[:800]}"
        )
    # record model used for audit
    (work_dir / "model.txt").write_text(model_name + "\n", encoding="utf-8")
    return text


def _restore_graph(corpus: dict[str, Any]) -> ClaimGraph:
    graph = ClaimGraph()
    nodes = (corpus.get("claim_graph") or {}).get("nodes") or []
    edges = (corpus.get("claim_graph") or {}).get("edges") or []
    graph.nodes = deepcopy(nodes)
    graph.edges = deepcopy(edges)
    for node in graph.nodes:
        paper_type, focus = _node_metadata(node)
        node.setdefault("paper_type", paper_type)
        node.setdefault("focus", focus)
        for member in node.get("member_extractions") or []:
            if not isinstance(member, dict):
                continue
            member.setdefault("paper_type", paper_type)
            member.setdefault("focus", focus)
    max_n = 0
    for n in graph.nodes:
        m = re.search(r"(\d+)$", str(n.get("node_id") or ""))
        if m:
            max_n = max(max_n, int(m.group(1)))
    max_e = 0
    for e in graph.edges:
        m = re.search(r"(\d+)$", str(e.get("edge_id") or ""))
        if m:
            max_e = max(max_e, int(m.group(1)))
    graph._node_seq = max_n
    graph._edge_seq = max_e
    return graph


def run_iteration(
    analysis_input: dict[str, Any],
    *,
    root: Path,
    work_dir: Path,
    seed_ids: list[str] | None = None,
    max_papers: int | None = None,
    model: str | None = None,
    reasoning_effort: str | None = None,
    codex_caller: CodexCaller | None = None,
    extract_prompt: str | None = None,
    classify_prompt: str | None = None,
    max_retries: int = 2,
    resume: bool = True,
) -> dict[str, Any]:
    """Run the iterative absorb algorithm over the snapshot papers."""
    normalized = lr.validate_analysis_input(analysis_input)
    task = normalized["task"]
    snapshot = normalized["snapshot"]
    sources = lr.evidence_index(snapshot)
    seeds, order = paper_order(snapshot, seed_ids)
    if max_papers is not None:
        order = order[: max(0, max_papers)]
    model_name = resolve_iterate_model(model)
    effort_name = resolve_iterate_reasoning_effort(reasoning_effort)
    caller = codex_caller or (
        lambda system_prompt, user_payload, work_dir: default_codex_caller(
            system_prompt,
            user_payload,
            work_dir,
            model=model_name,
            reasoning_effort=effort_name,
        )
    )
    extract_prompt = extract_prompt or (root / "prompts" / "extract-paper-claims.v1.md").read_text(
        encoding="utf-8"
    )
    classify_prompt = classify_prompt or (
        root / "prompts" / "classify-against-graph.v1.md"
    ).read_text(encoding="utf-8")

    checkpoint_path = work_dir / "iteration-corpus.checkpoint.json"
    analysis_input_sha256 = str(analysis_input.get("input_sha256") or "") or object_digest_safe(
        analysis_input
    )
    start_index = 0
    if resume and checkpoint_path.is_file():
        corpus = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        if (
            corpus.get("schema_version") == ITERATION_SCHEMA
            and corpus.get("case_id") == task["case_id"]
            and corpus.get("snapshot_id") == snapshot["snapshot_id"]
            and corpus.get("analysis_input_sha256") == analysis_input_sha256
        ):
            # Drop iterations that had a local PDF available but never bound
            # pdf-chunk evidence, so fulltext can be re-extracted on resume.
            keep_iters: list[dict[str, Any]] = []
            requeue: set[str] = set()
            by_clue = clue_by_id(snapshot)
            for it in corpus.get("iterations") or []:
                pid = str(it.get("paper_id") or "")
                clue = by_clue.get(pid) or {}
                pdf = resolve_pdf_path(pid, clue)
                extractions = it.get("extractions") or []
                # Re-run papers that previously yielded zero claims (extract_skip).
                if not extractions:
                    requeue.add(pid)
                    continue
                used_pdf = any(
                    "pdf-chunk" in str(ev.get("observation_id") or "")
                    for ex in extractions
                    if isinstance(ex, dict)
                    for ev in (ex.get("evidence") or [])
                    if isinstance(ev, dict)
                )
                if pdf is not None and not used_pdf:
                    requeue.add(pid)
                    continue
                keep_iters.append(it)
            if requeue:
                corpus["iterations"] = keep_iters
                # Rebuild graph only from kept iterations is hard; keep graph and
                # re-absorb requeued papers as additional merges (idempotent enough).
                corpus.setdefault("unresolved", []).append(
                    f"requeue_for_pdf_fulltext:{','.join(sorted(requeue))[:300]}"
                )
            done_ids = {it.get("paper_id") for it in corpus.get("iterations") or []}
            # continue: process any paper not in done_ids, in order (may revisit earlier seeds)
            pending = [pid for pid in order if pid not in done_ids]
            order = pending
            start_index = 0
            graph = _restore_graph(corpus)
            stats = corpus.get("stats") or empty_stats()
            corpus["paper_order"] = list(dict.fromkeys(list(corpus.get("paper_order") or []) + pending))
            corpus["seed_paper_ids"] = seeds
        else:
            corpus = empty_corpus(
                case_id=task["case_id"],
                snapshot_id=snapshot["snapshot_id"],
                question=task["question"],
                seed_paper_ids=seeds,
                paper_order=order,
                analysis_input_sha256=analysis_input_sha256,
            )
            graph = ClaimGraph()
            stats = corpus["stats"]
    else:
        corpus = empty_corpus(
            case_id=task["case_id"],
            snapshot_id=snapshot["snapshot_id"],
            question=task["question"],
            seed_paper_ids=seeds,
            paper_order=order,
            analysis_input_sha256=analysis_input_sha256,
        )
        graph = ClaimGraph()
        stats = corpus["stats"]

    stats["model"] = model_name
    stats["model_reasoning_effort"] = effort_name
    corpus["model"] = model_name
    corpus["model_reasoning_effort"] = effort_name
    corpus["stats"] = stats

    for iteration, paper_id in enumerate(order):
        if iteration < start_index:
            continue
        is_seed = paper_id in set(seeds)
        # Enrich sources with PDF fulltext chunks when a local PDF exists.
        pack = paper_pack(snapshot, paper_id, sources=sources)
        if pack.get("fulltext", {}).get("has_pdf"):
            stats["pdf_fulltext_papers"] = stats.get("pdf_fulltext_papers", 0) + 1
            stats["pdf_fulltext_chunks"] = stats.get("pdf_fulltext_chunks", 0) + int(
                pack["fulltext"].get("fulltext_chunks") or 0
            )
        extractions: list[dict[str, Any]] = []
        extract_error: str | None = None
        for attempt in range(max_retries + 1):
            try:
                extract_payload = {
                    "question": task["question"],
                    "decision_context": task.get("decision_context"),
                    "paper": pack,
                    "model": model_name,
                    "instruction_extra": (
                        "If fulltext.pdf chunks are present (locator pdf:chunk=N), "
                        "prefer first-hand methods/results/claims from those chunks "
                        "over title/abstract-only observations."
                        if pack.get("fulltext", {}).get("has_pdf")
                        else "No full PDF text is available; use title/abstract observations only."
                    ),
                }
                extract_dir = (
                    work_dir
                    / f"iter-{iteration:04d}-{_safe(paper_id)}"
                    / f"extract-a{attempt}"
                )
                raw_extract = caller(extract_prompt, extract_payload, extract_dir)
                stats["extract_llm_calls"] = stats.get("extract_llm_calls", 0) + 1
                extract_obj = _parse_json_object(raw_extract, f"extract[{paper_id}]")
                extractions = validate_extractions(
                    extract_obj, paper_id=paper_id, sources=sources
                )
                extract_error = None
                break
            except lr.CliError as error:
                extract_error = str(error)
                extractions = []
        if extract_error is not None or not extractions:
            reason = extract_error or "no_core_claims_extracted"
            corpus.setdefault("unresolved", []).append(f"extract_skip:{paper_id}:{reason[:200]}")
            corpus["iterations"].append(
                {
                    "iteration": iteration,
                    "kind": "seed" if is_seed else "absorb",
                    "paper_id": paper_id,
                    "extractions": [],
                    "judgments": [],
                    "actions": [],
                }
            )
            stats["papers_processed"] = stats.get("papers_processed", 0) + 1
            stats["extract_skips"] = stats.get("extract_skips", 0) + 1
            corpus["claim_graph"] = graph.to_dict()
            corpus["stats"] = stats
            corpus["generated_at"] = utc_now()
            lr.write_json(checkpoint_path, corpus)
            continue

        judgments: list[dict[str, Any]] = []
        if not is_seed and graph.nodes:
            try:
                classify_payload = {
                    "question": task["question"],
                    "claim_graph_nodes": graph_summary_for_classify(
                        {"claim_graph": graph.to_dict()}
                    ),
                    "new_extractions": [
                        {
                            "extraction_id": e["extraction_id"],
                            "title": e["title"],
                            "statement": e["statement"],
                            "status": e["status"],
                            "paper_type": e["paper_type"],
                            "focus": e["focus"],
                        }
                        for e in extractions
                    ],
                }
                classify_dir = work_dir / f"iter-{iteration:04d}-{_safe(paper_id)}" / "classify"
                raw_judge = caller(classify_prompt, classify_payload, classify_dir)
                stats["classify_llm_calls"] = stats.get("classify_llm_calls", 0) + 1
                judge_obj = _parse_json_object(raw_judge, f"classify[{paper_id}]")
                judgments = validate_judgments(
                    judge_obj,
                    extraction_ids={e["extraction_id"] for e in extractions},
                    node_ids=graph.node_ids(),
                )
            except lr.CliError as error:
                # fail open to "new" for each extraction
                judgments = [
                    {
                        "extraction_id": e["extraction_id"],
                        "relation": "new",
                        "target_node_id": None,
                        "reason": f"classify_failed:{error}"[:200],
                    }
                    for e in extractions
                ]
                corpus.setdefault("unresolved", []).append(
                    f"classify_fallback_new:{paper_id}:{str(error)[:160]}"
                )

        actions, counts = absorb_extractions(
            graph,
            extractions=extractions,
            judgments=judgments,
            paper_id=paper_id,
            iteration=iteration,
            is_seed=is_seed or not graph.nodes,
        )
        for key, value in counts.items():
            stats[key] = stats.get(key, 0) + value
        stats["extractions"] = stats.get("extractions", 0) + len(extractions)
        stats["papers_processed"] = stats.get("papers_processed", 0) + 1
        corpus["iterations"].append(
            {
                "iteration": iteration,
                "kind": "seed" if is_seed else "absorb",
                "paper_id": paper_id,
                "extractions": extractions,
                "judgments": judgments,
                "actions": actions,
            }
        )
        # Checkpoint after each paper.
        corpus["claim_graph"] = graph.to_dict()
        corpus["stats"] = stats
        corpus["generated_at"] = utc_now()
        lr.write_json(checkpoint_path, corpus)

    corpus["claim_graph"] = graph.to_dict()
    corpus["generated_at"] = utc_now()
    corpus["stats"] = stats
    return corpus


def object_digest_safe(value: Any) -> str:
    try:
        return lr.object_digest(value)
    except Exception:
        return ""


def _safe(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "_", value)[:80]
