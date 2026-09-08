# 文献分析方法

当 `analysis_kind` 为 `literature-review` 时使用。

**入口**：`tools/intelligence-analysis/clue-intelligence-analysis`
**内部模块**：`tools/intelligence-analysis/literature-review`（由 shell subprocess 调用，勿直接跑）

## 目标

只根据冻结的论文、报告或其他文献 observation，形成可追溯的主张、分歧、局限和
待回答问题。文献的标题、摘要或原文摘录必须作为可定位的 `quote` 进入快照。

## 流程

```text
collection output (v2)
  → clue-intelligence-analysis prepare|run
       freeze snapshot + task
       literature-review prepare
       literature-review iterate   # default: seed→absorb claim graph
         (or batches / propose if literature_method set)
       literature-review validate → auto-pass (default) → finalize
         (set review_policy.mode=manual-review for review-list)
  → intelligence-analysis output.v2
```

默认算法是**迭代论点图**（`literature_method=iterate`）：

1. 种子论文：LLM 抽核心论点 + 一手论据
2. 后续论文：再抽论点，相对已有图判定 identical / new / contradictory / uncertain
3. 并入 well-typed `claim_graph`
4. export candidates → 校验与复核闸门

每篇论文先标记一个主类型：`tool_paper` 关注问题、算法/工具和结论；
`measurement_paper` 关注问题和测量结论；`sok_survey_paper` 只关注该论文对
文献整体的元级综合结论。普通 related-work 对单篇被引论文的转述属于二手信息，
不能直接作为该论文的证据。类型和 `problem` / `method` / `conclusion` focus
会随 extraction 进入 claim graph，分类时不会只按相似措辞合并。

## 解释规则

- `identical`：与已有节点同一核心主张；`new`：新增节点；`contradictory`：冲突边；
  `uncertain`：无法判定。
- `supported` / `contradicted` / `inconclusive` / `insufficient_evidence` 必须反映
  冻结文献，而非模型背景知识。
- 不得把摘要性语言扩展成因果结论。

## 命令边界

产品与 agent **只**调用：

```sh
./tools/intelligence-analysis/clue-intelligence-analysis run \
  --input <analysis>/inputs/input.json \
  --analysis-root <analysis>
```

不要直接调用 `./tools/intelligence-analysis/literature-review/literature-review …`。
