#!/usr/bin/env python3
"""ad-content-review executor — LLM synthesize of content judgments.

Product entry remains tools/intelligence-analysis. Local dev uses the same
Codex path as production.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

from synthesize import (
    SynthesizeError,
    default_model,
    synthesize_judgments,
)


class CliError(RuntimeError):
    pass


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.expanduser().resolve().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CliError(f"invalid {label}: {error}") from error
    if not isinstance(value, dict):
        raise CliError(f"{label} must be a JSON object")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def file_digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def command_synthesize(args: argparse.Namespace) -> int:
    prepared = read_json(Path(args.input), "analysis input")
    task = prepared.get("task") if isinstance(prepared.get("task"), dict) else {}
    snapshot = (
        prepared.get("collection_snapshot")
        if isinstance(prepared.get("collection_snapshot"), dict)
        else {}
    )
    if not task or not snapshot:
        raise CliError("analysis input must include task and collection_snapshot")
    clues = snapshot.get("clues") if isinstance(snapshot.get("clues"), list) else []
    snapshot_path = Path(args.snapshot) if args.snapshot else None
    if snapshot_path and snapshot_path.is_file():
        snap_sha = file_digest(snapshot_path)
        snap_id = str(snapshot.get("snapshot_id") or snapshot_path.stem)
    else:
        raw = json.dumps(snapshot, ensure_ascii=False, sort_keys=True).encode()
        snap_sha = "sha256:" + hashlib.sha256(raw).hexdigest()
        snap_id = str(snapshot.get("snapshot_id") or "snapshot")

    policy = task.get("review_policy") if isinstance(task.get("review_policy"), dict) else {}
    work_dir = Path(args.work_dir).expanduser().resolve() if args.work_dir else None
    try:
        result = synthesize_judgments(
            case_id=str(task.get("case_id") or "ad-content"),
            question=str(task.get("question") or ""),
            decision_context=str(task.get("decision_context") or ""),
            audience=str(task.get("audience") or ""),
            clues=[c for c in clues if isinstance(c, dict)],
            snapshot_id=snap_id,
            snapshot_sha256=snap_sha,
            policy=policy,
            model=args.model,
            timeout_s=args.timeout,
            lexical_only=bool(args.lexical_only),
            work_dir=work_dir,
        )
    except SynthesizeError as error:
        raise CliError(str(error)) from error

    output = Path(args.output).expanduser().resolve()
    write_json(output, result)
    summary = (result.get("review") or {}).get("summary") or {}
    print(
        json.dumps(
            {
                "status": "succeeded",
                "output": str(output),
                "judgment_count": len(result.get("judgments") or []),
                "clue_count": len(clues),
                "executor_status": summary.get("executor_status"),
                "model": summary.get("model"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def command_render_markdown(args: argparse.Namespace) -> int:
    """Markdown from synthesize/IA output (no extra model call)."""
    doc = read_json(Path(args.input), "analysis or synthesize output")
    judgments = doc.get("judgments") if isinstance(doc.get("judgments"), list) else []
    ctx = doc.get("analysis_context") if isinstance(doc.get("analysis_context"), dict) else {}
    question = ctx.get("question") or doc.get("search_scope", {}).get("question") or ""
    decision = (
        ctx.get("decision_context")
        or doc.get("search_scope", {}).get("decision_context")
        or ""
    )
    lines = [
        "# Ad Content Intelligence Report",
        "",
        f"- Generated from: `{doc.get('analysis_kind') or 'ad-content-review'}`",
        f"- Analysis / case: `{doc.get('analysis_id') or doc.get('case_id') or ''}`",
        f"- Status: `{doc.get('status')}`",
        "",
        "## Research question",
        "",
        str(question),
        "",
        "## Decision context",
        "",
        str(decision),
        "",
        "## Key judgments",
        "",
    ]
    if not judgments:
        lines.append("_No judgments produced._")
    for claim in judgments:
        if not isinstance(claim, dict):
            continue
        lines.append(f"### {claim.get('claim_id')}: {claim.get('title')}")
        lines.append("")
        lines.append(str(claim.get("statement") or ""))
        lines.append("")
        lines.append(
            f"- classification: `{claim.get('classification')}` · "
            f"status: `{claim.get('status')}` · confidence: `{claim.get('confidence')}`"
        )
        lines.append("")
        lines.append("Evidence:")
        lines.append("")
        for item in claim.get("evidence") or []:
            if not isinstance(item, dict):
                continue
            quote = str(item.get("quote") or "").replace("\n", " ")
            url = item.get("source_url") or ""
            lines.append(f"- “{quote[:240]}” — <{url}>")
        lines.append("")
    unresolved = doc.get("unresolved") if isinstance(doc.get("unresolved"), list) else []
    lines.extend(["## Unresolved / limitations", ""])
    for item in unresolved:
        lines.append(f"- {item}")
    lines.append("")
    text = "\n".join(lines)
    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(text, encoding="utf-8")
    print(json.dumps({"status": "succeeded", "output": str(output)}, ensure_ascii=False, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(
        prog="ad-content-review",
        description=(
            "Ad-content intelligence executor. Default synthesize uses Codex LLM "
            "(same path for local and production)."
        ),
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("version", help="Print tool version.")
    syn = sub.add_parser("synthesize", help="Build judgments from analysis-input.json via LLM.")
    syn.add_argument("--input", required=True, help="Prepared analysis-input JSON.")
    syn.add_argument("--output", required=True, help="Synthesize result JSON path.")
    syn.add_argument("--snapshot", help="Optional snapshot file for sha256.")
    syn.add_argument("--model", help=f"Codex model (default {default_model()}).")
    syn.add_argument("--timeout", type=int, default=600, help="Codex timeout seconds.")
    syn.add_argument(
        "--work-dir",
        help="Directory for Codex exec artifacts (default: temp).",
    )
    syn.add_argument(
        "--lexical-only",
        action="store_true",
        help="Offline unit-test path without Codex (not for real analysis).",
    )
    md = sub.add_parser(
        "render-markdown",
        help="Write markdown from synthesize/IA output (no model call).",
    )
    md.add_argument("--input", required=True)
    md.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        if args.cmd == "version":
            version = (root / "VERSION").read_text(encoding="utf-8").strip()
            print(
                json.dumps(
                    {
                        "tool": "ad-content-review",
                        "version": version,
                        "role": "executor",
                        "status": "llm-synthesize",
                        "shell": "clue-intelligence-analysis",
                        "analysis_kind": "ad-content-review",
                        "default_model": default_model(),
                        "commands": ["version", "synthesize", "render-markdown"],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
        if args.cmd == "synthesize":
            return command_synthesize(args)
        if args.cmd == "render-markdown":
            return command_render_markdown(args)
        raise CliError(f"unknown command: {args.cmd}")
    except CliError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
