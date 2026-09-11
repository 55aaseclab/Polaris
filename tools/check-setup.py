#!/usr/bin/env python3
"""Evaluate one tool's backend.lock.json and print what was checked.

Polaristool `ops tool-precheck` and the portal Tools page run this script.
The lock is the source of env/command/file/python prerequisites. This script
adds live checks (usable DISPLAY, Camofox health, seeded session) and a next
step for each gap. Reports name what was checked; they never print values.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen


NEXT_STEPS: dict[str, str] = {
    "DISPLAY": "Start Xvfb and set DISPLAY=:99. See tools/browser/SETUP-BROWSER.md",
    "BROWSER_CAMOFOX_URL": "Run ./tools/browser/clue-browser setup, then start Camofox or leave Polaristool to start one. See tools/browser/SETUP-BROWSER.md",
    "BROWSER_CAMOFOX_USER_ID": "Set BROWSER_CAMOFOX_USER_ID=polaris-literature so cookies persist. See tools/browser/SETUP-BROWSER.md",
    "BROWSER_IMPORT_COOKIES_PATH": "Optional: export Netscape cookies.txt into ~/.camofox/cookies and point this at the file. See tools/browser/SETUP-BROWSER.md",
    "CAMOFOX_API_KEY": "Set CAMOFOX_API_KEY if Camofox is not on loopback and you import cookies. See tools/browser/SETUP-BROWSER.md",
    "BROWSER_PROXY_SERVER": "Set BROWSER_PROXY_SERVER when publisher sites need an ISP/residential proxy.",
    "BROWSER_PROXY_USERNAME": "Set with BROWSER_PROXY_SERVER for authenticated proxies.",
    "BROWSER_PROXY_PASSWORD": "Set with BROWSER_PROXY_SERVER for authenticated proxies.",
    "BROWSER_PROXY_BYPASS": "Optional proxy bypass list.",
    "POLARIS_LITERATURE_CACHE_ROOT": "Unset is fine when POLARIS_DATA_ROOT is set; Polaristool derives $POLARIS_DATA_ROOT/cache.",
    "POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY": "Set POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY (or SEMANTIC_SCHOLAR_API_KEY) for search and citation expansion.",
    "POLARIS_LITERATURE_DEEPSEC_API_URL": "Set POLARIS_LITERATURE_DEEPSEC_API_URL or DEEPSEC_API_URL. Polaristool does not invent a DeepSec host.",
    "POLARIS_LITERATURE_CODEX_BIN": "Install Codex CLI (PATH `codex`) or set POLARIS_LITERATURE_CODEX_BIN / CODEX_BIN.",
    "node": "Install Node.js 22+.",
    "python3": "Install Python 3.11+.",
    "docker": "Install Docker to run the local SearXNG backend.",
    "xelatex": "Install TeX Live / XeLaTeX for formal PDF rendering.",
    "SETUP-BROWSER.md": "Restore tools/browser/SETUP-BROWSER.md.",
    "../browser/SETUP-BROWSER.md": "Restore tools/browser/SETUP-BROWSER.md.",
    "package.json": "Restore tools/browser/package.json and run ./clue-browser setup.",
    "config/settings.yml": "Restore tools/web-search/config/settings.yml.",
}

ENV_ALIASES: dict[str, tuple[str, ...]] = {
    "POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY": ("SEMANTIC_SCHOLAR_API_KEY",),
    "POLARIS_LITERATURE_DEEPSEC_API_URL": ("DEEPSEC_API_URL",),
    "POLARIS_LITERATURE_CROSSREF_API_URL": ("CROSSREF_API_URL",),
    "POLARIS_LITERATURE_CODEX_BIN": ("CODEX_BIN",),
}


def present(value: str | None) -> bool:
    return bool(value and value.strip())


def env_present(environment: dict[str, str], key: str) -> bool:
    if present(environment.get(key)):
        return True
    return any(present(environment.get(alias)) for alias in ENV_ALIASES.get(key, ()))


def command_satisfies_env(item: dict[str, Any]) -> bool:
    command = str(item.get("command") or "").strip()
    return bool(command) and shutil.which(command) is not None


def next_step(key: str, reason: str) -> str:
    return NEXT_STEPS.get(key, reason)


def parse_python_version(text: str) -> tuple[int, int] | None:
    import re

    match = re.search(r"Python (\d+)\.(\d+)", text)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def parse_minimum_version(value: str) -> tuple[int, int]:
    import re

    match = re.match(r"^(\d+)\.(\d+)", (value or "").strip())
    if not match:
        return 3, 11
    return int(match.group(1)), int(match.group(2))


def version_at_least(actual: tuple[int, int], minimum: tuple[int, int]) -> bool:
    return actual[0] > minimum[0] or (actual[0] == minimum[0] and actual[1] >= minimum[1])


def python_status(minimum_version: str, requirements: list[str]) -> str | None:
    probe = subprocess.run(["python3", "--version"], capture_output=True, text=True, check=False)
    if probe.returncode != 0:
        return f"python3 {minimum_version} is required"
    actual = parse_python_version(f"{probe.stdout}{probe.stderr}")
    if not actual or not version_at_least(actual, parse_minimum_version(minimum_version)):
        return f"python3 {minimum_version} is required"
    if not requirements:
        return None
    check = subprocess.run(
        [
            "python3",
            "-c",
            "import importlib.metadata as m,sys; [m.version(p.split('==')[0].split('>=')[0]) for p in sys.argv[1:]]",
            *requirements,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if check.returncode == 0:
        return None
    return "python packages missing: " + ", ".join(requirements)


def finding(
    tool_id: str,
    kind: str,
    type_: str,
    key: str,
    reason: str,
    status: str = "missing",
) -> dict[str, str]:
    return {
        "toolId": tool_id,
        "type": type_,
        "key": key,
        "kind": kind,
        "status": status,
        "reason": reason,
        "next": next_step(key, reason) if status == "missing" else "",
    }


def collect_lock_checks(tool_id: str, lock_path: Path, environment: dict[str, str]) -> list[dict[str, str]]:
    parsed = json.loads(lock_path.read_text(encoding="utf-8"))
    prerequisites = parsed.get("prerequisites") if isinstance(parsed, dict) else None
    if not isinstance(prerequisites, dict):
        raise ValueError(f"{lock_path} must declare prerequisites")
    checked: list[dict[str, str]] = []
    for item in prerequisites.get("env") or []:
        if not isinstance(item, dict) or not isinstance(item.get("key"), str):
            continue
        kind = "required" if item.get("kind") == "required" else "recommended"
        reason = str(item.get("reason") or f"set {item['key']}")
        ok = env_present(environment, item["key"]) or (
            kind != "required" and command_satisfies_env(item)
        )
        checked.append(finding(tool_id, kind, "env", item["key"], reason, "ok" if ok else "missing"))
    for item in prerequisites.get("commands") or []:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            continue
        kind = "required" if item.get("kind") == "required" else "recommended"
        reason = str(item.get("reason") or f"install {item['name']}")
        ok = shutil.which(item["name"]) is not None
        checked.append(finding(tool_id, kind, "command", item["name"], reason, "ok" if ok else "missing"))
    for item in prerequisites.get("files") or []:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            continue
        kind = "required" if item.get("kind") == "required" else "recommended"
        reason = str(item.get("reason") or f"restore {item['path']}")
        ok = (lock_path.parent / item["path"]).resolve().exists()
        checked.append(finding(tool_id, kind, "file", item["path"], reason, "ok" if ok else "missing"))
    python = prerequisites.get("python")
    if isinstance(python, dict):
        minimum = python.get("minimum_version")
        requirements = python.get("requirements")
        if not isinstance(minimum, str) or not isinstance(requirements, list):
            raise ValueError("Python tools must declare prerequisites.python.minimum_version and requirements")
        packages = [item for item in requirements if isinstance(item, str)]
        status = python_status(minimum, packages)
        checked.append(
            finding(
                tool_id,
                "required",
                "python",
                ",".join(packages) or f"python3>={minimum}",
                status or f"python3>={minimum}",
                "missing" if status else "ok",
            )
        )
    return checked


def apply_finding(checked: list[dict[str, str]], item: dict[str, str]) -> None:
    for existing in checked:
        if existing["type"] == item["type"] and existing["key"] == item["key"]:
            existing["status"] = "missing"
            existing["reason"] = item["reason"]
            existing["next"] = item.get("next") or next_step(item["key"], item["reason"])
            return
    checked.append({**item, "status": "missing"})


def display_usable() -> bool:
    if not shutil.which("xdpyinfo"):
        return True
    probe = subprocess.run(["xdpyinfo"], capture_output=True, check=False)
    return probe.returncode == 0


def camofox_health_ok(url: str) -> bool:
    try:
        with urlopen(f"{url.rstrip('/')}/health", timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8", errors="replace"))
        return payload.get("ok") is True
    except (URLError, TimeoutError, OSError, json.JSONDecodeError, ValueError):
        return False


def collect_live_findings(tool_id: str, environment: dict[str, str]) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    display = (environment.get("DISPLAY") or "").strip()
    if display and not display_usable():
        findings.append(
            finding(
                tool_id,
                "recommended",
                "env",
                "DISPLAY",
                "DISPLAY is set but xdpyinfo cannot use it. Start Xvfb or fix Xauthority.",
            )
        )
    camofox_url = (environment.get("BROWSER_CAMOFOX_URL") or "").strip()
    if camofox_url and not camofox_health_ok(camofox_url):
        findings.append(
            finding(
                tool_id,
                "recommended",
                "env",
                "BROWSER_CAMOFOX_URL",
                "Camofox /health is not ok. Start Camofox or unset the URL so Polaristool can start one.",
            )
        )
    user_id = (environment.get("BROWSER_CAMOFOX_USER_ID") or "").strip()
    if user_id:
        profiles = Path.home() / ".camofox" / "profiles"
        if not profiles.is_dir() or not any(profiles.iterdir()):
            findings.append(
                finding(
                    tool_id,
                    "recommended",
                    "env",
                    "BROWSER_CAMOFOX_USER_ID",
                    "Camofox session has no ~/.camofox/profiles yet. Import cookies or log in once. See tools/browser/SETUP-BROWSER.md",
                )
            )
    cookies_path = (environment.get("BROWSER_IMPORT_COOKIES_PATH") or "").strip()
    if cookies_path:
        path = Path(cookies_path).expanduser()
        if not path.is_absolute():
            cookies_dir = Path(environment.get("CAMOFOX_COOKIES_DIR") or (Path.home() / ".camofox" / "cookies"))
            path = cookies_dir / cookies_path
        if not path.is_file():
            findings.append(
                finding(
                    tool_id,
                    "recommended",
                    "file",
                    "BROWSER_IMPORT_COOKIES_PATH",
                    "cookie file not found. See tools/browser/SETUP-BROWSER.md",
                )
            )
    return findings


def evaluate(root: Path, environment: dict[str, str]) -> dict[str, Any]:
    lock_path = root / "backend.lock.json"
    if not lock_path.is_file():
        raise FileNotFoundError(f"missing {lock_path}")
    parsed = json.loads(lock_path.read_text(encoding="utf-8"))
    tool_id = ""
    if isinstance(parsed, dict):
        tool = parsed.get("tool")
        if isinstance(tool, dict) and isinstance(tool.get("name"), str):
            tool_id = tool["name"]
    inventory_id = (environment.get("POLARIS_TOOL_ID") or "").strip()
    tool_id = inventory_id or tool_id or root.name
    checked = collect_lock_checks(tool_id, lock_path, environment)
    extra_keys = {
        item.get("key")
        for item in (parsed.get("prerequisites") or {}).get("env") or []
        if isinstance(item, dict)
    }
    if extra_keys & {
        "DISPLAY",
        "BROWSER_CAMOFOX_URL",
        "BROWSER_CAMOFOX_USER_ID",
        "BROWSER_IMPORT_COOKIES_PATH",
    }:
        for item in collect_live_findings(tool_id, environment):
            apply_finding(checked, item)
    missing = [item for item in checked if item["status"] == "missing"]
    required = [item for item in missing if item["kind"] == "required"]
    recommended = [item for item in missing if item["kind"] == "recommended"]
    return {
        "ok": len(required) == 0,
        "toolId": tool_id,
        "lockPath": str(lock_path),
        "checked": checked,
        "missingRequired": required,
        "missingRecommended": recommended,
    }


def format_lines(report: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    for item in report.get("checked") or []:
        if item.get("status") == "ok":
            lines.append(f"ok {item['type']} {item['toolId']} {item['key']}")
            continue
        line = f"{item['kind']} {item['type']} {item['toolId']} {item['key']}: {item['reason']}"
        if item.get("next") and item["next"] != item["reason"]:
            line += f" — {item['next']}"
        lines.append(line)
    if not lines:
        lines.append(f"{report['toolId']}: no lock prerequisites")
    return lines


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Check one Polaristool backend.lock.json")
    parser.add_argument("--root", default=".", help="Tool directory that owns backend.lock.json")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    report = evaluate(Path(args.root).resolve(), dict(os.environ))
    if args.json:
        sys.stdout.write(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    else:
        sys.stdout.write("\n".join(format_lines(report)) + "\n")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
