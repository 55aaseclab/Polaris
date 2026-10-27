# clue-social-publish

Versioned **social publish** contract for Polaris (`clue.social-publish.v1`).

This package freezes the **API surface** first. Platform adapters (browser
session / official OAuth) are wired later;
until then `publish` validates input and returns `planned` (dry-run) or
`failed_not_implemented`.

## Contracts (repo root)

- [`schemas/clue.social-publish.input.v1.schema.json`](../../schemas/clue.social-publish.input.v1.schema.json)
- [`schemas/clue.social-publish.output.v1.schema.json`](../../schemas/clue.social-publish.output.v1.schema.json)

`schema_version` strings:

- input: `clue.social-publish.input.v1`
- output: `clue.social-publish.output.v1`

## CLI

```sh
./clue-social-publish version
./clue-social-publish platforms
./clue-social-publish validate-input --input examples/publish-video.example.json
./clue-social-publish publish --input examples/publish-video.example.json
```

`publish.dry_run: true` → output `status: planned` (exit 0).<br>
Otherwise stub → `status: failed_not_implemented` (exit 2) after validation.

## Platforms (v1 enum)

`douyin` · `kuaishou` · `xiaohongshu` · `bilibili` · `channels` (视频号) ·
`baijiahao` · `tiktok` · `youtube` · `instagram` · `facebook` · `x` ·
`linkedin`

## Related

- Read-side social collection (JustOneAPI): `tools/social-media`
