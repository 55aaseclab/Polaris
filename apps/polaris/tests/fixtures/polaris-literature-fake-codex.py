#!/usr/bin/env python3
"""Deterministic Codex protocol fixture for the Polaris literature E2E test.

The fixture implements only the non-interactive ``codex exec`` surface used by
the migrated tools.  It reads the supplied frozen attachments and returns
synthetic, schema-shaped responses; it never performs network or filesystem
access outside those attachments and its response file.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any


def option_value(arguments: list[str], *names: str) -> str | None:
    for index, argument in enumerate(arguments):
        if argument in names and index + 1 < len(arguments):
            return arguments[index + 1]
    return None


def prompt_text(arguments: list[str]) -> str:
    try:
        piped = sys.stdin.read()
    except OSError:
        piped = ""
    if piped.strip():
        return piped
    return arguments[-1] if arguments else ""


def embedded_payload(prompt: str) -> dict[str, Any]:
    marker = "Immutable JSON payload is in the user message below."
    start = prompt.find(marker)
    if start < 0:
        return {}
    start = prompt.find("{", start + len(marker))
    if start < 0:
        return {}
    try:
        value, _ = json.JSONDecoder().raw_decode(prompt[start:])
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def attachment(arguments: list[str], basename: str) -> dict[str, Any]:
    directories: list[Path] = []
    for index, argument in enumerate(arguments):
        if argument == "--add-dir" and index + 1 < len(arguments):
            directories.append(Path(arguments[index + 1]))
    for directory in directories:
        if not directory.is_dir():
            continue
        for candidate in sorted(directory.rglob("*.json")):
            if candidate.name != basename and not candidate.name.endswith(basename):
                continue
            try:
                value = json.loads(candidate.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(value, dict):
                return value
    return {}


def analysis_response(prompt: str) -> dict[str, Any] | None:
    if "# Extract paper core claims v1" in prompt:
        payload = embedded_payload(prompt)
        paper = payload.get("paper") if isinstance(payload.get("paper"), dict) else {}
        paper_id = str(paper.get("paper_id") or "paper-unknown")
        observations = paper.get("observations")
        observation = observations[0] if isinstance(observations, list) and observations else {}
        quote = str(observation.get("quote") or "Synthetic evidence.")
        observation_id = str(observation.get("observation_id") or f"{paper_id}:evidence-1")
        return {
            "schema_version": "clue.intelligence.paper-extractions.v1",
            "paper_id": paper_id,
            "paper_type": "tool_paper",
            "extractions": [
                {
                    "extraction_id": "ex-001",
                    "title": f"Bounded behavior from {paper_id}",
                    "statement": f"The frozen evidence for {paper_id} describes bounded workflow behavior.",
                    "focus": ["conclusion"],
                    "status": "supported",
                    "confidence": 0.95,
                    "risk_level": "low",
                    "evidence": [
                        {
                            "clue_id": paper_id,
                            "observation_id": observation_id,
                            "relation": "supports",
                            "quote": quote,
                            "paper_id": paper_id,
                        }
                    ],
                    "limitations": ["Synthetic fixture evidence."],
                }
            ],
        }
    if "# Classify extractions against claim graph v1" in prompt:
        payload = embedded_payload(prompt)
        extractions = payload.get("new_extractions")
        extraction_id = "ex-001"
        if isinstance(extractions, list) and extractions and isinstance(extractions[0], dict):
            extraction_id = str(extractions[0].get("extraction_id") or extraction_id)
        nodes = payload.get("claim_graph_nodes")
        target = None
        if isinstance(nodes, list) and nodes and isinstance(nodes[0], dict):
            target = nodes[0].get("node_id")
        return {
            "schema_version": "clue.intelligence.absorb-judgments.v1",
            "judgments": [
                {
                    "extraction_id": extraction_id,
                    "relation": "identical" if target else "new",
                    "target_node_id": target,
                    "reason": "Synthetic fixture uses compatible evidence scope.",
                }
            ],
        }
    return None


def keyword_response(prompt: str) -> dict[str, Any] | None:
    if "# Plan literature search keywords v1" not in prompt:
        return None
    return {
        "keywords": ["synthetic corpus", "bounded behavior"],
        "queries": ["synthetic corpus bounded behavior"],
        "year_from": 2020,
        "year_to": 2026,
    }


def report_response(prompt: str, arguments: list[str]) -> dict[str, Any] | None:
    if "# Compress claims → local main arguments" in prompt:
        cards = attachment(arguments, "cards.json")
        ids = [
            str(card.get("claim_id"))
            for card in cards.get("cards", [])
            if isinstance(card, dict) and card.get("claim_id")
        ]
        return {
            "schema_version": "clue.report-writing.local-arguments.v1",
            "local_arguments": [
                {
                    "local_id": "L1",
                    "thesis": "The synthetic literature supports bounded workflow behavior.",
                    "role": "established",
                    "themes": ["bounded-workflows"],
                    "claim_ids": ids,
                }
            ],
        }
    if "# Outline from main arguments" in prompt:
        arguments_doc = attachment(arguments, "outline-input.json")
        argument_ids = [
            str(item.get("argument_id"))
            for item in arguments_doc.get("arguments", [])
            if isinstance(item, dict) and item.get("argument_id")
        ]
        return {
            "schema_version": "clue.report-writing.outline.v1",
            "title": "Synthetic Polaris literature review",
            "findings": [
                {
                    "subsection_id": "S1",
                    "heading": "Bounded workflow evidence",
                    "argument_ids": argument_ids,
                    "subsubsections": [],
                }
            ],
        }
    if "# Expand one outline subsection into literature prose" in prompt:
        unit = attachment(arguments, "-input.json")
        claim_ids = [
            str(value)
            for value in unit.get("required_claim_ids", [])
            if isinstance(value, str) and value
        ]
        markers = " ".join(f"The evidence supports this bounded finding [@{claim_id}]." for claim_id in claim_ids)
        return {
            "schema_version": "clue.report-writing.expansion.v1",
            "subsection_id": str(unit.get("unit", {}).get("unit_id") or "S1"),
            "heading": str(unit.get("unit", {}).get("heading") or "Bounded workflow evidence"),
            "paragraphs": [markers or "The frozen evidence is bounded."],
            "claim_ids": claim_ids,
        }
    for dimension, marker in (
        ("unity", "# Unity review v1"),
        ("support", "# Support review v1"),
        ("coherence", "# Coherence review v1"),
        ("sentence_skills", "# Sentence skills review v1"),
    ):
        if marker in prompt:
            return {
                "dimension": dimension,
                "score": 9,
                "status": "pass",
                "blocking_issues": [],
                "notes": ["Synthetic Polaris review pass."],
            }
    # Front matter, section framing, and the closing summary have deterministic
    # fallbacks in the migrated pipeline. Returning an empty JSON object here
    # keeps this fixture focused on the collection/analysis/report boundaries.
    if any(
        marker in prompt
        for marker in (
            "# Expand literature front matter",
            "# Expand Findings and Evidence introduction",
            "# Expand Findings and Evidence summary",
        )
    ):
        return {}
    return None


def main() -> int:
    arguments = sys.argv[1:]
    log_path = os.environ.get("POLARIS_TEST_CODEX_LOG")
    if log_path:
        Path(log_path).write_text(
            json.dumps(
                {
                    "argv": arguments,
                    "cwd": str(Path.cwd()),
                    "wanghai_keys": sorted(key for key in os.environ if key.startswith("WANGHAI_")),
                    "workflow_root": os.environ.get("POLARIS_LITERATURE_WORKFLOW_ROOT"),
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
    if "--version" in arguments:
        print("synthetic-polaris-codex 1.0")
        return 0
    response_path = option_value(
        arguments,
        "--output-last-message",
        "--last-message",
        "-o",
    )
    if not response_path:
        print("missing response path", file=sys.stderr)
        return 2
    prompt = prompt_text(arguments)
    response = keyword_response(prompt) or analysis_response(prompt) or report_response(prompt, arguments)
    if response is None:
        print("unsupported synthetic prompt", file=sys.stderr)
        return 3
    Path(response_path).write_text(
        json.dumps(response, ensure_ascii=False),
        encoding="utf-8",
    )
    print(json.dumps({"type": "thread.started", "thread_id": "synthetic-polaris-codex"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
