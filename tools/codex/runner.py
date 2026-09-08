#!/usr/bin/env python3
"""Bounded Codex CLI wrapper for non-interactive exec and topic judgment.

Wraps the system `codex` binary (exec / resume). Default model is gpt-5.4-mini
for long-running literature topic judgments.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


TOOL_NAME = "clue-codex-cli"
DEFAULT_MODEL = "gpt-5.4-mini"
TOPIC_SCHEMA_NAME = "topic-judgment.schema.json"


class CliError(Exception):
    """User-correctable CLI error."""


def read_version(root: Path) -> str:
    return (root / "VERSION").read_text(encoding="utf-8").strip()


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_json(path: Path, value: dict[str, Any] | list[Any]) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.expanduser().resolve().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CliError(f"cannot read {label}: {error}") from error


def resolve_codex_bin() -> str:
    env = (
        os.environ.get("POLARIS_LITERATURE_CODEX_BIN")
        or os.environ.get("CODEX_BIN")
        or ""
    ).strip()
    if env:
        return env
    found = shutil.which("codex")
    if not found:
        raise CliError("codex binary not found on PATH (install Codex CLI or set CODEX_BIN)")
    return found


def default_model() -> str:
    return (
        os.environ.get("POLARIS_LITERATURE_CODEX_MODEL")
        or os.environ.get("CODEX_MODEL")
        or DEFAULT_MODEL
    ).strip() or DEFAULT_MODEL


def find_codex(root: Path) -> list[str]:
    return [resolve_codex_bin()]


def run_codex(
    args: list[str],
    *,
    cwd: Path | None = None,
    timeout_s: int | None = None,
    stdin_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run codex. Default stdin is /dev/null so a piped parent does not make
    `codex exec` wait for or append stdin when PROMPT is already an argv arg.
    """
    command = find_codex(Path(".")) + args
    try:
        return subprocess.run(
            command,
            text=True,
            capture_output=True,
            check=False,
            cwd=str(cwd) if cwd else None,
            timeout=timeout_s,
            input=stdin_text if stdin_text is not None else None,
            stdin=None if stdin_text is not None else subprocess.DEVNULL,
        )
    except FileNotFoundError as error:
        raise CliError(f"failed to start codex: {error}") from error
    except subprocess.TimeoutExpired as error:
        raise CliError(f"codex timed out after {timeout_s}s") from error


def command_version(root: Path) -> int:
    codex_version = None
    try:
        completed = run_codex(["--version"])
        codex_version = (completed.stdout or completed.stderr or "").strip() or None
    except CliError:
        codex_version = None
    payload = {
        "tool": {"name": TOOL_NAME, "version": read_version(root)},
        "backend_lock": json.loads((root / "backend.lock.json").read_text(encoding="utf-8")),
        "codex_bin": (
            os.environ.get("POLARIS_LITERATURE_CODEX_BIN")
            or shutil.which("codex")
            or os.environ.get("CODEX_BIN")
        ),
        "codex_version": codex_version,
        "default_model": default_model(),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def command_exec(args: argparse.Namespace, root: Path) -> int:
    """Run `codex exec` non-interactively; write last message + wrapper metadata."""
    model = args.model or default_model()
    prompt = args.prompt
    if args.prompt_file:
        prompt = Path(args.prompt_file).expanduser().read_text(encoding="utf-8")
    if prompt is None or not str(prompt).strip():
        if not sys.stdin.isatty():
            prompt = sys.stdin.read()
    if not prompt or not str(prompt).strip():
        raise CliError("exec requires --prompt, --prompt-file, or stdin")

    output = Path(args.output).expanduser().resolve()
    last_message = output.with_suffix(output.suffix + ".last-message.txt")
    if args.last_message:
        last_message = Path(args.last_message).expanduser().resolve()

    cmd: list[str] = [
        "exec",
        "--skip-git-repo-check",
        "--color",
        "never",
        "-m",
        model,
        "-s",
        args.sandbox,
        "-o",
        str(last_message),
    ]
    if args.cd:
        cmd.extend(["-C", str(Path(args.cd).expanduser().resolve())])
    if args.ephemeral:
        cmd.append("--ephemeral")
    if args.json_events:
        cmd.append("--json")
    if args.output_schema:
        cmd.extend(["--output-schema", str(Path(args.output_schema).expanduser().resolve())])
    if args.full_auto:
        cmd.append("--full-auto")
    if args.dangerously_bypass:
        cmd.append("--dangerously-bypass-approvals-and-sandbox")
    for item in args.config or []:
        cmd.extend(["-c", item])
    cmd.append(str(prompt))

    completed = run_codex(cmd, cwd=Path(args.cd).expanduser() if args.cd else None, timeout_s=args.timeout)
    last_text = ""
    if last_message.is_file():
        last_text = last_message.read_text(encoding="utf-8")

    wrapper = {
        "schema_version": "clue.codex.exec.v1",
        "tool": {"name": TOOL_NAME, "version": read_version(root)},
        "generated_at": utc_now(),
        "model": model,
        "sandbox": args.sandbox,
        "exit_code": completed.returncode,
        "last_message_path": str(last_message),
        "last_message": last_text,
        "stdout": completed.stdout or "",
        "stderr": completed.stderr or "",
        "command": ["codex", *cmd[:-1], "<prompt>"],
    }
    write_json(output, wrapper)
    print(
        json.dumps(
            {
                "status": "succeeded" if completed.returncode == 0 else "failed",
                "output": str(output),
                "exit_code": completed.returncode,
                "model": model,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if completed.returncode == 0 else 2


def _paper_fields(record: dict[str, Any]) -> dict[str, str]:
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    title = payload.get("title") or payload.get("display_name") or ""
    if isinstance(title, list):
        title = title[0] if title else ""
    abstract = payload.get("abstract") or ""
    if isinstance(abstract, dict):
        abstract = abstract.get("text") or abstract.get("value") or ""
    rid = str(record.get("record_id") or payload.get("DOI") or payload.get("doi") or "")
    return {
        "record_id": rid,
        "title": str(title).strip(),
        "abstract": str(abstract).strip()[:4000],
    }


def build_topic_prompt(
    *,
    question: str,
    include: list[str],
    exclude: list[str],
    papers: list[dict[str, str]],
    criteria: list[str] | None = None,
) -> str:
    """Build a domain-agnostic topic-judgment prompt from caller-supplied scope.

    Topic rules must come from question / include / exclude / criteria — never
    hardcode a research domain in this tool.
    """
    include_txt = "\n".join(f"- {item}" for item in include) or "- (none)"
    exclude_txt = "\n".join(f"- {item}" for item in exclude) or "- (none)"
    criteria_list = [str(x).strip() for x in (criteria or []) if str(x).strip()]
    criteria_txt = "\n".join(f"- {item}" for item in criteria_list) or (
        "- Decide from the research question and include/exclude lists only; "
        "do not apply extra domain assumptions."
    )
    papers_txt = json.dumps(papers, ensure_ascii=False, indent=2)
    return f"""You are a strict literature topic adjudicator for a research collection.

Apply only the scope below. Do not invent domain-specific rules beyond it.

## Research question
{question}

## In-scope themes
{include_txt}

## Out-of-scope
{exclude_txt}

## Judgment criteria
{criteria_txt}

## Task
For EACH paper below, decide whether title+abstract are in scope for this collection.

Process rules (universal, not domain-specific):
- Set in_scope=true only when title+abstract clearly fit the research question and
  in-scope themes, and do not fall under out-of-scope.
- Use only title and abstract; do not invent content not present there.
- If evidence is weak or mixed, prefer in_scope=false and explain briefly.
- confidence in [0,1]. reason short (1-2 sentences). matched_aspects optional short tags
  drawn from the scope themes/criteria when helpful.

## Papers
{papers_txt}

Return JSON matching the provided schema only (judgments array covering every record_id).
"""


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(x).strip() for x in value if isinstance(x, (str, int, float)) and str(x).strip()]


def _load_criteria(
    scope_doc: dict[str, Any],
    scope: dict[str, Any],
    args: argparse.Namespace,
) -> list[str]:
    """Criteria from CLI (preferred) or collection scope fields.

    Lookup order after CLI:
      1. payload.literature_scope.topic_criteria (and aliases)
      2. top-level topic_criteria / judgment_criteria / criteria
      3. scope.topic_criteria / aliases
    """
    if args.criteria:
        return [str(x).strip() for x in args.criteria if str(x).strip()]
    if args.criteria_file:
        path = Path(args.criteria_file).expanduser().resolve()
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError as error:
            raise CliError(f"cannot read criteria file: {error}") from error
        return [line.strip() for line in lines if line.strip() and not line.strip().startswith("#")]

    payload = scope_doc.get("payload") if isinstance(scope_doc.get("payload"), dict) else {}
    lit = (
        payload.get("literature_scope")
        if isinstance(payload.get("literature_scope"), dict)
        else {}
    )
    for key in ("topic_criteria", "judgment_criteria", "criteria"):
        for blob in (lit, scope_doc, scope):
            found = _string_list(blob.get(key))
            if found:
                return found
    return []


def load_records(path: Path, limit: int | None) -> list[dict[str, Any]]:
    raw = read_json(path, "records file")
    if isinstance(raw, dict) and isinstance(raw.get("records"), list):
        records = [r for r in raw["records"] if isinstance(r, dict)]
    elif isinstance(raw, list):
        records = [r for r in raw if isinstance(r, dict)]
    else:
        raise CliError("records file must be a list or an object with records[]")
    if limit is not None:
        records = records[: max(0, limit)]
    return records


def parse_judgments_json(last_text: str) -> tuple[list[dict[str, Any]], str | None]:
    """Parse model last-message into judgments[]; returns (items, parse_error)."""
    text = (last_text or "").strip()
    if not text:
        return [], "empty last message"
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
        if text.startswith("json"):
            text = text[4:].lstrip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        # Last-resort: first {...} or [...] block
        start_obj, start_arr = text.find("{"), text.find("[")
        starts = [i for i in (start_obj, start_arr) if i >= 0]
        if not starts:
            return [], f"last message is not JSON: {error}"
        start = min(starts)
        try:
            parsed = json.loads(text[start:])
        except json.JSONDecodeError as error2:
            return [], f"last message is not JSON: {error2}"
    if isinstance(parsed, dict) and isinstance(parsed.get("judgments"), list):
        return [j for j in parsed["judgments"] if isinstance(j, dict)], None
    if isinstance(parsed, list):
        return [j for j in parsed if isinstance(j, dict)], None
    return [], "last message JSON missing judgments[]"


def _run_topic_codex(
    *,
    prompt: str,
    last_message: Path,
    model: str,
    sandbox: str,
    schema_path: Path | None,
    cd: str | None,
    full_auto: bool,
    timeout_s: int | None,
    root: Path,
) -> tuple[subprocess.CompletedProcess[str], str, str]:
    if last_message.is_file():
        last_message.unlink()
    cmd: list[str] = [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--color",
        "never",
        "-m",
        model,
        "-s",
        sandbox,
        "-o",
        str(last_message),
    ]
    mode = "freeform"
    if schema_path is not None:
        cmd.extend(["--output-schema", str(schema_path)])
        mode = "output-schema"
    if cd:
        cmd[1:1] = ["-C", str(Path(cd).expanduser().resolve())]
    if full_auto:
        cmd.append("--full-auto")
    cmd.append(prompt)
    completed = run_codex(
        cmd,
        cwd=Path(cd).expanduser() if cd else root,
        timeout_s=timeout_s,
    )
    last_text = last_message.read_text(encoding="utf-8") if last_message.is_file() else ""
    return completed, last_text, mode


def command_topic_judge(args: argparse.Namespace, root: Path) -> int:
    """Judge paper title/abstract against collection scope via codex exec."""
    model = args.model or default_model()
    scope_path = Path(args.scope).expanduser().resolve()
    records_path = Path(args.records).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()

    scope_doc = read_json(scope_path, "scope/input file")
    if not isinstance(scope_doc, dict):
        raise CliError("scope file must be a JSON object (collection input or scope blob)")

    question = (
        scope_doc.get("question")
        or (scope_doc.get("scope") or {}).get("question")
        or args.question
        or ""
    )
    if not isinstance(question, str) or not question.strip():
        raise CliError("scope file needs question (or pass --question)")

    scope = scope_doc.get("scope") if isinstance(scope_doc.get("scope"), dict) else scope_doc
    include = scope.get("include") if isinstance(scope.get("include"), list) else []
    exclude = scope.get("exclude") if isinstance(scope.get("exclude"), list) else []
    include = [str(x) for x in include if isinstance(x, str) and x.strip()]
    exclude = [str(x) for x in exclude if isinstance(x, str) and x.strip()]
    criteria = _load_criteria(scope_doc, scope, args)

    records = load_records(records_path, args.limit)
    papers = [_paper_fields(r) for r in records]
    papers = [p for p in papers if p["record_id"] and p["title"]]
    if not papers:
        raise CliError("no papers with record_id+title to judge")

    schema_path = root / "schemas" / TOPIC_SCHEMA_NAME
    if not schema_path.is_file():
        raise CliError(f"missing schema: {schema_path}")

    prompt = build_topic_prompt(
        question=question.strip(),
        include=include,
        exclude=exclude,
        papers=papers,
        criteria=criteria,
    )
    # Providers may 429/503 on codex --output-schema; freeform JSON is the
    # default. Pass --use-output-schema to force structured mode.
    use_schema = bool(args.use_output_schema)

    with tempfile.TemporaryDirectory(prefix="clue-codex-topic-") as tmp:
        tmp_path = Path(tmp)
        last_message = tmp_path / "last-message.txt"
        completed, last_text, schema_mode = _run_topic_codex(
            prompt=prompt,
            last_message=last_message,
            model=model,
            sandbox=args.sandbox,
            schema_path=schema_path if use_schema else None,
            cd=args.cd,
            full_auto=bool(args.full_auto),
            timeout_s=args.timeout,
            root=root,
        )
        # One automatic freeform retry if structured mode failed.
        if use_schema and (completed.returncode != 0 or not last_text.strip()):
            completed, last_text, schema_mode = _run_topic_codex(
                prompt=prompt,
                last_message=last_message,
                model=model,
                sandbox=args.sandbox,
                schema_path=None,
                cd=args.cd,
                full_auto=bool(args.full_auto),
                timeout_s=args.timeout,
                root=root,
            )

    judgments, parse_error = parse_judgments_json(last_text)

    by_id = {str(j.get("record_id")): j for j in judgments if j.get("record_id")}
    ordered = []
    for paper in papers:
        rid = paper["record_id"]
        item = by_id.get(rid)
        if item is None:
            ordered.append(
                {
                    "record_id": rid,
                    "in_scope": False,
                    "confidence": 0.0,
                    "reason": "missing judgment from model",
                    "matched_aspects": [],
                    "title": paper["title"],
                }
            )
        else:
            ordered.append(
                {
                    "record_id": rid,
                    "in_scope": bool(item.get("in_scope")),
                    "confidence": float(item.get("confidence") or 0.0),
                    "reason": str(item.get("reason") or ""),
                    "matched_aspects": item.get("matched_aspects")
                    if isinstance(item.get("matched_aspects"), list)
                    else [],
                    "title": paper["title"],
                }
            )

    in_scope_n = sum(1 for j in ordered if j["in_scope"])
    wrapper = {
        "schema_version": "clue.codex.topic-judge.v1",
        "tool": {"name": TOOL_NAME, "version": read_version(root)},
        "generated_at": utc_now(),
        "model": model,
        "question": question.strip(),
        "include": include,
        "exclude": exclude,
        "criteria": criteria,
        "output_schema_mode": schema_mode,
        "input_count": len(papers),
        "in_scope_count": in_scope_n,
        "out_of_scope_count": len(papers) - in_scope_n,
        "judgments": ordered,
        "codex_exit_code": completed.returncode,
        "parse_error": parse_error,
        "raw_last_message": last_text[:20000],
        "stderr": (completed.stderr or "")[:20000],
    }
    write_json(output, wrapper)
    ok = completed.returncode == 0 and parse_error is None
    print(
        json.dumps(
            {
                "status": "succeeded" if ok else "failed",
                "output": str(output),
                "input_count": len(papers),
                "in_scope_count": in_scope_n,
                "out_of_scope_count": len(papers) - in_scope_n,
                "model": model,
                "exit_code": completed.returncode,
                "parse_error": parse_error,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if ok else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=TOOL_NAME,
        description="Codex CLI wrapper: non-interactive exec + literature topic judge.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("version", help="Print wrapper + codex version.")

    ex = sub.add_parser("exec", help="Run codex exec non-interactively.")
    ex.add_argument("--prompt", help="Prompt string.")
    ex.add_argument("--prompt-file", help="Read prompt from file.")
    ex.add_argument("--output", required=True, help="Wrapper JSON output path.")
    ex.add_argument("--last-message", help="Path for codex -o last message file.")
    ex.add_argument("--model", default=None, help=f"Model (default {DEFAULT_MODEL} or CODEX_MODEL).")
    ex.add_argument(
        "--sandbox",
        default="read-only",
        choices=["read-only", "workspace-write", "danger-full-access"],
    )
    ex.add_argument("--cd", help="Working directory for codex (-C).")
    ex.add_argument("--output-schema", help="JSON Schema for structured final response.")
    ex.add_argument("--ephemeral", action="store_true", help="Do not persist codex session.")
    ex.add_argument("--json-events", action="store_true", help="Pass --json to codex exec.")
    ex.add_argument("--full-auto", action="store_true", help="Pass --full-auto.")
    ex.add_argument(
        "--dangerously-bypass",
        action="store_true",
        help="Pass --dangerously-bypass-approvals-and-sandbox.",
    )
    ex.add_argument("--config", action="append", default=[], help="codex -c key=value (repeatable).")
    ex.add_argument("--timeout", type=int, default=600, help="Seconds (default 600).")

    tj = sub.add_parser(
        "topic-judge",
        help="Judge paper title/abstract against collection scope (codex + schema).",
    )
    tj.add_argument("--scope", required=True, help="Collection input.json or scope object JSON.")
    tj.add_argument("--records", required=True, help="Collection output or records[] JSON.")
    tj.add_argument("--output", required=True, help="Judgments JSON path.")
    tj.add_argument("--question", help="Override research question.")
    tj.add_argument(
        "--criteria",
        action="append",
        default=[],
        help="Extra judgment criterion (repeatable). Overrides scope criteria when set.",
    )
    tj.add_argument(
        "--criteria-file",
        help="Text file: one criterion per non-empty line (overrides scope when set).",
    )
    tj.add_argument("--limit", type=int, default=None, help="Max papers to judge (for dry tests).")
    tj.add_argument("--model", default=None, help=f"Model (default {DEFAULT_MODEL}).")
    tj.add_argument(
        "--sandbox",
        default="read-only",
        choices=["read-only", "workspace-write", "danger-full-access"],
    )
    tj.add_argument("--cd", help="Working directory for codex.")
    tj.add_argument("--full-auto", action="store_true")
    tj.add_argument(
        "--use-output-schema",
        action="store_true",
        help="Pass codex --output-schema (some providers 429/503; freeform is default).",
    )
    tj.add_argument("--timeout", type=int, default=900, help="Seconds (default 900).")
    return parser


def main(argv: list[str] | None = None) -> int:
    root = Path(__file__).resolve().parent
    args = build_parser().parse_args(argv)
    try:
        if args.command == "version":
            return command_version(root)
        if args.command == "exec":
            return command_exec(args, root)
        if args.command == "topic-judge":
            return command_topic_judge(args, root)
        raise CliError(f"unsupported command: {args.command}")
    except CliError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
