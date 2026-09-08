# Business DSL v0.4-trial

`v0.4-trial` 是 v0.3 之外的实验语言表面。v0.3 的 `domain`、`flow`、
`port` 和 `pipeline` 语义不变；只有写入
`dsl version "0.4-trial"` 的源码才启用 `trial` 图。

## 目标

Trial 图表达有界的、可恢复的 Agent 工作流：

- 节点通过 typed FFI port 调用 Host；
- `uses` 显式声明节点输入，`output` 显式声明节点产出；
- `edge ... when ...` 表达条件分支和反馈回边；
- `retry { max ... backoff ... }` 表达节点内的失败重试；
- `reset` 表达一次反馈循环开始时重置目标节点的本地 attempt；
- `budget` 表达总超时、成本和 transition 上限；
- `execution` 表达 AI/workspace、隔离和网络意图；
- artifact 只记录引用、digest、大小和 redaction 元数据；内容投影受上限
  约束。

## 最小语法

```text
dsl version "0.4-trial"
domain Example version "1.0.0"

port Work version "1.0.0" {
  in { inputRef: String }
  out { resultRef: String, accepted: Boolean }
  effect ffi
}

trial Main title "Bounded trial" {
  input { inputRef: String required }
  budget { timeout 60s cost 1 maxTransitions 12 }
  execution { class ai isolation disposable network deny }
  start work
  terminal { done }

  nodes {
    work "Work" {
      uses { inputRef }
      call Work
      output { resultRef: String, accepted: Boolean }
      retry { max 2 backoff 1s }
      timeout 20s
      maxActions 20
    }
    done "Done" {
      uses { resultRef }
      call Work
      output { resultRef: String, accepted: Boolean }
      retry { max 1 }
    }
  }

  edges {
    edge work -> done when "accepted == true"
    edge work -> work when "accepted == false"
  }
}
```

反馈边可以把产出映射成目标节点的上下文名称：

```text
edge critic -> developer when "accepted == false && possible == true" feedback criticFeedback as developerFeedback reset
```

条件表达式是安全的受限表达式，只支持布尔组合（`&&`、`||`）、字段与
字面量的 `==` / `!=`，以及数值字段的比较运算（`<`、`<=`、`>`、`>=`）；
不会执行 JavaScript 或 shell。

## 运行语义

`compileTrial` 返回 `TrialProgram`。执行状态由 `TrialStateStore` 保存：

状态中同时保存 `currentNode`、定义 digest、全局 `transitions`、每个节点的
`nodeStates`、context、inflight request、receipt、artifact 和 error。

```text
running
  ├─ node-started
  ├─ receipt checkpoint
  ├─ node-completed
  └─ edge-selected

failed call ──retry──> same node
completed output ──when──> next node
waiting ──resume(output)──> next edge
running ──cancel──> cancelled
terminal node ──> succeeded
```

每一次节点进入都有两个计数：

- `attempt` 是节点本地计数，`reset` 可以在反馈循环中重置它；
- `transitions` 是运行内单调计数，不会重置，用于全局安全上限。

request ID 使用运行内 transition ordinal，而不是本地 attempt。因此
重置 attempt 不会复用旧 receipt。Host 调用前会写入 `inflight` checkpoint；
调用返回后会写入 response、receipt 和 output checkpoint，随后才选择下一条
边。进程崩溃恢复时，会按 request ID 重放 receipt 或继续同一个 request；Host
必须用相同的 `idempotencyKey` 做幂等处理。`resume` 的外部输出也先保存为
response checkpoint，因此恢复时不会再次调用等待节点。

运行时拒绝：

- 未声明或未提供的 port/capability；
- 缺少节点输入或输出类型错误；
- 超过节点 timeout、action 数量、attempt 上限；
- 超过 trial 的 timeout、cost 或 transition 上限；
- 未经 `allowNetwork` 运行声明了网络的 trial；
- AI trial 没有 disposable isolation；
- 未声明的输出、artifact、artifact 类型或 digest。

## CVE-Genie 映射

`examples/cve-genie-trial.ord` 使用 11 个节点表达：

```text
Data Processor
  → Knowledge Builder
  → Prerequisite Developer
  → Repository Builder ↔ Setup Critic
  → Exploit Developer ↔ Exploit Critic
  → Verifier Developer
  → Flag Checker ↔ Verifier Critic
  → Persist Reproduction
```

源码中的总预算和各节点上限对应论文/参考实现中的有界运行：
2700 秒、5 美元、Builder/Exploiter 的 3 次开发尝试、Critic 的 2 次尝试，
以及 verifier 的 5 次功能检查。所有日志、PoC、verifier、环境 snapshot
都以 artifact reference 表达。

其中 `retry.max` 是一次节点调用失败时的本地重试上限；反馈边上的 `reset`
只重置目标节点的本地 attempt，不重置运行级 `transitions`。这区分了参考
实现里的 agent tool retry 与 developer/critic feedback loop，最后仍由全局
transition budget 兜底。

## Polaris 边界

`TrialProgram` 是可嵌入的语言运行时，不是控制面。生产实现应提供自己的
`TrialStateStore`，并把事件、receipt、artifact 和 lease 绑定到 Polaris
的 tenant/Vault/run。Store 的 `save` 应原子替换完整 snapshot；多 worker
场景还需要控制面提供 claim/compare-and-save。

本 trial 只提供 Host contract 和 deterministic test runtime：

- 不执行 shell、网络、模型或 Wanghai 请求；
- 不在 `.ord` 中存放命令、prompt、凭据、路径或容器配置；
- `execution` 是声明，不是资源或权限授予；
- 真实 CVE 复现必须经过 Polaris-owned、隔离的执行 cell 和单独的 live
  action admission；
- 不能把 v0.4-trial 自动接入现有 v0.3 Portal flow worker。

相关 Polaris 控制面设计见文档站的 Business DSL as workflow IR、Dynamic
Workflow Runtime 和 WorkEnvelope/Workflow Plan 文档。
