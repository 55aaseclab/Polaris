# polaris-product-video

Generate platform-ready short promo videos from a **ready product**
plus a **fully specified script**. One case = one product.

## Scope

In scope:

- stills + motion (`ffmpeg_kenburns`)
- required audio (BGM; optional voiceover; TTS API slot reserved)
- 9:16 master, cover frame, SRT captions
- purpose contracts: `seed` / `unbox` / `scene` / `compare`

Out of scope:

- writing hooks or scripts
- content review gate
- publishing / analytics

## Schemas

- `wanghai.promo.video-input@1` (legacy contract)
- `wanghai.promo.video-snapshot@1` (legacy contract)
- `wanghai.promo.video-output@1` (legacy contract)

Canonical copies live in repo `schemas/` and are mirrored under
`tools/product-video/schemas/`.

## Pipeline

```text
init-input → resolve → render → publish
                 └────── run ──────┘
```

1. **resolve** — freeze product meta/images, audio paths, timeline
2. **render** — per-shot ken-burns, concat, mux BGM, cover, SRT
3. **publish** — `outputs/output.json` + artifacts

## Usage

```bash
export PATH="$HOME/.local/bin:$PATH"   # if ffmpeg is installed there

# build synthetic workspace + example input
pnpm --dir tools/product-video run fixture

# full run
./tools/product-video/polaris-product-video run \
  --workspace-root tools/product-video/test/fixtures/workspace \
  --input tools/product-video/examples/seed-demo.input.json
```

Artifacts land under:

```text
产品管理/交付归档/videos/<video_id>/
  inputs/input.json
  work/snapshot.json
  outputs/video.mp4
  outputs/cover.jpg
  outputs/captions.srt
  outputs/audio-mix.m4a
  outputs/output.json
```

## Engines

| engine | status |
|--------|--------|
| `ffmpeg_kenburns` | implemented (local) |
| `image_to_video_api` + `provider: jiekou` | **Seedance 1.5 Pro** via JieKou (Batch/`flex`, 480p, no audio by default) |

### JieKou Seedance (cheapest batch video)

Set in repo-root `.env`:

```bash
JIEKOU_API_KEY=...          # https://jiekou.ai/settings/key-management
JIEKOU_BASE_URL=https://api.highwayapi.ai
```

Example input: `examples/seedance-jiekou.input.json`

```bash
set -a && source ../../.env && set +a
./polaris-product-video run \
  --workspace-root <workspace> \
  --input examples/seedance-jiekou.input.json
```

Defaults for `provider: jiekou|seedance`:

- model: `seedance-v1.5-pro-i2v`
- `service_tier=flex` (batch, ~50% of online)
- `resolution=480p`
- `generate_audio=false` (~$0.006/s → 5s ≈ $0.03)
- hero image = first beat image / near slot (base64 upload)
- still muxes local BGM after download

If Seedance fails and `render.fallback=ffmpeg_kenburns`, falls back to local ken-burns.

## Audio rules

- Default `audio.mix.require_bgm=true` → must provide `audio.bgm.path`
- Final MP4 must contain an audio stream or the run fails
- TTS (`audio.tts`) is accepted in input but not rendered in v1
  (warning recorded)

## Compare purpose

Requires `compare` block and beats:

`hook → compare_a → compare_b → compare_vs → cta`

Case ownership stays on the single main `product_id`;
`other_product_id` is a reference only.
