# clue-image-review

Turn **still images** (single frame or 轮播/carousel slides) into **text
evidence** for ad-content pipelines. Thin wrapper around
`tools/codex` / system `codex` with a fixed review prompt and JSON output.

Not product IA: call from `ad_content` phase 2 (or manually). Downstream
`ad-content-review` consumes the resulting text, not raw pixels.

## Commands

```sh
./clue-image-review version

./clue-image-review review \
  --image path/to/frame1.jpg \
  --image path/to/frame2.jpg \
  --output /tmp/image-review.json \
  --dry-run
```

| Flag | Meaning |
|------|---------|
| `--image` | Repeatable image path (carousel = multiple `--image`) |
| `--prompt-extra` | Extra instructions appended to the default prompt |
| `--model` | Codex model (default `gpt-5.4-mini` / `CODEX_MODEL`) |
| `--dry-run` | No Codex call; synthetic text from filenames for tests |
| `--output` | Wrapper JSON (`clue.image-review.v1`) |

## Output sketch

```json
{
  "schema_version": "clue.image-review.v1",
  "status": "succeeded",
  "images": [{"path": "…", "index": 0}],
  "text": "…",
  "ocr_text": "…",
  "tags": [],
  "evidence": [{"quote": "…", "locator": "image@0"}],
  "model": "…",
  "dry_run": true
}
```

## Carousel

Pass each slide as `--image`. Locators use `image@N` / `carousel@N`.
