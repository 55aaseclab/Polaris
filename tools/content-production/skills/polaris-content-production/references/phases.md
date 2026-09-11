# Content production phases

Shared pipeline for `product-catalog`, `carousel`, and `video`.

```text
validate → select → freeze → plan → produce → package → review → publish
```

## Shared

| Phase | In | Out | Fail when |
|-------|----|-----|-----------|
| validate | input.json | ok / error | schema or kind_config mismatch |
| select | product_selection | ordered ids + skip list | zero ids after filters (unless allowed) |
| freeze | product meta + slots | snapshot (no costs) | missing required images in strict mode |
| plan | snapshot + kind_config | plan.json | template unknown |
| produce | plan + snapshot | render intermediates | renderer/encoder missing |
| package | intermediates | primary deliverable | Chrome/ffmpeg missing |
| review | package | approval marker | manual-review and not approved |
| publish | all of above | output.json | primary missing while status=published |

## product-catalog

```text
select (many SKUs)
  → freeze (catalog-snapshot)
  → plan (sections: cover / pages / contact)
  → produce (HTML pages)
  → package (PDF)
  → publish (catalog-output + umbrella output)
```

Implemented by `tools/content-production` (`content_kind=product-catalog`).

## carousel

```text
select (usually 1 SKU)
  → freeze (images + copy)
  → plan (slide list: hook → proof → CTA)
  → produce (per-slide stills)
  → package (slides/ + zip + caption)
  → publish
```

Tool TBD (`tools/product-carousel`).

Default `product-story.v1` beats:

1. Cover + hook
2. Near hero
3. Wear/use
4. Detail
5. Selling points
6. Optional specs
7. CTA

## video

```text
select (1 SKU)
  → freeze (stills and/or footage)
  → plan (time-coded beats, subtitles)
  → produce (timeline / motion from stills)
  → package (mp4 + cover + vtt)
  → publish
```

Tool TBD (`tools/product-video`).

`source_mode`: `stills` | `footage` | `mixed`.

Default 15–20s beats:

| Sec | Beat |
|-----|------|
| 0–2 | Hook + strongest visual |
| 2–8 | Wear / use |
| 8–14 | Detail + 1–2 points |
| 14–20 | Product hero + CTA |

## What is intentionally shared

- Product admission (ready, external, image slots)
- Freeze projection rules (no costs)
- Review modes (`auto-pass` / `manual-review`)
- Umbrella output manifest shape

## What stays kind-specific

- Template ids and page/slide/timeline layout
- Package binary format (pdf / png set / mp4)
- Platform aspect ratios and caption conventions
