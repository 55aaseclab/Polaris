# @polaris/llm-harness

Configurable LLM harness (CLH) — PRD 3.14. Platform-level LLM call
infrastructure: preset schema + compiler + wrapper, so module tools never
re-implement retry, billing, credentials, or session plumbing.

Three components (PRD 3.14.1):

| Component | Responsibility |
|-----------|----------------|
| preset schema | Step-level declaration: kind + model + tool boundary + loop cap + output contract + permission |
| compiler | preset + task context -> backend patch/config + rendered prompt; one-shot, zero persistent state |
| wrapper | spawn backend -> parse durable session log -> receipt (tokens / costUsd / tool calls / exit) |

## Preset schema (PRD 3.14.2)

| Field | Values |
|-------|--------|
| kind | `api` (pure LLM call) / `bounded` (read-only transform) / `open` (writable execution) |
| model | `light` (Flash-class) / `strong` (R1-class), resolved through the env chain |
| toolBoundary | `none` / `read-only` / `full` |
| loopCap | integer >= 1; in-session iteration cap (api kind ignores it) |
| outputContract | `precise-json` / `artifact` |
| permission | `read-only` / `workspace-write` |

Optional: `id`, `title`, `description`, `prompts` (`system` + `user` j2
template paths relative to the preset file). Unknown fields are rejected with
`CLH_PRESET_UNKNOWN_FIELD`.

Kind consistency (PRD 3.14.3): `api` fixes `toolBoundary: none` +
`permission: read-only`; `bounded` fixes `permission: read-only` with
`toolBoundary: none|read-only`; `open` fixes `permission: workspace-write`
with `toolBoundary: read-only|full`. Violations raise
`CLH_PRESET_KIND_CONFLICT`.

## Env chain

Every endpoint, key, and model id arrives from the process environment;
missing credentials fail closed (`CLH_MISSING_CREDENTIAL` /
`CLH_MISSING_MODEL`). All examples below are synthetic placeholders.

| Variable | Meaning |
|----------|---------|
| `POLARIS_CLH_ENDPOINT` | OpenAI-compatible base URL, e.g. `https://llm-gateway.example.invalid/v1` |
| `POLARIS_CLH_API_KEY` | API key value, e.g. `sk-synthetic-placeholder` |
| `POLARIS_CLH_LIGHT_MODEL` | Model id for the `light` tier, e.g. `synthetic-flash-model` |
| `POLARIS_CLH_STRONG_MODEL` | Model id for the `strong` tier, e.g. `synthetic-r1-model` |
| `POLARIS_CLH_LIGHT_PRICE_INPUT_PER_MTOK` / `..._OUTPUT_PER_MTOK` | Light-tier pricing (USD per million tokens); both unset -> `costUsd` is undefined |
| `POLARIS_CLH_STRONG_PRICE_INPUT_PER_MTOK` / `..._OUTPUT_PER_MTOK` | Strong-tier pricing, same convention |
| `POLARIS_CLH_TIMEOUT_MS` | Default per-call api timeout (default 120000) |
| `POLARIS_CLH_DSH_BIN` | dsh launcher (default `dsh`; set `npx` with `POLARIS_CLH_DSH_BIN_ARGS="-y @deepseek-ai/dsh"` when not installed globally) |
| `POLARIS_CLH_DSH_BIN_ARGS` | Extra launcher args before dsh flags |
| `POLARIS_CLH_DSH_PROFILE` | dsh profile under `$DSH_HOME/profiles` (default `headless`) |
| `POLARIS_CLH_DSH_HOME` | `DSH_HOME` value passed to the dsh child |
| `POLARIS_CLH_ZSTD_BIN` | zstd binary for durable session logs (default `zstd`) |
| `POLARIS_CLH_DISPATCHER_URL` | Dispatcher endpoint the exec adapter forwards commands to |
| `POLARIS_CLH_DISPATCHER_BIN` | Exec adapter binary emitted into the dsh `sandbox` `runnerCommand` seam |

## Backends

- `api` kind: direct OpenAI-compatible `POST {endpoint}/chat/completions`
  (fetch, per-call `timeoutMs`, usage + cost readback, no tools, no loop,
  no session).
- `bounded` / `open` kinds: dsh headless one-shot runner (`dsh --profile
  <profile> --patch <overlay> "task"`). The compiler renders the patch
  overlay (pi-ai provider route + default model + official key provider
  disabled + sandbox policy + optional persona prefix) into a temp file that
  is deleted after the run. The wrapper locates the durable session log
  under `$DSH_HOME/sessions/<cwd-slug>/`, decompresses it if needed, and
  parses tool calls, token usage, turns, and the final assistant text into
  the receipt.

## Dispatcher seam (PRD 3.14.5)

dsh's `sandbox` entry supports a `runnerCommand` override: a bwrap-compatible
runner that receives the confinement profile arguments and executes the
wrapped command. When `POLARIS_CLH_DISPATCHER_BIN` is set, the compiler emits
that override so command execution routes through the dispatcher adapter
(`src/dispatcher-adapter.ts`), which forwards every command to
`POLARIS_CLH_DISPATCHER_URL` over HTTP and never executes locally. The
protocol:

```
POST POLARIS_CLH_DISPATCHER_URL
{ "profileArgs": ["..."], "command": ["..."], "cwd": "..." }
-> { "exitCode": 0, "stdout": "...", "stderr": "..." }
```

Adapter failures are identified through the stable signature
`clh-dispatcher:` (`runnerFailureSignatures`). Without a configured adapter
the run degrades to dsh `sandbox-policy` enforcement alone
(read-only / workspace-write); the 3.8 isolated runtime later points the
dispatcher at the isolation environment, and the seam stays unchanged.

Injection-path research record (PRD 3.14.5): dsh custom plugins can enter a
profile either through profile `package.json` dependencies (`dsh plugin add`,
requires a published npm package) or through patch `insert` entries with a
relative plugin path anchored beside the patch file (requires the Cordis
plugin API). For the exec seam the supported surface is the `sandbox`
`runnerCommand` override, which needs no custom plugin; that is the path
implemented here.

## CLI

```
clh validate packs/cve-genie-trial/harness/repo-dev.yaml
clh compile packs/cve-genie-trial/harness/repo-dev.yaml --context ctx.json --workspace-root /tmp/workspace
clh run packs/cve-genie-trial/harness/repo-dev.yaml --context ctx.json --workspace-root /tmp/workspace
clh call packs/cve-genie-trial/harness/knowledge-builder.yaml --prompt-file prompt.txt
```

`compile` never spawns; it prints the compiled artifact for inspection.
`run` dispatches by kind (api -> direct call; bounded/open -> dsh headless)
and prints the receipt JSON.

## License

Apache-2.0. Prompt templates under `packs/cve-genie-trial/harness/prompts/`
carry their own attribution (see `packs/cve-genie-trial/ATTRIBUTION.md`).
