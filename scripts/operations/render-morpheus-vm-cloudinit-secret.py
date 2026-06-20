#!/usr/bin/env python3
"""
Render the Morpheus KubeVirt cloud-init Secret from repo-local auth files.
"""

from __future__ import annotations

import argparse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_PATH = REPO_ROOT / "config" / "generated" / "kubevirt" / "morpheus-vm-cloudinit-secret.yaml"
DEFAULT_OUTPUT_PATH = REPO_ROOT / "config" / "generated" / "kubevirt" / "morpheus-vm-cloudinit-secret.yaml"
CODEX_AUTH_PATH = REPO_ROOT / "secrets" / "agentctl" / "codex" / "auth.json"
CLAUDE_SETTINGS_PATH = REPO_ROOT / "secrets" / "agentctl" / "claude" / "settings.json"


def read_required(path: Path) -> str:
    if not path.exists():
        raise SystemExit(f"missing required file: {path}")
    return path.read_text()


def indent_block(text: str, spaces: int) -> str:
    prefix = " " * spaces
    return "\n".join(f"{prefix}{line}" if line else prefix.rstrip() for line in text.rstrip("\n").splitlines())


def render_template() -> str:
    rendered = TEMPLATE_PATH.read_text()
    replacements = {
        "__CODEX_AUTH_JSON__": indent_block(read_required(CODEX_AUTH_PATH), 8),
        "__CLAUDE_SETTINGS_JSON__": indent_block(read_required(CLAUDE_SETTINGS_PATH), 8),
    }
    for marker, content in replacements.items():
        rendered = rendered.replace(f"        {marker}", content)
    return rendered


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "-o",
        "--output",
        default=str(DEFAULT_OUTPUT_PATH),
        help="write the rendered Secret to this path; use '-' for stdout",
    )
    args = parser.parse_args()

    rendered = render_template()
    if args.output == "-":
        print(rendered, end="")
        return
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(rendered)
    print(output_path)


if __name__ == "__main__":
    main()
