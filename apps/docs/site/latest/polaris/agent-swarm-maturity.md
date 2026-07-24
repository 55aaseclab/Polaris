# Agent Swarm Maturity

本文档描述 Polaris 当前的 agent / manager 模型。

重点是把两件事拆开：

- Paseo daemon
- Paseo server / pairing offer

这两者相关，但不是同一个开关。

## 一句话原则

- Polaris 负责把 manager 运行面装配进工作空间。
- Paseo daemon 是工作空间内的 manager 进程。
- Paseo server / pairing offer 是连接面，不等于 daemon 进程本身。

## 核心对象

- 工作空间：agent 运行的隔离环境。
- Paseo daemon：工作空间内的 manager daemon。
- pairing offer：daemon 暴露出的连接地址和 server identity。

## 文件落点

- 工作空间 manager 状态：
  `config/users/<userId>/workspaces/<workspace>/state/status.json`
- 工作空间 manager 持久态：
  `config/users/<userId>/workspaces/<workspace>/state/`
- 工作空间运行时 manager 数据：
  `/workspace/state/paseo`
- 工作空间运行时 evolution 数据：
  `/workspace/state/paseo/evolution`
- 运行时装配后的 manager home：
  `~/.paseo`

## 当前模型

### Paseo daemon

Paseo daemon 是 Polaris 当前接入的 manager 进程。

当前语义是：

- daemon 运行在工作空间内部
- daemon 默认监听 `0.0.0.0:6767`
- Polaris 在 render / start 阶段负责装配 daemon 运行环境

当前 Polaris 不把 daemon 状态和凭证状态混为一谈。

因此：

- 没有 agent 凭证，不等于 daemon 关闭
- daemon ready，不等于某个 harness 已经选中凭证

### Paseo server / pairing offer

Polaris 当前不是直接控制远端 Paseo server。

它控制的是工作空间内 daemon 生成的 pairing offer。

当前元数据来源已经收口为两份持久文件：

- `~/.paseo/server-id`
- `~/.paseo/pairing.json`

因此当前所谓的 `Paseo server / pairing offer` 更准确说是：

- `server-id` 提供的 server identity
- `pairing.json` 提供的 live target / pairing URL

## 主流程

### 1. 工作空间启动

1. Polaris 装配 workspace data、runtime state 和 user identity。
2. Polaris 装配 `~/.paseo`。
3. Polaris 启动或拉起 Paseo daemon。
4. Polaris 等待 `server-id` 和 `pairing.json` 到位。
5. Polaris 读取 reconnect 元数据并暴露连接入口。

### 2. 查看状态

1. Polaris 检查 backend 是否存在和运行。
2. Polaris 检查 runtime assembly 是否完整。
3. Polaris 读取 `server-id` / `pairing.json` 并组合门户连接信息。

如果门户需要 reconnect 元数据，则单独读取：

- `~/.paseo/server-id`
- `~/.paseo/pairing.json`

但在当前实现里，这个过程已经分成两种路径：

#### 快路径

- 读取 `status.json`
- 读取 live credential selection
- 返回门户状态

#### 慢路径

- 显式 refresh
- start / stop / create finalize
- observer 回报后的校正

这一点很关键，因为“状态页打开很慢”和“daemon 确实有问题”现在不再是
同一个问题。

### 3. 工作空间级 agent-auth 绑定

当前 `/paseo/bind` 和 `/paseo/unbind` 仍然保留，但它们只是兼容路径。

绑定时：

1. 前端选择一个 `agent-auth` 凭证。
2. 后端只更新当前 driver spec 的
   `credentials.bindings[purpose=agent-auth]`。
3. 后端保留其他绑定。
4. 后端重渲染并重启当前 driver。

解绑时：

1. 后端只移除当前 driver spec 里的 `agent-auth` 绑定。
2. 用户级默认凭证和 live runtime selection 仍可独立存在。
3. 后端重渲染并重启当前 driver。

### 4. 运行时 live credential switch

1. 前端选择某个 harness 对应的用户级凭证。
2. 后端调用 live switch 接口。
3. 后端把目标凭证物料写入运行时 identity state。
4. 后端写入当前工作空间的 live selection。
5. 状态刷新后按 harness 展示新的运行时凭证来源。

### 5. Portal create flow

workspace create 仍然属于 agent runtime 体验的一部分，而不是纯控制面脚本。

但当前门户 UI 不再把单独的 create job 文件当成主要状态来源。

现在的原则是：

- workspace 生命周期以 `status.json` 为主
- 过渡中的控制面动作由 `status.operation.kind` 表达
- 实际 runtime 存活状态由 `status.health.backendLiveness` 表达
- 列表和 header 不依赖额外的 create-progress 语义

这意味着：

- 创建成功后，门户直接切到新 workspace
- 失败时也不再靠弹窗内局部状态兜底
- 如果需要解释当前生命周期，优先看
  `status.operation`、`status.health.backendLiveness` 和
  `status.health.reason`

当前 `status.json` 主结构是：

- `project`
- `driver`
  - `backend`
  - `profile`
  - `baseImage`
  - `runtimeKind`
  - `runtimeRef`
  - `rootdiskImage`
- `operation`
  - `kind`
  - `updatedAt`
- `health`
  - `backendLiveness`
  - `workspaceReadiness`
  - `reason`
- `credentials`
  - `ssh`
  - `codex`
  - `live`
- `details`
- `evolution`
- `assets`
- `attachments`
- `runtimeAssembly`

当前已经去掉：

- `status.state`
- `status.backend`
- `health.daemonReadiness`
- 顶层 `ssh`
- 顶层 `drift`

### 5.1 User-scoped workspace identity

portal create 还有一个很关键但很容易漏掉的前提：
`workspace name` 不能再被 portal 路径当成全局唯一键。

现在应该按：

- `userId`
- `workspace`

联合定位。

也就是说：

- `userA/test`
- `userB/test`

应该是两个合法 workspace。

如果 create 阶段允许了这一点，但 start / status / stop / refresh 仍然只按
`test@docker` 去找配置，那么 UI 还是会在 0% 或 finalize 阶段报错。

这一轮修复的意义，不只是“允许重名创建”，而是把整条 portal lifecycle 的
用户上下文带透。

## 页面职责

### Workspace Detail 页

- 展示 daemon 状态
- 展示 pairing 状态
- 展示 supported harnesses
- 展示 live target
- 展示用户级默认凭证解析结果
- 展示各 harness 的 live credential 选择
- 提供工作空间级 override
- 提供 live credential switch

### Sidebar / create flow

最近一轮优化后，用户实际最常感知到的变化在这里：

- sidebar 先显示 workspace 名单
- workspace 状态不再阻塞 sidebar 首屏
- 归档工作空间显示在 sidebar 单独分区
- “开始创建你的第一个工作空间”空态不再混入 archived workspace
- start / stop / switch 后状态仍然按详情页和显式刷新路径更新

也就是说，portal 当前把“名单加载”和“状态读取”分开了。

这部分验收不要只看“最后有没有成功”。
还要看：

- create 后是否直接切到新 workspace
- sidebar 是否不再因为状态刷新而整体变慢
- delete 后是否只是本地导航切换

## 调试重点

如果 agent 相关体验慢或错，先区分是哪一种失败：

### daemon / pairing 真失败

看：

- `workspace-status-reported`
- `workspace-status-refresh-completed`
- `daemon.manager.state`
- `daemon.pairing.state`

### portal 只是没有正确消费当前状态

看：

- `status.json`
- 前端是否还在依赖额外的 create-progress 语义
- 详情页读取是否错误触发了覆盖型 refresh

最小检查命令：

```bash
cat config/users/<user>/workspaces/<workspace>/state/status.json
rg -n "workspace-status-cached|workspace-status-reported|workspace-status-refresh" \
  .runtime/paseo/stack.executor.err.log
```

## 边界

- Polaris 当前接入的是 Paseo-first manager 模型。
- Polaris 当前表达的是单工作空间内的 manager 运行面。
- Polaris 当前已经有多 harness 运行时切换，但还不是完整的 swarm
  task graph。
- credential switch 不负责启动或停止 daemon。
- pairing URL 不等于 credential selection。

## CLI 设计

当前 agent / manager 运行面已经有明确的 CLI 命令面。

精确命令语法集中在 [Polaris CLI](./cli.md)。

### start

当前语义是：

- 启动 workspace runtime
- 装配 `~/.paseo`
- 启动或拉起 Paseo daemon
- 等待 workspace 进入可检查状态

### stop

当前语义是：

- 停止当前 workspace runtime
- 停止该 workspace 内的 daemon 承载环境

### restart

当前语义是：

- 重启当前 workspace runtime
- 保留 manager 相关 durable state 语义边界

### status

当前语义是：

- 检查 backend 是否运行
- 检查 runtime assembly
- 检查 daemon manager 状态
- 检查 pairing 状态
- 输出 `supportedHarnesses`、`liveTarget` 和 credential selection 视图

### logs

当前语义是：

- 读取当前 workspace runtime 的 backend 日志
- 辅助判断 daemon、assembly 和 runtime 问题

### 工作空间级 agent-auth override

当前 CLI 没有单独暴露一个 `bind` / `unbind` 顶层命令。

当前这部分主要通过门户与 executor 路径表达。

语义上它对应的是：

- 给当前 workspace driver 写入 `agent-auth` 绑定
- 或移除当前 driver 上的 `agent-auth` 绑定
- 然后重渲染并重启该 driver

这属于 workspace spec 级 override。

它不等于运行时 live switch。

### live-switch

当前语义是：

- 只对运行中的 workspace 生效
- 校验目标 backend 当前支持 live switch
- 校验目标 credential 与 harness 对应关系
- 把物料写入运行时 `user-identity-state`
- 写入 workspace 当前的 live selection
- 刷新 `status` 视图

当前它属于 workspace runtime 命令面。

它不属于用户管理命令面。

### 设计约束

- daemon 生命周期跟随 workspace runtime，而不是跟随用户凭证状态。
- `status` 负责表达 daemon、pairing、harness 和 selection 的分层状态。
- workspace 级 `agent-auth` override 和 runtime `live-switch` 是两条不同路径。
- `live-switch` 改变的是运行时身份物料，不改变 daemon 类型。
