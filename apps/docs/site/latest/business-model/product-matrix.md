# 产品矩阵

这份表把当前讨论里已经出现的产品，按统一口径放在一起。

这里统一回答四个问题：

- 产品是什么
- 主要卖给谁
- 主要解决什么问题
- 常见怎么收费

说明：

- 这不是精确价格表。
- 这里记录的是主销售逻辑，不是每个产品全部可能的 SKU。
- 同一个产品可能跨多个类别，但这里优先写最主要的销售方式。

| 产品 | 主要用户 | 主要解决问题 | 常见收费 |
| --- | --- | --- | --- |
| Cursor | 个人开发者，小型研发团队 | 让开发者更快写代码、改代码、理解仓库 | `per seat`，个人订阅，团队版 seat |
| GitHub Copilot | 个人开发者，研发团队，企业工程组织 | 把代码补全、聊天、代码建议带进现有 IDE 和 GitHub 工作流 | `per seat`，business 或 enterprise seat |
| Claude Code | 个人开发者，技术团队里的重度 CLI 用户 | 通过 CLI agent 提升代码修改、分析和终端工作效率 | `per seat` 或模型 usage 绑定的订阅 |
| Codex CLI / coding agents | 个人开发者，技术团队，平台实验者 | 通过 CLI agent 执行 coding task、命令、编辑和仓库分析 | usage 为主，外加 seat 或团队预算控制 |
| Windsurf | 个人开发者，小团队 | 提供 assistant-first 的 coding 体验和 IDE 内 agent 协作 | `per seat`，个人订阅，团队版 |
| Continue | 技术型个人，愿意自配置的小团队 | 用自配置模型、检索和 IDE 集成替代托管 coding assistant | 开源自用，企业版或自建成本 |
| Sourcegraph Cody | 研发团队，中大型工程组织 | 在代码检索、仓库理解和团队代码上下文上增强开发效率 | `per seat`，企业合同 |
| Cortex | 个人开发者，重度多-agent 使用者 | 把多个 coding agent 放进一个本地工作台，减少上下文切换和 token 浪费 | 桌面订阅，`per seat`，高级功能订阅 |
| Pipora | 技术型个人，小团队，workflow 搭建者 | 在本地编排 agent、工具、知识库、memory 和审批流 | `per seat`，pro 或 team tier，企业私有部署附加费 |
| Dify | AI 应用团队，自动化团队，创新团队 | 快速搭建带模型、知识库和工具调用的 AI 应用与流程 | seat 加平台版，云托管，企业部署 |
| LangGraph Platform | AI 应用团队，agent 平台团队 | 构建更复杂的 agent workflow、状态流和运行时控制 | usage，平台订阅，企业合同 |
| Flowise | 技术型 PM，自动化团队，小团队 | 用低代码方式快速搭建 LLM workflow 和 agent flow | 开源自用，云版或企业版 |
| n8n with AI | 自动化团队，运营团队，AI 应用团队 | 把现有自动化工作流扩展到 AI 节点、审批和连接器 | usage，workflow 或 execution 计费，企业版 |
| Coze | AI 应用团队，内容和运营团队 | 快速构建 bot、workflow 和渠道分发 | usage，平台版，企业方案 |
| Coder | 平台团队，IT owner，安全团队，共享环境运营者 | 提供受治理的云端开发工作空间和用户隔离 | `per seat`，企业合同，托管或支持附加费 |
| Gitpod Enterprise | 平台团队，研发团队，企业工程组织 | 提供预构建、可重复、可共享的云端开发环境 | `per seat`，企业合同，托管附加费 |
| Harness | 平台团队，DevOps 团队，企业工程组织 | 把交付控制、策略、审计和 agent 能力放进工程平台 | 企业合同，平台费，模块附加费 |
| AWS Bedrock AgentCore | 企业平台团队，云平台团队 | 在云上托管 agent runtime、权限、执行和平台控制 | usage，云资源计费，企业支持 |
| GitLab Duo Enterprise | 已经以 GitLab 为中心的工程组织 | 在现有 DevSecOps 平台里增加 AI 助手和团队级控制 | `per seat`，enterprise 合同 |
| Internal VDI / remote workspace | 安全团队，交付团队，共享实验室 | 给多用户提供受控远程环境和隔离访问 | 企业合同，基础设施加运维成本 |
| Custom CLI harness | 技术团队，平台实验团队 | 围绕现有 CLI agents 组装最小可用运行层和内部流程 | 内部建设成本，运维成本 |
| Polaris | 工程经理，平台团队，IT owner，共享基础设施运营者 | 提供团队级 workspace onboarding、ownership、credential control、isolation 和 handover continuity | 平台费加 seat 费，`per workspace`，企业合同，托管或支持附加费 |

## 怎么看这张表

可以把这些产品粗分成四类主销售逻辑：

1. personal agent workbench
2. local agent runtime / workflow builder
3. team agent workspace platform
4. cloud agent infrastructure / managed execution

当前更接近这些类别的代表产品：

- personal agent workbench：
  Cursor、Claude Code、Codex CLI、Windsurf、Cortex
- local agent runtime / workflow builder：
  Pipora、Dify、LangGraph Platform、Flowise、n8n、Coze
- team agent workspace platform：
  Coder、Gitpod Enterprise、Polaris
- cloud agent infrastructure / managed execution：
  Bedrock AgentCore、部分 Harness、部分企业自建平台

Polaris 的主销售逻辑不是卖个人 coding assistant。
Polaris 也不是一个以连接器数量取胜的通用 workflow builder。

Polaris 更适合被描述成：

- 面向工程团队的 agent workspace 平台
- 提供 onboarding、governed use、shared infrastructure 和 handover
  continuity
