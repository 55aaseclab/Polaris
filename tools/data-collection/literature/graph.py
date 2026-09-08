"""Paper–paper relationship graph (references + citations) with DOT export."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_paper_id(value: str) -> str:
    text = value.strip()
    lower = text.lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi.org/", "doi:"):
        if lower.startswith(prefix):
            text = text[len(prefix) :]
            break
    text = text.strip().strip("/")
    if re.match(r"^10\.\d{4,}/", text, re.I):
        return f"doi:{text.lower()}"
    if text.lower().startswith("doi:"):
        return "doi:" + text[4:].lower()
    return text


def dot_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


@dataclass
class LiteratureGraph:
    """Directed edges: source --relation--> target.

    relation:
      references  — source paper lists target in its bibliography
      cites       — source paper cites target (same direction as references;
                    kept as alias for clarity in some APIs)
      cited_by    — source is cited by target (forward link stored as
                    cited_by from source to citer, or we store reverse
                    as references from citer). We store both orientations
                    only when discovered that way; DOT uses one edge type.
    """

    nodes: dict[str, dict[str, Any]] = field(default_factory=dict)
    edges: set[tuple[str, str, str]] = field(default_factory=set)
    # (source_id, target_id, relation)

    def add_node(self, paper_id: str, **meta: Any) -> str:
        nid = normalize_paper_id(paper_id)
        existing = self.nodes.get(nid) or {"id": nid}
        for key, value in meta.items():
            if value is not None and value != "":
                existing[key] = value
        self.nodes[nid] = existing
        return nid

    def add_edge(
        self,
        source_id: str,
        target_id: str,
        relation: str,
        **meta: Any,
    ) -> None:
        src = self.add_node(source_id)
        tgt = self.add_node(target_id)
        rel = relation.strip().lower()
        if rel in {"cite", "cites", "citation"}:
            rel = "references"  # A cites B ≡ A references B
        if rel in {"cited_by", "cited-by", "citedby"}:
            # B cited_by A means A references B — store canonical references edge
            self.edges.add((tgt, src, "references"))
            if meta:
                self.nodes[src].setdefault("edge_meta", {})
            return
        self.edges.add((src, tgt, rel))

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": "clue.literature.graph.v1",
            "generated_at": utc_now(),
            "node_count": len(self.nodes),
            "edge_count": len(self.edges),
            "nodes": list(self.nodes.values()),
            "edges": [
                {"source": s, "target": t, "relation": r} for s, t, r in sorted(self.edges)
            ],
        }

    def write_json(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def write_dot(self, path: Path) -> None:
        """Write Graphviz DOT: edge A -> B means A references B (bibliography)."""
        path.parent.mkdir(parents=True, exist_ok=True)
        lines = [
            "digraph literature {",
            '  rankdir=LR;',
            '  node [shape=box, style=filled, fillcolor=white, fontsize=10];',
            '  edge [fontsize=9];',
            "",
        ]
        for nid, meta in sorted(self.nodes.items()):
            label_parts = [nid]
            title = meta.get("title")
            if isinstance(title, str) and title.strip():
                short = title.strip()
                if len(short) > 60:
                    short = short[:57] + "..."
                label_parts.append(short)
            year = meta.get("year")
            if year is not None:
                label_parts.append(str(year))
            venue = meta.get("venue_abbr") or meta.get("venue")
            if venue:
                label_parts.append(str(venue))
            label = "\\n".join(dot_escape(p) for p in label_parts)
            fill = "lightblue" if meta.get("in_corpus") else "lightgrey"
            lines.append(f'  "{dot_escape(nid)}" [label="{label}", fillcolor={fill}];')
        lines.append("")
        for src, tgt, rel in sorted(self.edges):
            color = "black" if rel == "references" else "darkgreen"
            lines.append(
                f'  "{dot_escape(src)}" -> "{dot_escape(tgt)}" '
                f'[label="{dot_escape(rel)}", color={color}];'
            )
        lines.append("}")
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    @classmethod
    def load_json(cls, path: Path) -> LiteratureGraph:
        document = json.loads(path.read_text(encoding="utf-8"))
        graph = cls()
        for node in document.get("nodes") or []:
            if isinstance(node, dict) and node.get("id"):
                graph.nodes[str(node["id"])] = dict(node)
        for edge in document.get("edges") or []:
            if not isinstance(edge, dict):
                continue
            s, t, r = edge.get("source"), edge.get("target"), edge.get("relation") or "references"
            if s and t:
                graph.edges.add((str(s), str(t), str(r)))
        return graph
