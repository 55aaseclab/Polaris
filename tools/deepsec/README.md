# clue-deepsec-cli

`clue-deepsec-cli` searches the Intelligent Cybersecurity Paper Retrieval
System HTTP API. It preserves the returned papers without inferring relevance.

The default API URL is `http://128.179.165.148:8123/api/papers/search`. Set
`DEEPSEC_API_URL` to override it. The public wrapper loads repository `.env`.

```sh
./clue-deepsec-cli search \
  --keyword "AI agent permission isolation" \
  --search-in title \
  --search-in abstract \
  --conference CCS \
  --year 2024 \
  --limit 20 \
  --output results.json
```

Use `--question` when no refined keyword is supplied. It is sent verbatim,
which preserves the caller's Chinese or English wording. The caller should
provide concise retrieval terms when greater precision is needed.

The output uses `clue.deepsec.search.v1` and preserves `total`, request
parameters, and the API's `papers[]` fields.
