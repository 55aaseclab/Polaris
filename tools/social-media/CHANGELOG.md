# Changelog

## 0.4.1 — 2026-07-28

- Cache successful social-media tasks under
  `POLARIS_LITERATURE_CACHE_ROOT/social-media/` so
  re-running the same platform + query does not re-spend JustOneAPI credit.
- Cache key is platform + route + normalized query (not max_pages): a larger
  page set satisfies smaller requests; a smaller set can seed a larger one.
- CLI: `--no-cache` skips read/write; `--refresh-cache` forces live fetch and
  overwrites the entry. Disable globally with `SOCIAL_MEDIA_CACHE=0`, or set
  `SOCIAL_MEDIA_CACHE=/path` for an alternate root.
- Run JSON reports `cache: {hits, misses, puts, partial_hits}`. Cache stores
  candidates only (no token, no raw provider payload).

## 0.4.0 — 2026-07-28

- Enabled a Xiaohongshu (RedNote) note-search route via JustOneAPI
  `xiaohongshu.search_note_v4` (`/api/xiaohongshu/search-note/v4`).
- Added `pagination_style: page` with optional session fields (`search_id`,
  `session_id`) for multi-page XHS search.
- Added `candidate_adapter: content_note` for ad/content intel (public notes
  without a business-account gate); Instagram remains `business_account`.
- Candidates may include a `content` object (`note_id`, title, note_type,
  author, engagement). Content notes merge by post URL, not account handle.
- Documented both Instagram and Xiaohongshu as enabled platforms.

## 0.3.1 — 2026-07-12

- Switched social-candidate output schema names and target-market confirmation
  wording to the generic customer-data collection contract.

## 0.3.0 — 2026-07-12

- Added `--workspace`, `--workspaces-root` and `--run-id` to batch, resume and
  account-enrichment operations.
- Standard social runs now read `inputs/input.json` and resolve run state below
  `acquisition/customer-data-collection/runs/` without changing token handling.

## 0.2.3 — 2026-07-12

- Reconciled each account-enrichment task checkpoint from the merged candidate
  output, preserving correct per-task audit counts after an interrupted run.

## 0.2.2 — 2026-07-12

- Kept the parent social-media run candidate count synchronized with completed
  account-enrichment output.

## 0.2.1 — 2026-07-12

- Classified JustOneAPI `TOO FAST` responses as `blocked_rate_limit`.
- Reduced default account-enrichment parallelism to four requests to respect
  provider pacing while retaining resumable checkpoints.

## 0.2.0 — 2026-07-12

- Added a resumable, configuration-driven account-enrichment stage.
- Added JustOneAPI Instagram post-detail and user-profile calls for discovering
  explicit public business evidence after a hashtag search exposes only post
  metadata and an owner ID.
- Persisted only post shortcodes as non-personal checkpoints; unqualified
  usernames and profile payloads are discarded instead of being archived.

## 0.1.2 — 2026-07-12

- Changed the default local token location to the ignored `social-media/.env`.

## 0.1.1 — 2026-07-12

- Added `--token-file -` for a one-line, standard-input token that is never
  persisted to a file. This supports safe recovery with a newly issued token.

## 0.1.0 — 2026-07-12

- Added the platform-generic `clue-justoneapi-cli` wrapper.
- Locked the official JustOneAPI Python SDK at `v3.0.30`.
- Added an Instagram hashtag-search route for the current Songjin tasks.
- Added per-task persistence, safe error classification, and `resume` support
  for insufficient credit, rate limiting, authentication and transport errors.
- Limited retained output to public accounts with explicit business evidence;
  comments, media, private contact data and unverified personal accounts are
  discarded.
