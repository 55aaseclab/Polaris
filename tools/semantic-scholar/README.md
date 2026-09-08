# clue-semantic-scholar-cli

Bounded client for the [Semantic Scholar](https://www.semanticscholar.org/)
Graph API (Allen Institute for AI). Used for literature **expansion**: inbound
citations and outbound references by DOI.

## Auth (recommended for batch expand)

```sh
export SEMANTIC_SCHOLAR_API_KEY=...
```

Without a key the public rate limit is easy to hit (HTTP 429).

## Commands

```sh
./clue-semantic-scholar-cli version

./clue-semantic-scholar-cli paper \
  --doi 10.1145/3808103 \
  --output /tmp/paper.json

./clue-semantic-scholar-cli citations \
  --doi 10.1145/3808103 \
  --limit 50 \
  --output /tmp/citations.json

./clue-semantic-scholar-cli references \
  --doi 10.1145/3808103 \
  --limit 100 \
  --output /tmp/references.json

./clue-semantic-scholar-cli search \
  --query "AI agent isolation permissions" \
  --limit 20 \
  --output /tmp/search.json
```

## Schemas

| Command | `schema_version` |
|---------|------------------|
| paper | `clue.semantic-scholar.paper.v1` |
| citations | `clue.semantic-scholar.citations.v1` |
| references | `clue.semantic-scholar.references.v1` |
| search | `clue.semantic-scholar.search.v1` |

Literature expansion dual-sources these results with Crossref (see
`tools/data-collection/literature/expand.py`).
