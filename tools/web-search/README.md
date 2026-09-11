# clue-web-search-cli

`clue-web-search-cli` is a versioned batch wrapper around a local
[SearXNG](https://github.com/searxng/searxng) metasearch backend. It turns the
`source_type=web_search` tasks in a collection input into structured candidate
pages while keeping the source checkout, runtime image and every query
auditable.

## Pinned backend

- Wrapper version: `0.2.1`.
- SearXNG source: `c19d86faa393bdd696a5708e3c294f956d750683`.
- Published runtime tag: `2026.7.12-c19d86faa`.
- Runtime digest:
  `sha256:fb4a500b95b29304b2e08b2bd4162a41ef805f6ade98e6075d12187b9`.
- Local API binding: `127.0.0.1:8188`; it is never exposed on the network.

Check the source clone and version lock:

```sh
./clue-web-search-cli version
./clue-web-search-cli backend-status
```

Prepare the locked runtime:

```sh
./clue-web-search-cli build-backend
```

## Run a workspace web-search source

The following command processes every `web_search` task in a customer's input,
uses Google, DuckDuckGo and Bing through the local SearXNG API, retains at most
10 results per task, and stops the local server on completion.

Run the following from `tools/web-search`. Polaristool does not set a host
workspace root. Pass `--workspaces-root` with `--workspace`, or use
explicit `--input` and `--output`.

```sh
set -a
source ../../.env
set +a
```

```sh
./clue-web-search-cli batch \
  --workspace <workspace-id> \
  --run-id <run-id>
```

`--workspace <workspace-id>` resolves the collection scope, reads
`inputs/input.json`, and creates the run under `runs/`. Use explicit `--input`
and `--output` only for an intentionally non-standard or legacy invocation.

The output directory contains:

```text
2026-07-12-web-search/
├── commands.jsonl      # every local SearXNG API call and its parameters
├── execution-log.md    # readable command and task-status log
├── results.json        # all structured web-search task results
├── run.json            # version, run status and success/failure counts
└── tasks/              # one structured result file per input task
```

The final results retain only public search result fields: title, URL, snippet,
engine, score, category and published date. Transient SearXNG response files
are deleted once each task result is structured.

## Scope and next stage

Web search discovers candidate pages and public evidence; it does not prove
that a company meets the collection filters. Before a record becomes a formal
`collected_lead_records` entry, the official-site stage must confirm the
company, market, buyer type, product fit and public business contact path.

Review search-engine and target-site terms before use. Keep the output local;
the search backend is bound to loopback and contains no API credentials.
