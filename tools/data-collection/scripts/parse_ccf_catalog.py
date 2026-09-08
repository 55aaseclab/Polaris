#!/usr/bin/env python3
"""Parse CCF recommended venue PDF (text via pdftotext) into scopes JSON.

Example:
  pdftotext -layout ccf-2026.pdf /tmp/ccf.txt
  python3 scripts/parse_ccf_catalog.py --text /tmp/ccf.txt \\
    --output scopes/ccf-recommended-2026.json
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path


def dblp_key(url: str | None) -> str | None:
    if not url:
        return None
    match = re.search(r"/db/(journals|conf|series)/([^/\s\.]+)", url)
    return f"{match.group(1)}/{match.group(2)}" if match else None


def parse_text(text: str) -> list[dict]:
    lines = [line.rstrip() for line in text.splitlines()]
    header_journal = re.compile(r"推荐国际学术期刊")
    header_conf = re.compile(r"推荐国际学术会议")
    field_re = re.compile(r"（([^）]+)）")
    rank_re = re.compile(r"([一二三])、\s*([ABC])\s*类")
    dblp_re = re.compile(r"https?://(?:dblp\.uni-trier\.de|dblp\.org)/[^\s\)）]+", re.I)
    publishers = {
        "ACM",
        "IEEE",
        "Springer",
        "Elsevier",
        "Wiley",
        "USENIX",
        "SIAM",
        "MIT",
        "Press",
        "Springer-Nature",
        "Oxford",
        "Cambridge",
        "Now",
        "AAAI",
        "IJCAI",
        "ACL",
        "PMLR",
        "ICLR",
        "AMIA",
        "CCF",
        "BioMed",
        "Central",
        "Nature",
        "IEEE/ACM",
        "ACM/IEEE",
        "CCF&IEEE",
        "CCF/Springer",
        "ACM&IEEE",
        "IEEE&ACM",
    }

    venues: list[dict] = []
    kind = field = rank = None
    buf: list[str] = []

    def flush_buf() -> None:
        nonlocal buf
        if not buf or kind is None or rank is None:
            buf = []
            return
        block = re.sub(r"\s+", " ", " ".join(x.strip() for x in buf if x.strip())).strip()
        match = re.match(r"^(\d+)\s+(.*)$", block)
        if not match:
            buf = []
            return
        seq = int(match.group(1))
        rest = match.group(2)
        urls = dblp_re.findall(rest)
        url = urls[0].rstrip(").,;") if urls else None
        rest_no_url = re.sub(r"\s+", " ", dblp_re.sub(" ", rest)).strip()
        tokens = rest_no_url.split()
        abbr = None
        publisher = None
        index = 0
        if tokens:
            first = tokens[0]
            if re.match(r"^[A-Za-z][A-Za-z0-9\-/&]*$", first) and len(first) <= 28:
                abbr = first
                index = 1
                if abbr.endswith("-") and index < len(tokens) and re.match(
                    r"^[A-Za-z0-9]+$", tokens[index]
                ):
                    abbr = abbr + tokens[index]
                    index += 1
        rem = tokens[index:]
        while rem and rem[-1] in publishers | {"CS", "Society", "Press", "Central"}:
            if (
                rem[-1] in {"CS", "Society", "Press", "Central"}
                and len(rem) >= 2
                and rem[-2] in {"IEEE", "BioMed", "MIT", "ACM"}
            ):
                publisher = f"{rem[-2]} {rem[-1]}"
                rem = rem[:-2]
                break
            publisher = rem[-1]
            rem = rem[:-1]
            if publisher in publishers:
                break
        venues.append(
            {
                "kind": kind,
                "rank": rank,
                "field": field,
                "abbr": abbr,
                "full_name": " ".join(rem).strip() or None,
                "publisher": publisher,
                "dblp_url": url,
                "dblp_key": dblp_key(url),
                "seq": seq,
            }
        )
        buf = []

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if header_journal.search(stripped):
            flush_buf()
            kind = "journal"
            match = field_re.search(stripped)
            if match:
                field = match.group(1).strip()
            continue
        if header_conf.search(stripped):
            flush_buf()
            kind = "conference"
            match = field_re.search(stripped)
            if match:
                field = match.group(1).strip()
            continue
        match = field_re.search(stripped)
        if match and "类" not in stripped and len(stripped) < 80 and not re.match(
            r"^\d+", stripped
        ):
            field = match.group(1).strip()
            continue
        rank_match = rank_re.search(stripped)
        if rank_match:
            flush_buf()
            rank = rank_match.group(2)
            continue
        if stripped.startswith("序号"):
            continue
        if re.match(r"^\d+\s+", stripped):
            flush_buf()
            buf = [stripped]
            continue
        if buf:
            buf.append(stripped)
    flush_buf()

    seen: set[tuple] = set()
    unique: list[dict] = []
    for venue in venues:
        key = (
            venue["kind"],
            venue["rank"],
            venue.get("abbr"),
            venue.get("dblp_key"),
            venue.get("full_name"),
            venue.get("field"),
        )
        if key in seen:
            continue
        seen.add(key)
        unique.append(venue)
    return unique


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--text", required=True, help="pdftotext -layout output")
    parser.add_argument("--output", required=True)
    parser.add_argument("--source-url", default="")
    parser.add_argument("--edition-year", type=int, default=2026)
    args = parser.parse_args()
    text = Path(args.text).read_text(encoding="utf-8", errors="replace")
    venues = parse_text(text)
    document = {
        "schema_version": "clue.literature.venue-scope.v1",
        "source": {
            "name": f"中国计算机学会推荐国际学术会议和期刊目录（{args.edition_year}年）",
            "url": args.source_url
            or (
                "https://www.ccf.org.cn/ccf/contentcore/resource/download?"
                "ID=112CF3BF7E1140ACEB271ADAED12A67ADFABB8FF099E40C2759502A85C8A281F"
            ),
            "edition_year": args.edition_year,
            "parsed_at": datetime.now(UTC)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z"),
        },
        "venue_count": len(venues),
        "venues": venues,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "status": "succeeded",
                "output": str(output),
                "venue_count": len(venues),
                "by_kind": dict(Counter(v["kind"] for v in venues)),
                "by_rank": dict(Counter(v["rank"] for v in venues)),
                "with_dblp_key": sum(1 for v in venues if v.get("dblp_key")),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
