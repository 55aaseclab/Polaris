# 产品矩阵

这份文档把当前已知和已讨论的主要产品，放到一个统一的二维坐标里看。

这里不再先按客户类型拆分。
这里先把产品当作工具来比较。

重点只看两个维度：

- `团队平台能力`
- `治理深度`

然后再补四项辅助信息：

- 产品
- 主要用户
- 主要解决问题
- 常见收费方式

## 两个维度

### 维度一：团队平台能力

这个维度回答的是：
这个产品到底更像个人工具，还是更像多用户团队平台。

打分标准：

- `1`：明显是个人工具或单用户工具
- `2`：支持小团队使用，但平台属性仍弱
- `3`：开始具备团队协作和团队采购属性
- `4`：明确进入多用户、多团队平台层
- `5`：明显是团队平台或组织级控制面

### 维度二：治理深度

这个维度回答的是：
这个产品到底是在卖工具体验，还是在卖运行控制、隔离、权限和平台治理。

打分标准：

- `1`：几乎完全是工具体验
- `2`：有少量管理能力，但治理较浅
- `3`：开始提供团队管理、控制或审计能力
- `4`：明显具备平台治理、隔离、策略控制能力
- `5`：治理、隔离、权限、运行控制是主价值之一

## 产品总表

说明：

- 这不是精确价格表。
- 这不是严格意义上的市场份额排序。
- 这里记录的是主销售逻辑和当前已知形态。
- 评分是为了做定位判断，不是为了表达绝对优劣。

| 产品 | 主要用户 | 主要解决问题 | 常见收费 | 团队平台能力 | 治理深度 |
| --- | --- | --- | --- | --- | --- |
| Cursor | 个人开发者，小型研发团队 | 提升个人 coding 速度、代码理解和修改效率 | `per seat`，个人订阅，团队 seat | `2` | `1` |
| GitHub Copilot | 个人开发者，研发团队，企业工程组织 | 把代码补全、聊天和代码建议带进 IDE 与 GitHub 工作流 | `per seat`，business 或 enterprise seat | `3` | `2` |
| Claude Code | 个人开发者，重度 CLI 用户 | 通过 CLI agent 提升终端内的代码分析和修改效率 | `per seat` 或模型 usage 绑定订阅 | `1` | `1` |
| Codex CLI / coding agents | 个人开发者，技术团队，平台实验者 | 用 coding agent 执行代码编辑、命令和仓库分析 | usage 为主，外加 seat 或团队预算控制 | `1` | `1` |
| Windsurf | 个人开发者，小团队 | 提供 assistant-first 的 IDE coding 体验 | `per seat`，个人订阅，团队版 | `2` | `1` |
| Continue | 技术型个人，愿意自配置的小团队 | 用自配置模型和检索替代托管 coding assistant | 开源自用，企业版或自建成本 | `2` | `2` |
| Sourcegraph Cody | 研发团队，中大型工程组织 | 增强代码检索、仓库理解和团队代码上下文能力 | `per seat`，企业合同 | `3` | `2` |
| Cortex | 个人开发者，重度多-agent 使用者 | 把多个 coding agent 放进一个本地工作台，减少上下文切换和 token 浪费 | 桌面订阅，`per seat`，高级功能订阅 | `1` | `1` |
| Pipora | 技术型个人，小团队，workflow 搭建者 | 在本地编排 agent、工具、知识库、memory 和审批流 | `per seat`，pro 或 team tier，企业私有部署附加费 | `2` | `2` |
| Dify | AI 应用团队，自动化团队，创新团队 | 快速搭建带模型、知识库和工具调用的 AI 应用与流程 | seat 加平台版，云托管，企业部署 | `3` | `2` |
| LangGraph Platform | AI 应用团队，agent 平台团队 | 构建更复杂的 agent workflow、状态流和运行时控制 | usage，平台订阅，企业合同 | `3` | `2` |
| Flowise | 技术型 PM，自动化团队，小团队 | 用低代码方式快速搭建 LLM workflow 和 agent flow | 开源自用，云版或企业版 | `2` | `1` |
| n8n with AI | 自动化团队，运营团队，AI 应用团队 | 把现有自动化工作流扩展到 AI 节点、审批和连接器 | usage，workflow 或 execution 计费，企业版 | `3` | `2` |
| Coze | AI 应用团队，内容和运营团队 | 快速构建 bot、workflow 和渠道分发 | usage，平台版，企业方案 | `2` | `1` |
| Coder | 平台团队，IT owner，安全团队，共享环境运营者 | 提供受治理的云端开发工作空间和用户隔离 | `per seat`，企业合同，托管或支持附加费 | `5` | `4` |
| Gitpod Enterprise | 平台团队，研发团队，企业工程组织 | 提供预构建、可重复、可共享的云端开发环境 | `per seat`，企业合同，托管附加费 | `5` | `4` |
| Harness | 平台团队，DevOps 团队，企业工程组织 | 把交付控制、策略、审计和 agent 能力放进工程平台 | 企业合同，平台费，模块附加费 | `5` | `5` |
| AWS Bedrock AgentCore | 企业平台团队，云平台团队 | 在云上托管 agent runtime、权限、执行和平台控制 | usage，云资源计费，企业支持 | `4` | `5` |
| GitLab Duo Enterprise | 已经以 GitLab 为中心的工程组织 | 在现有 DevSecOps 平台里增加 AI 助手和团队级控制 | `per seat`，enterprise 合同 | `4` | `3` |
| Internal VDI / remote workspace | 安全团队，交付团队，共享实验室 | 给多用户提供受控远程环境和隔离访问 | 企业合同，基础设施加运维成本 | `4` | `4` |
| Custom CLI harness | 技术团队，平台实验团队 | 围绕现有 CLI agents 组装最小可用运行层和内部流程 | 内部建设成本，运维成本 | `2` | `2` |
| Polaris | 工程经理，平台团队，IT owner，共享基础设施运营者 | 提供团队级 workspace onboarding、ownership、credential control、isolation 和 handover continuity | 平台费加 seat 费，`per workspace`，企业合同，托管或支持附加费 | `5` | `5` |

## 按象限看这些工具

### 左下：个人工具 / 轻治理

主要代表：

- Cursor
- Claude Code
- Codex CLI
- Windsurf
- Continue
- Cortex

这一象限的主卖点是：

- 上手快
- 个人效率提升快
- 采购动作轻

这一象限的典型局限是：

- 多用户和 workspace ownership 弱
- 治理、隔离和 handover 不是主设计目标

### 左上：偏本地编排 / 轻到中治理

主要代表：

- Pipora

这类工具开始从 assistant 走向 runtime 和 workflow。
但公开形态仍然更偏：

- 本地优先
- 单机或小团队
- 个人自动化与流程复用

### 右中：应用构建 / 自动化平台

主要代表：

- Dify
- LangGraph Platform
- Flowise
- n8n with AI
- Coze

这类产品更强在：

- workflow 编排
- 知识库
- tool calling
- 低代码 PoC

但它们通常不是为下面这些问题而设计：

- 多用户研发 workspace ownership
- 共享基础设施上的受治理代码执行
- handover continuity

### 右上：团队平台 / 强治理

主要代表：

- Coder
- Gitpod Enterprise
- Harness
- AWS Bedrock AgentCore
- GitLab Duo Enterprise
- Polaris

这类产品开始真正进入：

- 多用户
- 平台控制
- 运行治理
- 隔离
- 凭证和策略边界

其中 `Polaris` 的差异不只是“也是平台”。
它更具体地押注在：

- coding agent workspace
- governed onboarding
- credential control
- shared infrastructure with isolation
- member exit and handover continuity

## Polaris 的位置

如果只按这两个维度看：

- `Polaris` 明显不属于个人工具层
- `Polaris` 也不属于单机本地 workflow builder
- `Polaris` 更接近 `team agent workspace platform`

因此更准确的定位不是：

- 又一个 coding assistant
- 又一个 agent builder

而是：

- 面向工程团队的 agent workspace 平台
- 位于多用户、强治理、可上云的控制层

## 可视化矩阵

下面这张图使用同样的两个维度：

- 横轴：`个人工具 / 单用户` -> `团队平台 / 多用户`
- 纵轴：`轻治理 / 工具体验` -> `强治理 / 平台控制`

![Agent 产品矩阵](/business-model/agent-product-matrix.png)
