# Isolation Maturity

本文档描述 Polaris 当前的 workspace 隔离模型。

重点是把四件事拆开：

- workspace saved spec
- attachment 边界
- runtime assembly
- backend realization

这四者相关，但不是同一个层次。

## 一句话原则

- Polaris 先定义 workspace，再映射到底层 backend。
- workspace 的持久化边界由 attachment 决定，不由 home 目录决定。
- runtime 内看到的路径是装配结果，不是持久化契约本身。
- backend 负责承载 workspace，Polaris 负责校验 workspace 是否被正确装配。

## 核心对象

- workspace：隔离开发环境的最小控制面对象。
- saved spec：workspace 的保存态定义。
- attachment：workspace 的持久化和共享边界。
- runtime assembly：workspace 在容器、Pod 或 VM 内的实际装配结果。
- backend：承载该 workspace 的运行基座。

## 文件落点

- workspace 定义：
  `config/users/<userId>/workspaces/<workspace>/<backend>.agent.yaml`
- generated manifest：
  `config/users/<userId>/workspaces/<workspace>/generated/<backend>.yaml`
- backend 选择：
  `config/users/<userId>/workspaces/<workspace>/state/selection.json`
- workspace 状态：
  `config/users/<userId>/workspaces/<workspace>/state/status.json`
- workspace provision job：
  `config/users/<userId>/workspaces/<workspace>/state/provision.json`

## 当前模型

### workspace 先于 backend

Polaris 当前先构造一个标准化 workspace 对象。

当前至少包含：

- workspace identity
- backend kind 和可选 profile
- attachment 定义
- runtime contract
- user identity 装配需求
- credential 绑定结果
- health / readiness 约束

backend 只是这个 workspace 的一种实现方式。

因此：

- `docker`、`pod`、`kubevirt-vm` 是 realization
- workspace 本身才是 source of truth

### attachment 是隔离边界

Polaris 当前用 attachment 表达持久化与共享语义。

当前 attachment 包括：

- `workspace-data`
- `workspace-runtime-state`
- `user-identity-state`
- `ephemeral-runtime`

当前语义是：

- `workspace-data` 属于 workspace 自身
- `workspace-runtime-state` 属于 workspace 自身
- `user-identity-state` 属于用户，但会被装配进 workspace
- `ephemeral-runtime` 属于非持久运行时垃圾区

这意味着 workspace 的隔离不是靠“整块 home 目录持久化”实现的。

而是靠 attachment 分类实现的。

### runtime assembly 是装配结果

workspace 在 runtime 内看到的是装配后的路径视图。

当前关键路径包括：

- `/workspace/project`
- `/workspace/state`
- `/identity`
- `/run/workspace`
- `~/.paseo`
- `~/.codex`
- `~/.claude`
- `~/.ssh`

这些路径当前语义是：

- 有些直接对应 attachment mount root
- 有些是 attachment 装配后的 symlink 或 runtime view

因此：

- runtime home 不是持久化契约
- runtime path 缺失首先是 assembly 问题
- assembly 修复不等于 durable state 迁移

### backend 是承载面

Polaris 当前支持三种 workspace backend：

- `docker`
- `pod`
- `kubevirt-vm`

其中 `pod` 还支持 profile 细分，例如：

- `gvisor`
- `kata-qemu`
- `kata-clh`
- `kata-qemu-tdx`

当前 backend 语义是：

- 三种 backend 承载同一个 workspace 模型
- generated manifest 是 workspace 到 backend 的派生产物
- status / drift / reconcile 都基于标准化 workspace 对象执行

## 性能相关的当前实现

最近一轮优化不只是“更快一点”，而是把 workspace 隔离模型里最贵的
两个路径重新拆开了：

- image provisioning
- status observation

### shared prebuilt image

对 `docker` 路径，Polaris 当前已经优先走 shared prebuilt image。

当前语义是：

- 以 workspace prebuilt Dockerfile 内容做 digest
- 先查 shared image 是否已经存在
- 如果存在，只做 workspace tag
- 只有 shared image 缺失时才真正 build

这意味着：

- workspace identity 和 image identity 已经解耦
- 多个 workspace 可以复用同一个 prebuilt image
- “创建 workspace” 不再天然意味着“重新 build 一整套 image”

当前关键文件：

- `apps/polaris/scripts/config/provision.ts`
- `apps/polaris/scripts/config/scaffold.ts`
- `config/users/<userId>/docker/workspace-prebuilt.Dockerfile`

当前关键日志：

- `workspace-shared-image-build`
- `workspace-image-reused`
- `workspace-image-tag`

验收时不要只看 UI 快不快。
还要确认日志里确实命中了复用，而不是只是机器碰巧快。

### cached status before deep probe

workspace 状态当前已经不再把 deep probe 当成默认读路径。

当前语义是：

- `status.json` 是工作空间状态缓存
- `provision.json` 是创建 job 状态缓存
- portal detail read 优先读缓存
- expensive probe 只在显式 refresh 或生命周期关键点执行

因此：

- 读取 workspace detail 不应该默认触发新的 backend 深探测
- backend running / runtime ready / daemon ready 的表达已经可以先来自
  缓存状态面
- 状态刷新和状态读取现在是两个动作，不再绑定在一起

当前关键文件：

- `apps/polaris/scripts/portal/service.ts`
- `apps/polaris/scripts/executor/operations.ts`
- `apps/polaris/scripts/runtime/status-observer.mjs`

当前关键状态文件：

- `config/users/<userId>/workspaces/<workspace>/state/status.json`
- `config/users/<userId>/workspaces/<workspace>/state/provision.json`

## attachment 语义

### workspace-data

`workspace-data` 表示 workspace 自己的数据面。

当前语义是：

- scope 是 `workspace`
- sharing 是 `exclusive`
- 默认 mount root 是 `/workspace/project`

它承载：

- project 文件
- workspace 本地输出
- 该 workspace 独占的数据

### workspace-runtime-state

`workspace-runtime-state` 表示 workspace 自己的运行时持久态。

当前语义是：

- scope 是 `workspace`
- sharing 是 `exclusive`
- 默认 mount root 是 `/workspace/state`

当前重点路径包括：

- `/workspace/state/paseo`
- `/workspace/state/paseo/evolution`

它承载：

- manager state
- pairing state
- evolution state
- workspace 自己的运行时持久物料

### user-identity-state

`user-identity-state` 表示会被装配进 workspace 的用户身份物料。

当前语义是：

- scope 是 `user`
- sharing 是 `cross-workspace`
- 默认 mount root 是 `/identity`

它承载：

- `codex`
- `claude`
- `copilot`
- `pi`
- `opencode`
- `ssh`

当前还包括和 Codex 持久化相关的 XDG 根：

- `codex-xdg/config`
- `codex-xdg/data`
- `codex-xdg/state`

这些目录不是实现噪音。
它们属于用户身份持久化契约的一部分。

## Toolchain Assembly

workspace 内看到的 agent CLI 不应该只理解成“镜像里自带了一个二进制”。

Polaris 当前把工具链拆成三层：

1. 持久化工具安装根
2. runtime 内的稳定入口
3. 针对特定 provider 的环境包装

### 持久化工具安装根

当前 Docker backend 会把工具安装到：

```text
/workspace/state/tooling/polaris
```

这就是当前 runtime state volume 里的 tool root。

它承载：

- `paseo`
- `codex`
- `claude`
- `copilot`
- `opencode`
- `pi`
- `pnpm`
- 对应的 `node_modules`

这样做的目的不是好看。
而是为了：

- workspace 重启后不重复安装 agent CLI
- 把工具链缓存从镜像层和临时容器层解耦出来
- 让 runtime bootstrap 更稳定

### 真实 binary 与 wrapper 的关系

当前有两种 `codex` 路径同时存在：

```text
/workspace/state/tooling/polaris/bin/codex
/usr/local/bin/codex
```

它们不是重复，也不是冲突。

当前语义是：

- `/workspace/state/tooling/polaris/bin/codex`
  是真实的 Codex CLI 安装入口
- `/usr/local/bin/codex`
  是 Polaris 在 bootstrap 时生成的 wrapper

wrapper 的职责是：

- 注入 `CODEX_HOME`
- 注入 `XDG_CONFIG_HOME`
- 注入 `XDG_DATA_HOME`
- 注入 `XDG_STATE_HOME`
- 注入 `NPM_CONFIG_PREFIX`
- 然后再 `exec` 到真实 binary

也就是说，用户或脚本如果执行：

```text
/usr/local/bin/codex
```

拿到的是 Polaris 期望的持久化环境。

### 为什么还会看到真实 binary 直启

有些上层运行时不会只依赖 shell PATH。

例如当前 Paseo 的 Codex provider 可能直接解析并启动：

```text
/workspace/state/tooling/polaris/bin/codex app-server
```

这不代表 wrapper 没意义。
这只说明上层 provider 走的是“真实 binary + 显式 env 注入”模型，而不是
“纯 PATH 查找”模型。

所以验收时不能只看命令行长什么样。
要同时看：

- 实际启动命令
- 实际进程环境变量

### Codex 持久化为什么依赖 XDG

当前 Codex 会把会话相关状态写到：

- `CODEX_HOME`
- `XDG_CONFIG_HOME`
- `XDG_DATA_HOME`
- `XDG_STATE_HOME`

至少从当前 Paseo 集成假设来看，thread resume 需要依赖这些目录里的持久化
rollout / session 数据。

因此：

- 只持久化 `~/.codex/auth.json`
  这类凭证文件是不够的
- 只记住 `threadId`
  也不够
- 必须把 thread handle 与对应的持久化状态目录一起看成恢复契约

### 当前容易踩的坑

如果只持久化了 provider handle，例如：

- `threadId`
- `nativeHandle`

但没有保证对应的 Codex rollout/session 文件仍然存在，就会出现：

- Paseo 记得要恢复哪个 thread
- Codex 却找不到该 thread 对应的 rollout
- 最终报 `no rollout found for thread id ...`

这不是 Codex 自己的隔离问题。
这是 Polaris / runtime integration 在恢复契约上做得不完整。

### 当前应有的恢复原则

对这种 provider session 恢复，正确模型应该是：

- 句柄存在，不代表会话一定可恢复
- provider handle 必须和其 durable state 一起验证
- 如果 durable state 已丢失，应该把该 handle 视为失效
- 失效后应退回冷启动，而不是把整个 workspace detail 或 agent timeline
  请求打爆
- 以及 Polaris 用户级凭证物料

它会被装配到 workspace runtime 中，例如：

- `~/.codex`
- `~/.claude`
- `~/.copilot`
- `~/.pi`
- `~/.config/opencode`
- `~/.local/share/opencode`
- `~/.ssh`

### ephemeral-runtime

`ephemeral-runtime` 表示不应被当成 durable state 的运行时区域。

当前语义是：

- 默认 mount root 是 `/run/workspace`
- 包含 temp、pid、socket 等运行时物料
- stale artifact 可被清理

当前典型 stale artifact 包括：

- `/run/workspace/pids/paseo.pid`

## workspace 状态语义

Polaris 当前不会只回答“backend 是否活着”。

workspace 隔离状态至少分开表达：

- backend existence
- backend running
- attachment 是否到位
- runtime assembly 是否到位
- daemon readiness 是否到位
- service object 是否到位

因此：

- backend running 不等于 workspace ready
- attachment 挂载成功不等于 runtime assembly 正确
- runtime assembly 正确也不等于 daemon ready

最近一轮优化还补上了一个现实约束：

- 状态面需要允许“先写缓存，再异步校正”

也就是：

- start / stop / live switch 这类动作可以先更新缓存状态
- 后续再由异步 refresh 或 runtime status observer 把状态面校正到最新事实

这样做的目的不是放弃准确性，而是避免每次用户动作都同步卡在重探测上。

## 主流程

### 1. 加载 workspace

1. 读取 saved spec。
2. 标准化 backend、attachment、runtime、credential 和 health 约束。
3. 构造统一 workspace 对象。

### 2. 生成 backend realization

1. 根据 workspace 选择 backend driver。
2. 渲染 generated manifest。
3. 把 manifest 写入 `generated/`。

### 3. 启动 runtime

1. backend 启动 container、Pod 或 VM。
2. Polaris 期望 attachment 被正确挂载。
3. Polaris 期望 runtime home 被正确装配。
4. Polaris 再检查 daemon readiness。

### 4. 合成状态

1. 读取 backend observation。
2. 检查 attachment presence。
3. 检查 runtime assembly。
4. 合成 `status.json`。
5. 在需要时再执行额外 refresh 或 observer-driven patch。

## 调试重点

如果你在隔离层排查“为什么创建慢”或“为什么状态跳来跳去”，先区分是
哪个层的问题：

### image 路径

看这些日志：

- `workspace-shared-image-build`
- `workspace-image-reused`
- `workspace-image-tag`

如果没有命中复用，而 Dockerfile 又等价，优先检查 digest 输入和 image
availability 路径。

### status 路径

看这些日志：

- `workspace-provision-progress`
- `workspace-status-cached`
- `workspace-status-reported`
- `workspace-status-refresh-started`
- `workspace-status-refresh-completed`

如果页面慢，不要先假设 backend 慢。
先确认是不是 portal read 被错误地重新绑回 deep probe 了。

最小检查命令：

```bash
curl -sS http://127.0.0.1:8787/api/users/<user>/workspaces/<workspace> >/tmp/detail.json
cat config/users/<user>/workspaces/<workspace>/state/status.json
cat config/users/<user>/workspaces/<workspace>/state/provision.json
rg -n "workspace-status-cached|workspace-status-reported|workspace-status-refresh" \
  .tmp/paseo/stack.executor.err.log
```
4. 检查 daemon 和 pairing。
5. 合成 workspace status 和 drift。

## backend 切换

workspace 当前可以被指向不同 backend realization：

- `<project>@docker`
- `<project>@pod[:profile]`
- `<project>@kubevirt-vm`

当前语义是：

- 切换的是 backend realization
- 不变的是 workspace 语义边界
- `selection.json` 记录当前默认 backend

缺少某个 backend spec 时，Polaris 也可以从现有 workspace spec 合成目标
backend spec。

## 边界

- Polaris 当前关注的是 workspace 隔离边界，不是整机虚拟化抽象本身。
- runtime home 不是 source of truth。
- generated manifest 不是 source of truth。
- user identity 会进入 workspace，但不改变 workspace-data 和
  workspace-runtime-state 的独占边界。
- 三种 backend 已接入同一个 workspace 模型，但 operational depth 仍不完全
  对齐。

## CLI 设计

当前 workspace 隔离模型已经有明确的 CLI 命令面。

根入口是：

```bash
pnpm --dir apps/polaris run polaris -- ...
```

### workspace 创建

```bash
pnpm --dir apps/polaris run polaris -- create <workspace> --user <userProfileId>
```

当前语义是：

- 创建 workspace saved spec
- 绑定目标用户
- 初始化默认 backend 路径

### render

```bash
pnpm --dir apps/polaris run polaris -- render <workspaceRef>
```

当前语义是：

- 加载标准化 workspace 对象
- 生成目标 backend manifest
- 写入 `generated/`

这一步只处理 realization，不直接启动 runtime。

### apply

```bash
pnpm --dir apps/polaris run polaris -- apply <workspaceRef>
```

当前语义是：

- 把 generated manifest 应用到底层 backend
- 创建 container、Pod 或 VM 所需资源

### start

```bash
pnpm --dir apps/polaris run polaris -- start <workspaceRef>
```

当前语义是：

- 启动目标 backend runtime
- 等待 backend 与 runtime assembly 进入可用状态

### stop

```bash
pnpm --dir apps/polaris run polaris -- stop <workspaceRef>
```

当前语义是：

- 停止当前 workspace 的 backend runtime
- 不直接删除 workspace saved spec

### restart

```bash
pnpm --dir apps/polaris run polaris -- restart <workspaceRef>
```

当前语义是：

- 对当前 workspace runtime 执行重启
- 保留 workspace attachment 语义边界

### rebuild

```bash
pnpm --dir apps/polaris run polaris -- rebuild <workspaceRef>
```

当前语义是：

- 刷新 workspace realization 所依赖的镜像或生成物
- 再进入 backend 生命周期流程

### status

```bash
pnpm --dir apps/polaris run polaris -- status <workspaceRef>
```

当前语义是：

- 检查 backend existence 和 running
- 检查 attachment presence
- 检查 runtime assembly
- 检查 daemon / service readiness
- 合成 `status.json`

### reconcile

```bash
pnpm --dir apps/polaris run polaris -- reconcile <workspaceRef>
```

当前语义是：

- 基于 workspace drift 生成修复动作
- 执行允许的 repair / restart / re-render / re-apply 动作

### logs

```bash
pnpm --dir apps/polaris run polaris -- logs <workspaceRef>
```

当前语义是：

- 读取当前 workspace runtime 的后端日志
- 用于辅助判断 runtime assembly 和 backend 问题

### switch

```bash
pnpm --dir apps/polaris run polaris -- switch <workspaceRef>
```

当前语义是：

- 切换 workspace 的 backend realization
- 持久化新的 backend 选择
- 在需要时迁移 workspace 相关 attachment 视图

### delete

```bash
pnpm --dir apps/polaris run polaris -- delete <workspaceRef>
```

当前语义是：

- 删除 workspace saved spec
- 删除该 workspace 的 backend realization
- 删除该 workspace 自己的状态目录

当前不会把 `user-identity-state` 当成 workspace 删除目标。

### live-switch

```bash
pnpm --dir apps/polaris run polaris -- live-switch <workspaceRef> <credentialId> \
  [--harness <ssh|codex|claude|copilot|opencode|pi>]
```

当前语义是：

- 在运行中的 workspace 内切换某个 harness 的运行时凭证
- 写入 workspace 对应的 live selection
- 刷新当前 workspace 状态

这属于 workspace 运行时装配命令面，不属于用户管理命令面。

### 设计约束

- CLI 先面向 workspace，再面向 backend 细节。
- `<workspaceRef>` 可以显式指定 backend，例如 `demo@docker`。
- `render` / `apply` / `start` / `status` 都围绕同一个 workspace 对象执行。
- 切换 backend 不改变 workspace attachment 语义。
- 删除 workspace 不删除用户级 identity attachment。
