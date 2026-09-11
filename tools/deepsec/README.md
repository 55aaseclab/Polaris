# clue-deepsec-cli

`clue-deepsec-cli` searches the Intelligent Cybersecurity Paper Retrieval
System HTTP API. It preserves the returned papers without inferring relevance.

There is no hardcoded DeepSec host. Set `POLARIS_LITERATURE_DEEPSEC_API_URL`
or `DEEPSEC_API_URL` before search. Polaristool does not invent this URL.

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
