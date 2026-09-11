# clue-codex-cli

Bounded wrapper around the system [Codex CLI](https://github.com/openai/codex)
for non-interactive `codex exec` and literature **topic judgment**.

Default model: **`gpt-5.5`** with **low** reasoning effort (override with
`--model` / `CODEX_MODEL` or `CODEX_REASONING_EFFORT`).

## Install

Requires `codex` on `PATH` (and auth as usual for Codex / OpenAI).

```sh
which codex
./clue-codex-cli version
```

`../load-env.sh` is sourced so monorepo `.env` is available.

## Commands

### `version`

Print wrapper version, backend lock, and `codex --version` if available.

### `exec`

Run a one-shot non-interactive agent:

```sh
./clue-codex-cli exec \
  --prompt "Summarize tools/codex/README.md in 3 bullets." \
  --output /tmp/codex-exec.json \
  --sandbox read-only \
  --ephemeral
```

Useful flags: `--model`, `--cd`, `--output-schema`, `--full-auto`, `--timeout`.

### `topic-judge`

Judge whether paper **title + abstract** match a collection scope. The prompt
is **domain-agnostic**: only the supplied research question, `include` /
`exclude`, and optional criteria define what is in scope.

```sh
./clue-codex-cli topic-judge \
  --scope /path/to/collection/inputs/input.json \
  --records /path/to/collection/work/collection-output.json \
  --limit 10 \
  --model gpt-5.5 \
  --output /tmp/topic-judgments.json
```

Optional collection-specific rules (not hardcoded in the tool):

```sh
# CLI (overrides scope fields)
./clue-codex-cli topic-judge ... \
  --criteria "Require X and Y together" \
  --criteria "Reject pure Z without X"

# or one line per criterion
./clue-codex-cli topic-judge ... --criteria-file /path/to/criteria.txt
```

Scope JSON may also carry `topic_criteria` / `judgment_criteria` / `criteria`
(array of strings) at the top level or under `scope`.

Output includes `judgments[]` with `in_scope`, `confidence`, `reason`, plus
counts. Prefer small batches first (`--limit`).

By default the model returns freeform JSON matching
`schemas/topic-judgment.schema.json`. Pass `--use-output-schema` to force
Codex structured mode (may 429/503 on some providers; freeform fallback runs
once on failure).

## Environment

| Variable | Meaning |
|----------|---------|
| `CODEX_BIN` | Override path to `codex` |
| `CODEX_MODEL` | Default model (else `gpt-5.5`) |
| `CODEX_REASONING_EFFORT` | Reasoning effort (else `low`) |
| `OPENAI_API_KEY` / Codex auth | As required by local Codex install |
| `CODEX_HOME` | Codex home (sessions/config) |

## Layout

```text
tools/codex/
  clue-codex-cli      # bash entry
  runner.py           # Python CLI
  schemas/            # output schemas for structured exec
  tests/              # offline unit tests (no network)
  VERSION
  backend.lock.json
```

## Notes

- This tool does **not** download Semantic Scholar datasets.
- Long-running judgments: raise `--timeout` (default 900s for topic-judge).
- Prefer `--sandbox read-only` for pure judgment tasks.
