# Literature venue scope

## Product bounds

| # | Bound | Rule |
|---|--------|------|
| 1 | **Time** | Last **5** calendar years inclusive of the current year (as of 2026 → **2022–2026**). |
| 2 | **Venue** | Default: paper must appear in the **CCF recommended** international journals/conferences (A/B/C), catalog edition **2026**. Opt out with `payload.literature_scope.venue_filter: false`. |
| 3 | **arXiv CoRR** | Treated as **one unit**. Default **allowed** as a CCF exception. Set `allow_arxiv_corr: false` to drop **pure** preprints. Dual-published arXiv records stay if a peer CCF venue can be resolved (see below). |
| 4 | **Count** | **No number cap.** Expand until no new papers remain that satisfy 1–3 and 5. |
| 5 | **Topic** | Optional keyword filter on title+abstract (`scope.include` / `topic_keywords`). Opt out with `topic_filter: false`. LLM topic-judge is separate (`topic_judge`). |

### Dual-published arXiv → peer venue

Sample check (10 arXiv ids): peer venue often appears in (1) S2
`externalIds.DBLP` / `container-title`, and/or (2) arXiv Atom `comment` /
`journal_ref` (e.g. `Accepted to ICML 2025`). OpenReview search-by-id was
unreliable for this sample.

Resolution order before `arxiv_corr_excluded`:

1. **DBLP key** from `externalIds.DBLP` (`conf/emnlp/…` → `conf/emnlp`); skip
   `journals/corr`.
2. **Venue labels** already on the record (CCF abbr / full-name match).
3. **Optional arXiv Atom enrich** (cached in `POLARIS_LITERATURE_CACHE_ROOT/arxiv-meta/`): parse
   `journal_ref` + `comment`. Workshop-only comments are **not** promoted to
   the parent CCF main track.
4. CCF hit → **keep** even if host/DOI is still arXiv; else if
   `allow_arxiv_corr` is false → **exclude**.

Source PDF (official download):

https://www.ccf.org.cn/ccf/contentcore/resource/download?ID=112CF3BF7E1140ACEB271ADAED12A67ADFABB8FF099E40C2759502A85C8A281F

Parsed catalog: `ccf-recommended-2026.json` (**681** venues: 295 journals + 386 conferences).

## Regenerate catalog

```sh
curl -sSL -o /tmp/ccf.pdf 'https://www.ccf.org.cn/ccf/contentcore/resource/download?ID=112CF3BF7E1140ACEB271ADAED12A67ADFABB8FF099E40C2759502A85C8A281F'
pdftotext -layout /tmp/ccf.pdf /tmp/ccf.txt
python3 scripts/parse_ccf_catalog.py --text /tmp/ccf.txt \
  --output scopes/ccf-recommended-2026.json \
  --edition-year 2026
```

## Code

`literature/scope.py`:

- `default_bounds()` / `LiteratureBounds.last_n_years(5)`
- `VenueCatalog.load()` — CCF JSON
- `evaluate_record(record)` / `filter_records(records)` — accept/reject under bounds + topic
- `topic_keywords_from_input(input)` — keywords from `scope.include` / overrides
- `record_title` / `record_abstract` / `match_topic_keywords` — title+abstract match

Venue match order: DBLP key → abbreviation (+ aliases) → full-name substring.

Topic match: case-insensitive phrase in title+abstract; short/acronym keywords
(e.g. `MCP`) use word boundaries. Crossref JATS tags are stripped.
