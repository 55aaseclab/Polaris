# clue-justoneapi-cli

`clue-justoneapi-cli` is a versioned, resumable wrapper around the official
[JustOneAPI Python SDK](https://github.com/justoneapi/justoneapi-python). The
CLI is platform-generic: supported platforms and methods live in
[`config/platform-routes.json`](config/platform-routes.json), while all
collection runs share the same per-task state, error handling and recovery
rules. It is not an Instagram-specific executable.

Enabled routes (see [`config/platform-routes.json`](config/platform-routes.json)):

| Platform key | SDK method | Adapter | Use |
|--------------|------------|---------|-----|
| `instagram` | `search_hashtag_posts_v1` | `business_account` | B2B lead discovery |
| `xiaohongshu` | `search_note_v4` | `content_note` | Ad / content intel notes |

Adding another JustOneAPI social platform means adding a route definition and
an adapter (`business_account` or `content_note`); it does not require a new
CLI or secret-handling mechanism. Xiaohongshu docs:
[xiaohongshu-rednote](https://docs.justoneapi.com/zh/api/xiaohongshu-rednote/).

## Fixed backend

- CLI version: `0.4.1`.
- Official SDK: `justoneapi/justoneapi-python` `v3.0.30`.
- Pinned commit: `9fe12fe4244412279283204651af104d3ba046af`.
- SDK license: MIT.
- Production API: `https://api.justoneapi.com`.

The exact backend and runtime requirements are recorded in
[`backend.lock.json`](backend.lock.json). The upstream SDK clone is deliberately
ignored by the parent `tools` Git repository; the lock records its source
revision. The wrapper refuses to run when that checkout differs from the lock
or has local changes.

```sh
./clue-justoneapi-cli version
./clue-justoneapi-cli backend-status
```

## Token handling

Token resolution order:

1. Environment `JUSTONEAPI_TOKEN`
2. Repository-root `.env` key `JUSTONEAPI_TOKEN=…` (shared site config)
3. Legacy: first non-comment line of `--token-file` / tool-local `.env`

The token is never printed, copied, added to command logs, placed in run
output, or committed to Git. Override the file with `--token-file <path>`, or
pass `--token-file -` to read one line from stdin.

For a one-off replacement token that must not be written to disk, pass
`--token-file -`; the wrapper reads exactly one line from standard input. This
is especially useful when resuming a run after a replacement token was issued.

## Shared task cache

Successful tasks are cached under `POLARIS_LITERATURE_CACHE_ROOT/social-media/` keyed by
**platform + route + normalized query**. Re-running the same search reuses
candidates and does **not** call JustOneAPI again.

| Control | Effect |
|---------|--------|
| (default) | Read + write cache |
| `--no-cache` | Skip cache entirely for this run |
| `--refresh-cache` | Ignore hits; live fetch; overwrite entry |
| `SOCIAL_MEDIA_CACHE=0` | Disable cache process-wide |
| `SOCIAL_MEDIA_CACHE=/path` | Alternate cache root |

`max_pages` is not part of the key: a 2-page cache satisfies a 1-page request;
a 1-page cache can seed a 2-page run (partial hit, then live pages). Cache
entries hold candidates only — never the token or raw provider payloads.
Batch/resume stdout includes `cache: {hits, misses, puts, partial_hits}`.

## Run a workspace social-media source

The default is one API page per task. It limits paid API use while producing a
first discovery set; pass `--max-pages` explicitly when more pagination has
been approved.

Run the following from `tools/social-media`. Polaristool does not set a
host workspace root. Pass `--workspaces-root` with `--workspace`. The
repository `.env` is the normal local configuration source and does not
expose or replace the separate local JustOneAPI token file.

```sh
set -a
source ../../.env
set +a
```

```sh
./clue-justoneapi-cli batch \
  --workspace <workspace-id> \
  --run-id <run-id>
```

`--workspace <workspace-id>` resolves the collection scope, reads
`inputs/input.json`, and creates the source run under `runs/`. `--input` and
`--output` are retained as explicit non-standard or legacy overrides.

The output directory contains:

```text
2026-07-12-social-media/
├── commands.jsonl                 # request/result metadata, never the token
├── execution-log.md               # command, SDK pin and task-status log
├── input.snapshot.json            # input used for this reproducible run
├── run.json                       # status, counts, blocked error metadata
├── social-media-candidates.json   # public business-account candidates only
└── tasks/                          # checkpoint after every API attempt
```

## Enrich discovered posts into business-account candidates

Some APIs return post metadata without an account handle. When a route defines
`account_enrichment`, the following command replays the configured discovery
search, keeps only public post shortcodes as checkpoints, calls the configured
post-detail and profile methods, then retains an account only when the profile
has explicit business evidence. It resumes the enrichment checkpoint when a
provider error occurs.

```sh
./clue-justoneapi-cli enrich \
  --workspace <workspace-id> \
  --run-id <run-id>
```

The enrichment stage does not archive unqualified usernames, profile payloads,
emails, phone numbers, business addresses, comments or media. It updates
`social-media-candidates.json` with qualifying public business accounts and
adds an `enrichment/` folder containing safe request metadata and checkpoints.
Account enrichment uses a conservative default parallelism of four; a provider
`TOO FAST` response is recorded as `blocked_rate_limit` and can be resumed
after the provider permits further requests.

## Provider errors and resume

JustOneAPI business errors are not treated as success merely because the HTTP
request returned JSON. The wrapper records the provider `code`, `message` and
`requestId` (with token redaction), then classifies the task as one of:

- `blocked_insufficient_credit` — balance, arrears, payment or credit wording;
  the entire run stops before spending requests on later tasks.
- `blocked_rate_limit` — rate or quota wording; later tasks remain pending.
- `blocked_authentication` or `blocked_permission` — token/account condition.
- `failed_business_error` or `failed_transport` — provider or network failure
  that can be retried after inspection.

After correcting the condition — for example, after topping up a balance — run
the following command. It reads the saved input snapshot, skips completed
tasks, preserves prior candidates and resumes from the saved cursor where one
exists.

```sh
./clue-justoneapi-cli resume \
  --workspace <workspace-id> \
  --run-id <run-id>
```

An insufficient-credit run exits with code `75`; other blocked or failed runs
exit with code `1`, but always write the run state and a safe terminal summary
before exiting.

## Data boundary

Policy is per route (`public_data_policy` + `candidate_adapter`):

- **Instagram (`business_account`)** — retain only records with explicit public
  business evidence (business flag/category). Unverified personal accounts are
  discarded. A retained candidate is still not a formal customer lead; later
  augmentation must verify business identity, market, buyer type, and website.
- **Xiaohongshu (`content_note`)** — retain public notes with a stable note id
  and title/author for ad-content-intel. No business-account gate. Comments,
  media binaries, and raw provider payloads are still discarded.

Neither adapter stores the API token, private contact data, or full raw JSON
responses in candidate output.
