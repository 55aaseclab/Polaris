# clue-gogole-map-cli

`clue-gogole-map-cli` is a versioned, local wrapper around
[`gosom/google-maps-scraper`](https://github.com/gosom/google-maps-scraper).
The wrapper name intentionally follows the requested `gogole` spelling. The
backend is a separate, unmodified Git clone under `backend/`.

## Versioning

- `VERSION` is the wrapper version. The current version is `0.4.1`.
- `backend.lock.json` pins the upstream repository, tag, full commit and local
  Docker image name. It also pins the published backend runtime to an immutable
  Docker digest. The current backend is `gosom/google-maps-scraper` at
  `v1.9.2` / `27f774576996a45be662b6265dd4d45364d401ac`, with runtime digest
`sha256:54aa343710e851b172fc4715990de68cc8c98f376d1637efcf07f4640ae36654`.
The lock also records that image's built-in Playwright driver directory; the
CLI supplies it explicitly at runtime so it does not attempt an obsolete driver
download.
- `CHANGELOG.md` records wrapper releases.
- Every completed or failed run writes `run.json` beside its query file and
  output. It captures the wrapper version, backend revision, options, query
  list, status and result path.

Check all locked versions and the backend checkout:

```sh
./clue-gogole-map-cli version
./clue-gogole-map-cli backend-status
```

To upgrade the upstream backend deliberately, use a released semver tag and
the immutable Docker digest published for that tag. This updates both the clone
checkout and `backend.lock.json`; it never follows `main` implicitly.

```sh
./clue-gogole-map-cli backend-upgrade \
  v1.9.2 \
  sha256:54aa343710e851b172fc4715990de68cc8c98f376d1637efcf07f4640ae36654 \
  /opt/ms-playwright-go/1.52.0
./clue-gogole-map-cli build-backend
```

After an upgrade, update `VERSION` and `backend.lock.json` together only when
the wrapper itself changes, then add the release entry to `CHANGELOG.md`.

## Prerequisites

- Docker daemon available to the local user.
- `jq`, `git`, Bash and standard POSIX utilities.

The normal `build-backend` command pulls the published upstream image by its
locked digest, then tags it locally as `clue-gogole-map-backend:gosom-v1.9.2`.
It does not pull a mutable `latest` tag. Use `build-backend --from-source` only
when debugging the checked-out upstream Dockerfile. The first Maps scrape may
create the named Docker volume used for Playwright files.

## Customer workspace location

For a standard customer run, set the shared workspace root from the
repository-level `.env`. Run the following from `tools/google-map`:

```sh
set -a
source ../../.env
set +a
```

`--workspace <workspace-id>` resolves the collection scope to:

```text
$POLARIS_BUSINESS_WORKSPACES_ROOT/<workspace-id>/acquisition/customer-data-collection/
```

With a `--run-id`, the default result is written under that scope's `runs/`.
`--output` remains available as an explicit legacy/one-off override.

## Customer-search run

Preview a configured query without building an image or sending a request:

```sh
./clue-gogole-map-cli run \
  --workspace <workspace-id> \
  --run-id <run-id> \
  --queries examples/target-market.queries.txt \
  --lang <language-code> \
  --depth 1 \
  --dry-run
```

Build the locked backend and run the search:

```sh
./clue-gogole-map-cli build-backend

./clue-gogole-map-cli run \
  --workspace <workspace-id> \
  --run-id <run-id> \
  --query 'product category in target city' \
  --lang <language-code> \
  --depth 1
```

The workspace run is created below:

```text
<collection-scope>/runs/<run-id>/
├── queries.txt
├── results.json
└── run.json
```

`results.json` is a valid JSON array. The wrapper keeps only public
business-listing fields: company name, category, address, official website,
business phone, Maps link, aggregate rating, hours and location. It removes
review text, reviewer profiles, owner profiles and images before saving the
result, then deletes the transient upstream NDJSON file.

If no `--run-id` is supplied outside workspace mode, the legacy default remains
`tools/google-map/runs/<UTC-timestamp>/`.

To choose an output path, use `--output`. The wrapper will create a `run.json`
next to that result file:

```sh
./clue-gogole-map-cli run \
  --queries examples/target-market.queries.txt \
  --lang <language-code> \
  --output ./exports/results.json
```

`--email` is deliberately opt-in. It asks the backend to visit each official
website to extract publicly displayed email addresses, which is slower. The
candidate-pool step should usually start without it and first retain only
businesses with an official website.

`--lang` defaults to `en`. Set it explicitly from each collection task's
locale; a Maps run should not inherit another customer's search language.

## Boundaries

Use the tool only for public business listings and public business contact
paths. Do not put personal data into query files, and do not treat a Maps
listing as sufficient evidence of buyer fit. The collected results still need
the official-site verification, deduplication and qualification stages defined
in the workspace collection `inputs/input.json`.

Review Google Maps terms, website terms and applicable privacy rules before
each run. Use low depth and low concurrency for the first run.

公开评论/用户名未采集。
