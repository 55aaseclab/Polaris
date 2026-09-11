# polaris-workflow

Polaris 0.4.0 的可嵌入 Polaris DSL / workflow IR Node.js 包。

本包没有 Web 服务，也不拥有 UI、租户、Vault 或调度控制面。它提供
`parse → resolve → validate → compile/interpret` 以及 Host/FFI 边界，
由 Polaris 或 Wanghai surface 负责宿主运行。

通用业务描述语言的实验实现：**行业无关内核** + **业务包** + **（目标）FFI Port**。

语言表面默认为 **v0.3**。显式写入 `dsl version "0.4-trial"` 后，可使用
有界 durable trial 图来表达 Agent 编排、条件边、反馈回边、重试和预算；
这不会改变 v0.3 的 `flow` 语义。

## 设计立场（先读）

产品参考见文档站 **[Polaris DSL](../../apps/docs/site/polaris/dsl.md)**。
完整设计认知见 **[docs/DESIGN.md](./docs/DESIGN.md)**。

三句话：

1. **三个世界**：意义（实体/状态/事件）· 计算（input/uses/out）· 外界（**Tool = FFI port**）  
2. **不把 CLI/路径/prompt 焊进语言** — 那是 Host binding  
3. **电商 / ERP / 科研流水线** 都只是 pack，不是 DSL 本身  

目标态素描：`packs/vision-kernel/main.ord`；`port` / `call` / `needs` 已在 P1 实现。

## 当前实现

| 能力 | 状态 |
|------|------|
| Parser / Validator / Interpreter / Compiler | ✅ |
| `entity` · `flow` · `input` · `steps.uses/output` · `flow.output` | ✅ |
| **`port` · `call` · `needs` · MockHost.invoke** | ✅ P1 |
| 解释执行 vs 编译执行（均经 Host） | ✅ |
| shadcn 渲染 + 数据流 + FFI 日志 | ✅ |
| **1000 域包压测 + Unicode 标识符** | ✅ |
| **`import` 跨域包 + port 版本 (`@ver`)** | ✅ P2 |
| **`dsl version "0.4-trial"` + Trial/Node/Edge runtime** | ✅ trial |
| Polaris Domain Pack 安装/列出/删除 CLI | ✅ 0.4 foundation |
| 真实 Host CLI/HTTP 执行 adapter | 🚧 P3 |

第一方域包位于仓库根目录 `packs/`：

- `packs/autoresearch/main.ord` — 第一方文献研究
- `packs/cve-genie-trial/main.ord` — 有界 CVE-Genie trial
- `packs/vision-kernel/main.ord` — 内核素描

```bash
pnpm install

# 域包压测（合成 1000 + 对抗集）
pnpm gen:packs 1000 && pnpm stress:packs
pnpm gen:adv && pnpm stress:adv
# 或一次性：
pnpm stress:all
```

最近一次压测：**1000/1000 pass**，对抗 **98/98 matched**。  
发现并修复：标识符仅 ASCII → **Unicode `\p{L}` ID**（支持 `任务单` / `分拣臂`）。

详见 [docs/DOMAIN_PACKS.md](./docs/DOMAIN_PACKS.md)、[docs/DESIGN.md](./docs/DESIGN.md)、  
[docs/POLARIS-0.4-BRIDGE.md](./docs/POLARIS-0.4-BRIDGE.md)（与 Polaris 任务推送/学习对接）。

v0.4-trial 示例：

- `packs/cve-genie-trial/main.ord` — CVE-Genie 的完整 bounded control graph
- `src/dsl/trial.ts` — condition evaluator、Host contract、checkpoint runtime
- `src/dsl/visualize.ts` — deterministic Graphviz DOT projection for trial graphs
- `test/trial.test.ts` — v0.3 compatibility、feedback、retry、resume、budget

## 目录

```text
docs/DESIGN.md              # 设计高度
docs/DOMAIN_PACKS.md        # 域包约定与压测
scripts/generate-*.mts      # 域包生成
scripts/stress-*.mts        # 压测
src/dsl/                    # 语言实现
generated/reports/          # 压测报告
```
