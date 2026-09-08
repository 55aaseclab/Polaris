# clue-crossref-cli

Bounded public Crossref metadata discovery for literature collection. It does
not download PDFs or infer relevance.

Used with `tools/semantic-scholar` for dual-source expansion (Crossref
reference lists + Semantic Scholar citations/refs).

```sh
./clue-crossref-cli doi --doi 10.1145/3808103 --output seed.json
./clue-crossref-cli search --query "AI agent permission isolation" --output works.json

# Uses POLARIS_LITERATURE_WORKSPACES_ROOT from .env.
./clue-crossref-cli doi --workspace <workspace-id> --run-id <run-id> \
  --doi 10.1145/3808103
```

Use the returned title, DOI, URL, publication metadata and abstract only as
source observations; preserve the raw JSON as a run artifact.
