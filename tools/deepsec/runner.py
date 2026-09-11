#!/usr/bin/env python3
"""Bounded client for the Intelligent Cybersecurity Paper Retrieval API."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


TOOL_NAME = "clue-deepsec-cli"
OUTPUT_SCHEMA = "clue.deepsec.search.v1"
SEARCH_AREAS = ("title", "abstract", "full_text", "structured")


class CliError(Exception):
    """A user-correctable request or response error."""


def read_version(root: Path) -> str:
    return (root / "VERSION").read_text(encoding="utf-8").strip()


def positive_range(value: int, lower: int, upper: int, label: str) -> int:
    if not lower <= value <= upper:
        raise CliError(f"{label} must be between {lower} and {upper}")
    return value


def search_url(
    api_url: str,
    keyword: str,
    search_in: list[str],
    conference: str | None,
    year: int | None,
    limit: int,
    offset: int,
) -> str:
    if not keyword.strip():
        raise CliError("keyword must not be empty")
    invalid_areas = sorted(set(search_in) - set(SEARCH_AREAS))
    if invalid_areas:
        raise CliError(f"unsupported search_in values: {', '.join(invalid_areas)}")
    positive_range(limit, 1, 100, "limit")
    if offset < 0:
        raise CliError("offset must be zero or greater")
    parameters: list[tuple[str, str]] = [("keyword", keyword)]
    parameters.extend(("search_in", area) for area in search_in)
    if conference:
        parameters.append(("conference", conference))
    if year is not None:
        parameters.append(("year", str(year)))
    parameters.extend((("limit", str(limit)), ("offset", str(offset))))
    return f"{api_url}?{urlencode(parameters)}"


def request_search(url: str) -> dict[str, Any]:
    request = Request(url, headers={"Accept": "application/json", "User-Agent": f"{TOOL_NAME}/0.1"})
    try:
        with urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as error:
        raise CliError(f"DeepSec request failed: {error}") from error
    if not isinstance(payload, dict):
        raise CliError("DeepSec response must be a JSON object")
    if not isinstance(payload.get("total"), int) or payload["total"] < 0:
        raise CliError("DeepSec response requires a non-negative integer total")
    if not isinstance(payload.get("papers"), list):
        raise CliError("DeepSec response requires a papers array")
    return payload


def configured_api_url() -> str:
    return (
        os.environ.get("POLARIS_LITERATURE_DEEPSEC_API_URL")
        or os.environ.get("DEEPSEC_API_URL")
        or ""
    ).strip().rstrip("?")


def resolve_api_url() -> str:
    url = configured_api_url()
    if not url:
        raise CliError(
            "set POLARIS_LITERATURE_DEEPSEC_API_URL or DEEPSEC_API_URL"
        )
    return url


def write_json(path: Path, value: dict[str, Any]) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def command_search(args: argparse.Namespace, root: Path) -> int:
    keyword = args.keyword or args.question
    if not keyword:
        raise CliError("one of --keyword or --question is required")
    api_url = resolve_api_url()
    url = search_url(
        api_url,
        keyword,
        args.search_in,
        args.conference,
        args.year,
        args.limit,
        args.offset,
    )
    response = request_search(url)
    output = {
        "schema_version": OUTPUT_SCHEMA,
        "tool": {"name": TOOL_NAME, "version": read_version(root)},
        "request": {
            "endpoint": api_url,
            "keyword": keyword,
            "search_in": args.search_in,
            "conference": args.conference,
            "year": args.year,
            "limit": args.limit,
            "offset": args.offset,
            "url": url,
        },
        "total": response["total"],
        "papers": response["papers"],
    }
    output_path = Path(args.output)
    write_json(output_path, output)
    print(
        json.dumps(
            {
                "status": "succeeded",
                "output": str(output_path.expanduser().resolve()),
                "total": response["total"],
                "returned": len(response["papers"]),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def main(argv: list[str]) -> int:
    root = Path(__file__).parent
    parser = argparse.ArgumentParser(prog=TOOL_NAME)
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("version")
    search = subcommands.add_parser("search", help="Search cybersecurity papers.")
    terms = search.add_mutually_exclusive_group(required=True)
    terms.add_argument("--keyword")
    terms.add_argument("--question")
    search.add_argument("--search-in", action="append", choices=SEARCH_AREAS, default=[])
    search.add_argument("--conference")
    search.add_argument("--year", type=int)
    search.add_argument("--limit", type=int, default=20)
    search.add_argument("--offset", type=int, default=0)
    search.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "version":
            print(
                json.dumps(
                    {
                        "tool": TOOL_NAME,
                        "version": read_version(root),
                        "output_schema": OUTPUT_SCHEMA,
                        "api_url": configured_api_url(),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
        return command_search(args, root)
    except CliError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
