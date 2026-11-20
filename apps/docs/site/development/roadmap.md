# Built-in edition / 内置版

Publish a workspace-bound viewer, verify the empty state and a synthetic run, and mount it behind the Praxis gateway.

发布按工作区隔离的观察界面，用空状态和合成运行验收，再由工作台网关提供入口。

Verify the provider descriptor, resolved/unknown inventory and runtime card exclusion with synthetic metadata.

用合成元数据验证 provider 声明、数据位置已登记／未知状态及 runtime 卡片排除。


## Runtime trace metadata / 运行留痕元数据

Verify metadata-only HTTP/provider reads, private-file/workspace checks, finite pagination retaining failed runs, safe omission of bodies and credentials, and explicit unconfigured/empty/unavailable states. Keep the observer read-only and never synthesize missing MCP steps.

验收纯元数据 HTTP 与 provider 读取、私有文件与工作区检查、保留失败运行的有限分页、正文与凭据排除，以及未配置、空态和不可用的区分。观察器保持只读，不补造缺失 MCP 步骤。

## App-owned Praxis integration

This app owns its reviewed `praxis-integration.mjs`: native entry policy, typed business operations and MCP guidance where supported. Praxis loads that declaration from the installed source and retains authorization, signing, policy leases and audit. Installation does not grant access or start a backend. Existing native interfaces, data ownership and recovery boundaries remain in force.

## 应用自有 Praxis 集成

本应用在所属仓库维护经审核的 `praxis-integration.mjs`，声明原生入口策略，以及已支持的类型明确的业务操作与 MCP 指引。Praxis 从已安装源码加载声明，继续统一执行授权、签名、策略租约与审计。安装声明不会授予访问权限，也不会启动后端；已有原生界面、数据归属与恢复边界继续生效。
