# clue-industry-directory-cli

`clue-industry-directory-cli` is a versioned wrapper for the
`source_type=industry_directories` stage. It does **not** scrape an entire
directory or claim that a listing is a qualified customer. Instead, it creates
one directory-targeted web-search task for each configured directory domain,
retains only results whose URL host matches that directory, and records enough
trace data for a later official-site verification stage.

It is built on the locally version-locked
[`clue-web-search-cli`](../web-search/README.md), whose SearXNG source revision
and container image digest are recorded again in
[`backend.lock.json`](backend.lock.json). The wrapper verifies the exact hash of
the dependent lock file before it runs.

## Why a wrapper instead of a GitHub yellow-pages scraper

The GitHub search performed on 2026-07-12 found no mature, locally runnable,
general-purpose business-directory scraper suitable for this workflow. The
dedicated projects were either outdated single-site scripts, had no clear
license, or were thin wrappers around a hosted platform. Directory page
structures and terms also vary by publisher, so treating a generic Yellow
Pages script as a universal backend would make results unreliable.

This tool keeps the two responsibilities separate:

1. Discover public directory listing pages through a versioned local search
   backend, then strictly filter results to the requested directory hostname.
2. Add a publisher-specific adapter only after the target directory, its public
   fields, pagination behavior, and applicable terms have been reviewed.

## Locked dependency

- Wrapper version: `0.2.1`.
- Search-wrapper version: `0.2.1`.
- SearXNG source: `c19d86faa393bdd696a5708e3c294f956d750683`.
- SearXNG runtime digest:
  `sha256:fb4a500b95b29304b2e08b2bd4162a41ef805f6ade98e6075d12187b9fde3639`.

Check the dependency before running:

```sh
./clue-industry-directory-cli version
./clue-industry-directory-cli backend-status
```

## Run a workspace directory-discovery stage

Set `directory_domains` on the `source_type=industry_directories` source in the
customer input. Directory publishers are market-specific, so there is no
country or publisher allowlist in the tool. The CLI argument
`--directory-domains <comma-separated-hostnames>` overrides the input for a
one-off run. The tool discovers public listing pages only; the later
`clue-augmentation augment` stage must still
verify the company, buyer type, product fit, and a public business contact
path. Website verification is triggered from a discovered candidate URL; it is
not another `sources[]` entry.

Run the following from `tools/industry-directories`. Set
`POLARIS_BUSINESS_WORKSPACES_ROOT` in the environment; the repository
`.env.dev` is the normal local configuration source.

```sh
set -a
source ../../.env.dev
set +a
```

```sh
./clue-industry-directory-cli batch \
  --workspace <workspace-id> \
  --run-id <run-id>
```

`--workspace <workspace-id>` resolves the collection scope, reads
`inputs/input.json`, and writes the wrapper plus its child web-search run under
`runs/`. Explicit `--input` and `--output` remain available for non-standard or
legacy runs.

For example, the relevant source object is:

```json
{
  "source_type": "industry_directories",
  "directory_domains": ["directory.example", "trade.example"],
  "tasks": []
}
```

To use a different set of publishers, pass a comma-separated allowlist of
hostnames:

```sh
./clue-industry-directory-cli batch \
  --workspace <workspace-id> \
  --run-id <run-id> \
  --directory-domains local.ch,search.ch
```

The output directory contains:

```text
2026-07-12-industry-directories/
├── commands.jsonl                    # wrapper-to-backend invocation trace
├── directory-candidates.json          # public listing-page candidates only
├── execution-log.md                   # readable wrapper execution log
├── generated-web-search-input.json    # reproducible directory-targeted tasks
├── run.json                           # wrapper/dependency versions and counts
└── web-search/                        # underlying search run and API calls
```

If a completed child search run needs its wrapper output rebuilt, for example
after an interrupted local post-processing step, use the following command. It
does not submit any search requests and refuses to overwrite a valid existing
`directory-candidates.json` file (an invalid partial file is cleared safely).

```sh
./clue-industry-directory-cli finalize \
  --workspace <workspace-id> \
  --run-id <run-id>
```

No personal profiles, reviewer content, or private contact data are collected.
The `directory-candidates.json` file intentionally contains directory listing
URLs rather than a final contact database. Keep all results local and follow
the relevant search engine and directory terms before adding a direct
publisher-specific adapter.
