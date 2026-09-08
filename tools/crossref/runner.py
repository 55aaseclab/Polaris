#!/usr/bin/env python3
"""Bounded Crossref metadata discovery."""
from __future__ import annotations
import argparse, json, os, re, sys
from pathlib import Path
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

TOOL_NAME = "clue-crossref-cli"
BASE = "https://api.crossref.org"
class CliError(Exception): pass
def base_url() -> str:
    return (
        os.environ.get("POLARIS_LITERATURE_CROSSREF_API_URL")
        or os.environ.get("CROSSREF_API_URL")
        or BASE
    ).rstrip("/")
def fetch(path: str) -> dict:
    try:
        with urlopen(Request(f"{base_url()}{path}", headers={"User-Agent": "clue-crossref-cli/0.1 (research)"}), timeout=30) as r:
            value=json.loads(r.read().decode("utf-8"))
    except (HTTPError, URLError, json.JSONDecodeError) as e: raise CliError(f"Crossref request failed: {e}") from e
    if value.get("status") != "ok": raise CliError("Crossref returned non-ok response")
    return value["message"]
def write(path: str, value: dict) -> None:
    target=Path(path).expanduser().resolve(); target.parent.mkdir(parents=True, exist_ok=True); target.write_text(json.dumps(value,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")

def output_path(args: argparse.Namespace, filename: str) -> str:
    if args.output:
        return args.output
    if not args.workspace or not args.run_id:
        raise CliError("--output is required unless both --workspace and --run-id are provided")
    root = os.environ.get("POLARIS_LITERATURE_WORKSPACES_ROOT")
    if not root:
        raise CliError("POLARIS_LITERATURE_WORKSPACES_ROOT is required for --workspace")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,62}", args.workspace):
        raise CliError("invalid workspace ID")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", args.run_id):
        raise CliError("invalid run ID")
    return str(Path(root).resolve() / args.workspace / "acquisition" / "customer-data-collection" / "runs" / args.run_id / filename)
def main(argv: list[str]) -> int:
    p=argparse.ArgumentParser(prog=TOOL_NAME); s=p.add_subparsers(dest="cmd",required=True); s.add_parser("version")
    doi=s.add_parser("doi"); doi.add_argument("--doi",required=True)
    search=s.add_parser("search"); search.add_argument("--query",required=True); search.add_argument("--from-pub-date",default="2021-01-01"); search.add_argument("--until-pub-date",default="2026-12-31"); search.add_argument("--rows",type=int,default=20)
    for command in (doi, search):
        command.add_argument("--output")
        command.add_argument("--workspace")
        command.add_argument("--run-id")
    a=p.parse_args(argv)
    try:
        if a.cmd=="version": print(json.dumps({"tool":TOOL_NAME,"version":(Path(__file__).parent/"VERSION").read_text().strip()},indent=2)); return 0
        if a.cmd=="doi": payload={"schema_version":"clue.crossref.work.v1","work":fetch("/works/"+quote(a.doi,safe="/"))}
        else:
            if not 1 <= a.rows <= 100: raise CliError("--rows must be 1..100")
            query=urlencode({"query.bibliographic":a.query,"filter":f"from-pub-date:{a.from_pub_date},until-pub-date:{a.until_pub_date}","rows":a.rows})
            payload={"schema_version":"clue.crossref.search.v1","query":a.query,"items":fetch("/works?"+query).get("items",[])}
        destination = output_path(a, "seed.json" if a.cmd == "doi" else "results.json")
        write(destination,payload); print(json.dumps({"status":"succeeded","output":str(Path(destination).resolve())},indent=2)); return 0
    except CliError as e: print(f"error: {e}",file=sys.stderr); return 2
if __name__=="__main__": raise SystemExit(main(sys.argv[1:]))
