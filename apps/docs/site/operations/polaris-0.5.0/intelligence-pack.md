# Intelligence Pack（0.5.0 TODO）

Status: planned TODO for Polaris **0.5.0**.

本文规划一个与 `autoresearch` 完全独立的第一方域包，用于情报收集、分析、
每日简报和订阅推送。本文只定义边界和交付契约；本版本不实现实际采集器、
分析器或投递渠道。

## 目标与非目标

目标是让用户通过一个可版本化的 pack 声明“关注什么、从哪里收集、如何分析、
以及向哪些订阅计划发布”，再由通用 tools 执行这些声明。

非目标：

- 不修改 `packs/autoresearch`，也不 import 它的业务实体或 workflow。
- 不在 `tools/` 中硬编码课题组、作者、主题、来源 URL 或真实收件人。
- 不把 API key、邮箱密码、Webhook token 等凭据提交到 pack。
- 不在 pack 内实现第二套调度器、身份系统或持久化服务。

## Pack 身份与目录

建议 pack 标识为 `intelligence`，初始版本 `0.1.0`，领域名为 `Intelligence`。

```text
packs/intelligence/
  main.ord
  workflow.json
  README.md
  sources.json
  watchlists.json
  analysis-profiles.json
  brief-profiles.json
  subscription-plans.json
  examples/
    minimal-sources.json
    minimal-watchlist.json
```

`main.ord` 只声明 domain、port 和 flow；JSON 文件是 pack 的业务配置，由安装
时解析、校验并以 manifest 固化。它们不写入 Vault 的运行时目录。

## 配置职责

### `sources.json`

定义可用来源和查询规则，先预留空数组以等待用户提供详细列表。每个 source
至少包含 `id`、`kind`、`enabled`、`schedule` 和不含凭据的 `config`。支持的
kind 预留为 `paper-search`、`paper-record`、`research-group`、`technical-blog`、
`funding`、`patent` 和 `silicon-valley-cv`，后续可扩展。`silicon-valley-cv`
表示面向硅谷计算机视觉（CV）生态的专题来源集合，可以包含实验室、公司、
会议活动、技术博客、招聘和投融资动态；具体站点和查询条件留在 pack 配置中，
不写入通用 tool。

```json
{
  "schema_version": "polaris.intelligence.sources.v1",
  "sources": [{
    "id": "papers-placeholder",
    "kind": "paper-search",
    "enabled": false,
    "schedule": "daily",
    "config": {"query": "", "authors": [], "organizations": [], "venues": []}
  }]
}
```

### `watchlists.json`

定义关注主题、人物、课题组、机构和技术方向。实体使用稳定的 pack 内 ID；
显示名称和别名可以在此配置，避免 tool 依赖业务名单。

### `analysis-profiles.json`

选择要运行的基本指标和技术分析。基本分析至少预留：总量日/周/月变化、来源
构成、主题热度、课题组活跃度、作者/机构活跃度和异常变化。技术分析至少预留：
情报关联图、论文/专利/基金/博客关联、主题聚类、关键词权重变化、课题组研究
重心漂移和路线相似度。

配置只选择算法和阈值，不携带算法实现：

```json
{
  "schema_version": "polaris.intelligence.analysis-profiles.v1",
  "profiles": [{
    "id": "default",
    "basic_metrics": ["volume-over-time", "group-activity"],
    "technical_analyses": ["signal-relations", "group-focus-shift"]
  }]
}
```

### `brief-profiles.json` 与 `subscription-plans.json`

简报 profile 定义栏目顺序、语言、引用和证据要求；订阅计划定义来源、watchlist、
分析内容、频率和渠道类型。订阅者地址、渠道凭据和授权范围由 Polaris 运行时保存，
pack 只声明可复用的内容计划。订阅计划应支持将 `silicon-valley-cv` 与论文、
专利、基金等来源组合，也支持单独订阅硅谷 CV 专题；默认先保留空的 `source_ids`
和 `watchlist_ids`，等待用户提供详细来源清单。

```json
{
  "schema_version": "polaris.intelligence.subscription-plans.v1",
  "plans": [{
    "id": "silicon-valley-cv-daily",
    "source_kinds": ["silicon-valley-cv"],
    "source_ids": [],
    "watchlist_ids": [],
    "include_analysis": true,
    "frequency": "daily",
    "channels": ["email"]
  }]
}
```

## Port 与通用 tool 边界

建议声明四个 port，均使用 FFI binding；tool 只接收 pack 解析后的引用和结构化
配置，不读取仓库或数据库中的业务名单。

| Port | 通用职责 | 典型命令 |
| --- | --- | --- |
| `intelligence.collection` | 来源适配、抓取、规范化、去重、快照 | `prepare`, `collect`, `normalize`, `validate` |
| `intelligence.analysis` | 统计、关系图、趋势和重心漂移 | `basic`, `technical`, `validate` |
| `intelligence.brief` | 将快照和分析结果渲染为可审计简报 | `prepare`, `draft`, `validate`, `publish` |
| `subscription.delivery` | 过滤、幂等投递和回执 | `prepare`, `push`, `record` |

分析 tool 是新开发的通用引擎，内部可分为 `metrics`、`graph`、`trend` 三层，
不得写入任何特定课题组或来源逻辑。失败结果必须包含可重试错误、来源级状态
和证据引用。

## Workflow

### `IntelligenceCollection`

加载 sources、watchlists 和增量状态；执行 collect → normalize → deduplicate；
输出带来源、时间戳、内容哈希和证据引用的 `snapshotRef`。

### `IntelligenceDailyBrief`

读取快照和 analysis profile，分别执行 `basic` 与 `technical`，再按 brief profile
生成、校验并发布 Markdown（可选 PDF）。技术分析失败时不得静默生成“完整”结论，
简报必须标注缺失分析和来源级失败。

### `IntelligenceSubscriptionDelivery`

读取已发布简报和 subscription plan，按授权范围过滤，向运行时解析出的目标投递，
记录幂等键、时间、结果和失败原因。重复执行不得重复发送已确认的投递。

### `IntelligenceDailyRun`（组合 flow）

按顺序编排上述三个 flow。每日触发由 Polaris durable job 或外部 scheduler 负责，
pack 不声明 cron，也不创建常驻进程。

## 数据、可靠性与安全

- 产物引用：`collectionSnapshotRef`、`basicAnalysisRef`、`technicalAnalysisRef`、
  `briefRef`、`manifestRef`、`deliveryRef`。
- 所有产物保留 pack 版本、配置摘要、输入引用和生成时间，支持重放与审计。
- 来源级超时、限流和重试必须可观察；部分失败要能继续处理其他来源。
- 网络权限采用最小化 allowlist；凭据通过运行时 secret 注入，日志必须脱敏。
- 发布前校验引用完整性、时间窗口、重复记录和订阅授权；不满足时阻止投递。

## 0.5.0 实施拆分

1. **契约**：建立 pack manifest、五个 JSON schema、port 命令和错误模型。
2. **采集 MVP**：实现论文、博客、基金、专利的抽象 adapter，以及快照去重。
3. **分析 MVP**：实现基本指标、关联图和课题组重心漂移，并提供合成 fixture。
4. **简报与投递**：实现 Markdown 渲染、计划过滤、幂等投递和审计回执。
5. **运行接入**：注册 pack、durable job 调度、权限检查、失败重试和观测指标。
6. **文档与样例**：补充用户提供的详细来源列表、迁移说明和端到端演示。

## 验收标准

- 安装、解析、校验和卸载 `intelligence` pack 不影响 `autoresearch`。
- tools 的代码和测试中不存在真实业务名单、来源 URL 或凭据。
- 使用合成来源可完成增量收集、去重、基本分析、技术分析和简报发布。
- 至少能验证“情报总量变化”“指定课题组数量变化”“情报关联”以及“课题组重心转移”，
  并保留可追溯输入引用。
- 同一订阅计划重复运行不会重复投递；失败可重试且有明确回执。
- 任一来源失败、分析缺失或授权失效都会在简报/投递状态中显式呈现。

## 未决事项

用户后续提供详细订阅源、关注对象、更新频率、语言和渠道列表后，补充 JSON 样例、
source adapter 优先级、默认分析 profile 及渠道适配测试；这些内容不应改变上述
pack/tool 边界。
