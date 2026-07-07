## Why

`UserProfile` 现在同时承载身份、认证材料和工作区默认值，边界太重。
一旦一个用户要复用多组 SSH、Codex 或 API 凭据，当前模型就会把认证选
择和 workspace 编排耦合在一起。

Polaris 已经有 per-workspace 状态和大量文件式控制面能力。
这次变更要把 `Credential` 提升为一等实体，让一个用户管理多份凭据，让一
个 workspace 绑定并切换可用凭据，同时继续保持纯文件注册表而不是引入数
据库。

## What Changes

- 新增一等 `Credential` 实体，独立于 `UserProfile` 和 `Workspace`。
- 新增用户级凭据注册表，使用文件目录保存凭据声明和元数据。
- 新增 workspace 级 credential binding，让 workspace 按用途引用多个
  credentials。
- 明确区分 workspace `driver` 选择和 credential 选择。
- 统一把 `ssh`、`codex`、API token、类似认证材料纳入 credential 模型。
- 让 credential 只声明 `materialRef`，不在注册表内联 secret 内容。
- 为现有依赖 `UserProfile` 内联认证字段的路径提供兼容迁移。
- **BREAKING** 后续 runtime 和编排契约将不再把 `UserProfile` 视为认证材
  料的主来源。

## Capabilities

### New Capabilities

- `user-credentials`: 定义用户级 credential 注册表、credential 元数据、
  material 引用和 workspace binding 契约。

### Modified Capabilities

- `workspace-orchestration`: workspace 必须将 driver 选择和 credential
  binding 分开建模。
- `workspace-attachments`: credential material 必须映射到既有用户态和工作
  区态 attachment 语义。
- `workspace-attachment-lifecycle`: user-scoped credentials 必须可跨多个
  workspaces 复用，并遵守显式生命周期边界。
- `workspace-runtime-contract`: runtime 组装必须从 credential bindings
  派生认证材料，而不是直接依赖内联 profile 字段。
- `attachment-config-schema`: 保存的配置模型必须支持 credential registry
  和 workspace credential bindings。

## Impact

- 受影响代码主要在 `apps/polaris/scripts/config/`、workspace 编排模型、
  runtime 组装和状态解析路径。
- 需要新增 `config/users/credentials/<user>/*.yaml` 之类的文件注册表布局。
- 需要调整现有 `UserProfile`、workspace 配置和兼容迁移逻辑。
- 不新增数据库依赖。
- 需要补充配置、解析、绑定解析和迁移测试。
