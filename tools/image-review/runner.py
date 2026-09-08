#!/usr/bin/env python3
"""clue-image-review: still image(s) → text via Codex for ad-content enrich."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

TOOL_NAME = "clue-image-review"
SCHEMA = "clue.image-review.v1"
DEFAULT_MODEL = "gpt-5.4-mini"
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}


class CliError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_version(root: Path) -> str:
    return (root / "VERSION").read_text(encoding="utf-8").strip()


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def default_model() -> str:
    return (
        os.environ.get("POLARIS_LITERATURE_CODEX_MODEL")
        or os.environ.get("CODEX_MODEL")
        or DEFAULT_MODEL
    ).strip() or DEFAULT_MODEL


def codex_cli(root: Path) -> Path:
    path = root.parent / "codex" / "clue-codex-cli"
    if path.is_file():
        return path
    raise CliError(f"clue-codex-cli missing: {path}")


def resolve_images(raw: list[str]) -> list[Path]:
    if not raw:
        raise CliError("review requires at least one --image")
    paths: list[Path] = []
    for item in raw:
        path = Path(item).expanduser().resolve()
        if not path.is_file():
            raise CliError(f"image not found: {path}")
        if path.suffix.lower() not in IMAGE_SUFFIXES:
            raise CliError(
                f"unsupported image suffix {path.suffix!r} "
                f"(allowed: {sorted(IMAGE_SUFFIXES)})"
            )
        paths.append(path)
    return paths


def build_prompt(images: list[Path], extra: str | None) -> str:
    listing = "\n".join(f"- [{index}] {path}" for index, path in enumerate(images))
    extra_block = (extra or "").strip()
    extra_txt = f"\n## Extra instructions\n{extra_block}\n" if extra_block else ""
    return f"""You are reviewing social/ad creative still images for content intelligence.

Images (read these files; do not invent pixels you cannot see):
{listing}
{extra_txt}
## Task
For the image set (one post or a carousel of slides), produce:
1. A concise visual description (layout, products, people, setting).
2. Any readable on-image text (OCR-style), or say none.
3. Short tags (style, product category, CTA if visible).
4. 1–5 short evidence quotes (OCR snippets or concrete visual facts).

## Output
Return ONLY JSON:
{{
  "text": "full description paragraph",
  "ocr_text": "concatenated on-image text or empty string",
  "tags": ["tag", ...],
  "evidence": [{{"quote": "...", "locator": "image@0 or carousel@N"}}]
}}
"""


def dry_run_result(images: list[Path]) -> dict[str, Any]:
    names = [path.name for path in images]
    text = (
        f"Dry-run image review of {len(images)} frame(s): " + ", ".join(names) + ". "
        "No Codex call; replace with live review for production."
    )
    evidence = [
        {
            "quote": f"frame:{path.name}",
            "locator": f"image@{index}" if len(images) == 1 else f"carousel@{index}",
        }
        for index, path in enumerate(images)
    ]
    return {
        "text": text,
        "ocr_text": "",
        "tags": ["dry-run", "image-review"],
        "evidence": evidence,
    }


def parse_model_json(last_text: str) -> dict[str, Any]:
    text = (last_text or "").strip()
    if not text:
        raise CliError("Codex returned empty last message")
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
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            raise CliError("Codex last message is not JSON") from None
        parsed = json.loads(match.group(0))
    if not isinstance(parsed, dict):
        raise CliError("Codex JSON must be an object")
    return parsed


def run_codex_review(
    *,
    root: Path,
    images: list[Path],
    prompt: str,
    model: str,
    timeout_s: int | None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Invoke clue-codex-cli exec; images must be readable under --cd."""
    # Work in a temp dir with symlinks so the sandbox can open files by short names.
    with tempfile.TemporaryDirectory(prefix="image-review-") as tmp:
        work = Path(tmp)
        link_lines: list[str] = []
        for index, path in enumerate(images):
            link = work / f"frame-{index:02d}{path.suffix.lower()}"
            link.symlink_to(path)
            link_lines.append(f"- [{index}] {link.name} (source: {path})")
        # Rebuild prompt to prefer workspace-relative names.
        listing = "\n".join(link_lines)
        body = prompt
        # Replace absolute listing block if present — keep task section.
        marker = "Images (read these files"
        if marker in body:
            after = body.split("## Task", 1)
            task = "## Task" + after[1] if len(after) == 2 else ""
            body = (
                "You are reviewing social/ad creative still images for content intelligence.\n\n"
                f"Images (read these files; do not invent pixels you cannot see):\n{listing}\n\n"
                f"{task}"
            )
        out = work / "codex-exec.json"
        cmd = [
            str(codex_cli(root)),
            "exec",
            "--prompt",
            body,
            "--output",
            str(out),
            "--model",
            model,
            "--sandbox",
            "read-only",
            "--ephemeral",
            "--cd",
            str(work),
        ]
        if timeout_s is not None:
            cmd.extend(["--timeout", str(timeout_s)])
        completed = subprocess.run(cmd, text=True, capture_output=True, check=False)
        if completed.returncode != 0 or not out.is_file():
            err = (completed.stderr or completed.stdout or "").strip()[:800]
            raise CliError(f"codex exec failed ({completed.returncode}): {err}")
        wrapper = json.loads(out.read_text(encoding="utf-8"))
        last = wrapper.get("last_message") if isinstance(wrapper, dict) else ""
        parsed = parse_model_json(str(last or ""))
        meta = {
            "codex_output": str(out),
            "exit_code": completed.returncode,
            "model": model,
        }
        return parsed, meta


def normalize_review_fields(raw: dict[str, Any], images: list[Path]) -> dict[str, Any]:
    text = raw.get("text") if isinstance(raw.get("text"), str) else ""
    ocr = raw.get("ocr_text") if isinstance(raw.get("ocr_text"), str) else ""
    tags = raw.get("tags") if isinstance(raw.get("tags"), list) else []
    tags = [str(t).strip() for t in tags if str(t).strip()]
    evidence_in = raw.get("evidence") if isinstance(raw.get("evidence"), list) else []
    evidence: list[dict[str, str]] = []
    for item in evidence_in:
        if not isinstance(item, dict):
            continue
        quote = item.get("quote")
        locator = item.get("locator") or "image@0"
        if isinstance(quote, str) and quote.strip():
            evidence.append(
                {"quote": quote.strip()[:800], "locator": str(locator).strip()[:120]}
            )
    if not text.strip() and ocr.strip():
        text = ocr.strip()
    if not text.strip():
        text = f"Image review of {len(images)} frame(s) produced no description."
    if not evidence:
        evidence = [{"quote": text[:400], "locator": "image@0"}]
    return {
        "text": text.strip(),
        "ocr_text": ocr.strip(),
        "tags": tags,
        "evidence": evidence,
    }


def command_review(args: argparse.Namespace, root: Path) -> int:
    images = resolve_images(list(args.image or []))
    model = args.model or default_model()
    prompt = build_prompt(images, args.prompt_extra)
    codex_meta: dict[str, Any] = {}
    if args.dry_run:
        fields = dry_run_result(images)
        status = "succeeded"
    else:
        raw, codex_meta = run_codex_review(
            root=root,
            images=images,
            prompt=prompt,
            model=model,
            timeout_s=args.timeout,
        )
        fields = normalize_review_fields(raw, images)
        status = "succeeded"

    payload = {
        "schema_version": SCHEMA,
        "tool": {"name": TOOL_NAME, "version": read_version(root)},
        "generated_at": utc_now(),
        "status": status,
        "dry_run": bool(args.dry_run),
        "model": model if not args.dry_run else None,
        "images": [
            {"path": str(path), "index": index, "name": path.name}
            for index, path in enumerate(images)
        ],
        "text": fields["text"],
        "ocr_text": fields["ocr_text"],
        "tags": fields["tags"],
        "evidence": fields["evidence"],
        "codex": codex_meta or None,
    }
    output = Path(args.output).expanduser().resolve()
    write_json(output, payload)
    print(
        json.dumps(
            {
                "status": status,
                "output": str(output),
                "image_count": len(images),
                "dry_run": bool(args.dry_run),
                "evidence_count": len(fields["evidence"]),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(
        prog=TOOL_NAME,
        description="Review still images into text evidence (Codex wrapper).",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("version", help="Print tool version.")
    rev = sub.add_parser("review", help="Image(s) → text JSON via Codex (or --dry-run).")
    rev.add_argument("--image", action="append", default=[], help="Image path (repeat for carousel).")
    rev.add_argument("--output", required=True, help="Output JSON path.")
    rev.add_argument("--prompt-extra", help="Extra instructions for the model.")
    rev.add_argument("--model", help=f"Codex model (default {DEFAULT_MODEL}).")
    rev.add_argument("--timeout", type=int, default=300, help="Codex timeout seconds.")
    rev.add_argument(
        "--dry-run",
        action="store_true",
        help="Skip Codex; emit synthetic text from filenames.",
    )
    args = parser.parse_args(argv)
    try:
        if args.command == "version":
            print(
                json.dumps(
                    {
                        "tool": TOOL_NAME,
                        "version": read_version(root),
                        "role": "media-utility",
                        "schema_version": SCHEMA,
                        "default_model": default_model(),
                        "codex_cli": str(codex_cli(root)) if (root.parent / "codex" / "clue-codex-cli").is_file() else None,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
        if args.command == "review":
            return command_review(args, root)
        raise CliError(f"unknown command: {args.command}")
    except CliError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
