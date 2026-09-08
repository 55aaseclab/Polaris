# Changelog

## 0.1.2 - 2026-07-23

- `topic-judge` defaults to freeform JSON (some providers 429/503 on
  `--output-schema`); optional `--use-output-schema` with freeform fallback.
- Close stdin with `/dev/null` so piped parents do not append to `codex exec`.

## 0.1.1 - 2026-07-23

- `topic-judge` prompt is domain-agnostic: no hardcoded research-topic rules.
- Criteria come from CLI `--criteria` / `--criteria-file`, then
  `payload.literature_scope.topic_criteria`, top-level, or `scope.*`
  (`topic_criteria` / `judgment_criteria` / `criteria`).

## 0.1.0 - 2026-07-23

- Initial `clue-codex-cli`: wrap `codex exec` with monorepo load-env.
- Default model `gpt-5.4-mini`.
- `topic-judge`: structured title/abstract vs collection scope judgments
  via Codex `--output-schema`.
- Offline unit tests for prompt building and record field extraction.
