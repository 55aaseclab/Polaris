## Context

Polaris 已经把大量控制面状态放在文件系统里。
workspace status 是 per workspace 的，driver 选择也是 per workspace
的，但认证材料仍然零散地挂在 `UserProfile`、attachment 约定和运行时组
装逻辑上。

这导致三个问题。
第一，`UserProfile` 同时表达“是谁”和“拿什么认证”，职责过重。
第二，一个用户无法被清晰地建模为拥有多个可复用 credentials。
第三，workspace 无法显式表达“我用哪个 driver”和“我用哪些 credentials”
这两个独立决定。

本次设计保持现有文件式控制面方向。
不引入数据库。
凭据注册表只保存声明、元数据和 material 引用。
secret material 继续保存在既有文件或 attachment 承载位置。

## Goals / Non-Goals

**Goals:**

- 把 `Credential` 提升为独立于 `UserProfile` 的一等实体。
- 让一个用户拥有多个 credentials。
- 让一个 workspace 按用途绑定多个 credentials。
- 让 workspace driver 选择与 credential 选择显式解耦。
- 继续使用纯文件注册表保存 credential 声明。
- 复用既有 attachment class 表达 secret material 的生命周期和作用域。
- 为现有 `UserProfile` 内联认证字段提供有界兼容路径。

**Non-Goals:**

- 引入数据库或集中式凭据服务。
- 在 registry 文件中内联保存 secret material。
- 一次性重做全部 identity、authorization 或 tenancy 能力。
- 第一阶段支持所有可能的 credential provider 或自动轮换策略。

## Decisions

### Decision: `Credential` 作为用户拥有的独立实体存在

系统应把 `Credential` 建模为用户拥有的独立实体，而不是 `UserProfile`
里的嵌套字段。

建议最小结构如下：

- `id`
- `userId`
- `kind`
- `label`
- `purposes`
- `materialRef`
- `metadata`
- `status`

Rationale:

- 它把“身份主体”和“认证材料”分开。
- 它允许一个用户拥有多份同类或异类凭据。
- 它允许 workspace 通过引用复用凭据，而不是复制认证配置。

Alternatives considered:

- 继续把 SSH、Codex、token 字段留在 `UserProfile` 内。
  Rejected，因为这会继续把身份和认证耦合起来。
- 在 workspace 内联完整 credential 定义。
  Rejected，因为它会破坏跨 workspace 复用和用户级所有权边界。

### Decision: 使用纯文件 credential registry，而不是数据库

credential registry 应继续使用文件目录布局。
每个 credential 用单独文件声明。

建议布局：

- `config/users/profiles/<user>.yaml`
- `config/users/credentials/<user>/*.yaml`

Rationale:

- 现有控制面已经以文件为主。
- 凭据定义是低频配置，不需要数据库查询能力。
- 文件模型更容易审计、迁移、导入导出和纳入版本管理。

Alternatives considered:

- 使用 SQLite 保存 credential 实体。
  Rejected，因为当前需求是注册表建模，不是高并发事务问题。
- 用单个大文件保存所有 credentials。
  Rejected，因为它不利于逐个 credential 管理和局部更新。

### Decision: `driver` 选择和 `credential` 绑定显式分离

workspace 模型应把 backend or driver 选择和 credential bindings 分成两
个字段域。

建议 binding 结构：

- `purpose`
- `credentialId`
- `required`

示例：

```text
Workspace
- driver = codex
- bindings:
  - purpose: agent-auth
    credentialId: codex-default
  - purpose: git-auth
    credentialId: github-ssh
```

Rationale:

- driver 描述“怎么运行 workspace”。
- credential 描述“运行或访问时使用哪份认证材料”。
- 同一个 driver 可以搭配不同凭据。

Alternatives considered:

- 把 credential 选择塞进 driver 配置。
  Rejected，因为这会让 driver 模型承载用户认证策略。

### Decision: credential material 通过 `materialRef` 指向 attachment 或外部文件

registry 文件只保存 material 引用，不保存 secret 内容。
`materialRef` 可以先支持文件型引用，并允许映射到现有 attachment class。

示例：

```yaml
id: github-ssh
userId: alice
kind: ssh-key
label: GitHub SSH
purposes:
  - git-auth
materialRef:
  type: file
  key: user-ssh-state/github_ed25519
metadata:
  provider: github
status: ready
```

Rationale:

- 这保持 registry 可读、可审计且不暴露 secret material。
- 它复用现有 `user-ssh-state` 和 `user-identity-state` 语义。

Alternatives considered:

- 在 credential YAML 内联 secret。
  Rejected，因为它扩大泄漏面，也破坏现有 attachment 边界。

### Decision: credential kind 必须覆盖 `ssh`、`codex` 和通用 token 类材料

第一阶段的 `Credential.kind` 至少应覆盖：

- `ssh-key`
- `api-key`
- `codex-auth`
- `git-https-token`
- `kubeconfig`
- `cloud-token`

Rationale:

- 用户已经明确要求 `ssh` 和 `codex` 进入统一 credential 模型。
- 这些类型覆盖了当前最实际的 workspace 认证面。

Alternatives considered:

- 只支持 SSH。
  Rejected，因为那会让 Codex 和其他 agent auth 继续停留在特例路径。

### Decision: workspace status 继续 per workspace 持久化，不迁移到 credential 实体

credential 是可复用声明和材料绑定。
workspace status 仍然描述单个 workspace 的运行态、选择态和观测态。

Rationale:

- 用户已经要求状态信息 per workspace。
- credential 不应承载 workspace-specific runtime state。

Alternatives considered:

- 在 credential 上挂载共享运行态。
  Rejected，因为这会混淆声明对象和 runtime observation。

### Decision: 提供从旧 `UserProfile` 认证字段到新 credential registry 的兼容解析

加载器在迁移期应允许旧配置继续运行。
当 workspace 仍依赖旧 profile 字段时，系统可派生临时 credential view，
但新的持久化输出应朝显式 credential bindings 收敛。

Rationale:

- 这降低现有配置一次性切换成本。
- 它允许分阶段迁移 loader、runtime assembly 和文档。

Alternatives considered:

- 立即移除所有旧字段支持。
  Rejected，因为这会让变更面过大。

## Risks / Trade-offs

- [`UserProfile` 与 `Credential` 同时存在会增加模型数量]
  → 用明确职责文档和配置结构约束两者边界。
- [兼容期内旧字段和新 bindings 并存会增加解析复杂度]
  → 规定优先级，显式 bindings 优先于兼容派生。
- [文件 registry 可能出现引用失效或材料缺失]
  → 在加载阶段校验 `materialRef` 可解析性和 owner 一致性。
- [不同 credential kind 到 attachment 的映射可能不一致]
  → 把映射规则下沉为统一 runtime assembly 契约，而不是散落在 driver。
- [未来需要共享或轮换凭据时，纯文件模型扩展性有限]
  → 第一阶段先确保对象边界正确，再视需求追加 provider 层。

## Migration Plan

1. 新增用户级 credential registry 文件布局和解析模型。
2. 让 workspace 配置支持显式 credential bindings。
3. 让 runtime assembly 先读取显式 bindings，再回退到旧 profile 字段。
4. 把 SSH、Codex 和常见 token 路径迁移到 credential kind 映射。
5. 更新 workspace 保存和文档，使新输出默认写入 credential bindings。
6. 为旧 `UserProfile` 内联认证字段保留有界兼容期。
7. 在完成配置迁移后，移除将 `UserProfile` 视为主认证源的路径。

## Open Questions

- `materialRef` 的 `type` 是否第一阶段只支持 `file`，还是同时支持
  attachment-style 引用别名。
- `Credential.status` 是否只表达解析与材料可用性，还是要覆盖更强的健康语
  义。
- workspace 是否需要为同一 `purpose` 允许主备凭据，还是第一阶段限定一
  对一绑定。
