---
name: polaris-intelligence-analysis
description: >
  Analyze screened, generic v2 collection evidence into a traceable,
  review-gated intelligence output. Use when Codex needs to screen a v2
  collection output, freeze literature evidence, run intelligence analysis,
  guide human review, or publish a final report.
---

# Polaris 情报分析

此 skill **只支持 v2**。它只读取 `clue.data-collection.output.v2`。

**入口只有** `tools/intelligence-analysis/clue-intelligence-analysis`。
`tools/intelligence-analysis/literature-review` 是内部模块，**不要直接调用**。

Schemas（仓库根 `schemas/`）：

- [`schemas/clue.intelligence-analysis.input.v2.schema.json`](../../schemas/clue.intelligence-analysis.input.v2.schema.json)
- [`schemas/clue.intelligence-analysis.output.v2.schema.json`](../../schemas/clue.intelligence-analysis.output.v2.schema.json)

```text
data-collections/<collection-id>/outputs/output.json (v2)
  → clue-intelligence-analysis prepare|run
       → (internal) literature-review prepare / iterate|propose / validate / finalize
  → intelligence-analysis/<analysis-id>/outputs/output.json
```

## Analysis root

```text
$POLARIS_LITERATURE_WORKSPACES_ROOT/<workspace-id>/intelligence-analysis/<analysis-id>/
├── case/
├── inputs/input.json
├── work/          # snapshot, task, analysis-input, candidates, iteration-corpus, …
├── runs/
└── outputs/output.json
```

## Phase 0：intent

`analysis_kind` / entry route:

- `literature-review`（已接线；默认 `literature_method=iterate`）
- `ad-content-review`（已接线 **LLM synthesize**：冻结 clues → Codex
  judgments + `outputs/report.md`；模板 `ad-content-report`；见
  `tools/intelligence-analysis/ad-content-review/`）
- `business-analysis` / `product-analysis`（预留，未接线）

## Phase 1：optional screening

默认使用 collection 全部 records。需要缩小语料时提供
`screening.included_record_ids`。

## Phase 2–4：只通过 shell

```sh
IA=./tools/intelligence-analysis/clue-intelligence-analysis
ROOT="$POLARIS_LITERATURE_WORKSPACES_ROOT/<workspace>/intelligence-analysis/<analysis-id>"
INPUT="$ROOT/inputs/input.json"

$IA validate-input --input "$INPUT"
$IA prepare --input "$INPUT" --analysis-root "$ROOT"
$IA run --input "$INPUT" --analysis-root "$ROOT"
```

`run` 会：

1. 校验 `collection_ref` hash
2. 冻结 `work/collection-snapshot.json` + `task.json`
3. 调用 **literature-review**（默认 **iterate** 迭代论点图）
4. validate → `review_policy.mode`（默认 auto-pass；manual-review 时 review-list）→ finalize
5. 发布 `outputs/output.json`（`clue.intelligence-analysis.output.v2`）

可选 input 字段：

- `literature_method`: `iterate`（默认）| `batches` | `propose`
- `seed_paper_ids` / `seed_record_ids`: 迭代种子
- `max_papers`: 干跑上限
- `review_policy.mode`: `auto-pass`（默认）、`auto-approve` 或 `manual-review`

## 禁止

- 直接执行 `./tools/intelligence-analysis/literature-review/literature-review …` 作为产品路径
- 用模型外知识补证据
- 把未冻结的 PDF/全文当 observation（除非已进入 collection evidence）

## 下游

终态 output 可交给 `polaris-report-writing` 写报告。

## 固定 workflow（`workflows/literature-review`）

文献类案例优先走根目录 `workflows/literature-review` 的 `literature-review` 模板三阶段：

```text
data-collection → intelligence-analysis → report-writing
```

用 Polaris literature-review CLI 编排（workflow `run` 在 data-collection
成功后会写入 analysis `inputs/input.json` 的 `collection_ref`）：

```sh
pnpm --dir apps/polaris run polaris -- literature-review plan
pnpm --dir apps/polaris run polaris -- literature-review run \
  --input <input.json> --workspace <workspace-id> --run-id <run-id>
```

- IA 入口仍是 `clue-intelligence-analysis`；workflow 只是编排层。
- 默认 `literature_method=iterate`（论点图）。
- 示例可跑 workflow：`pkvm-security-20260723`。
- 若该 stage 的 `steps: []`，表示复用已有 `outputs/output.json`，不要重复
  `run` 除非用户明确要求。
