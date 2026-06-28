# Polaris 门户业务流程

本文档描述 Polaris 门户当前采用的业务模型。

重点是把三件事拆开：

- Paseo daemon 生命周期
- workspace 内可用的 harness / CLI
- 用户选择的凭证

这三者相关，但不是同一个开关。

## 一句话原则

- Polaris 负责工作空间、运行时状态和工作空间视角下的凭证呈现。
- Paseo daemon 与 harness 可用性属于基础设施。
- 凭证选择属于用户级配置，不负责开启或关闭基础设施。

## 核心对象

- 工作空间：用户拥有的开发运行环境。
- 工作空间凭证绑定：兼容路径，只在当前驱动上覆盖某个用途。

## 文件落点

- 工作空间定义：
  `config/users/<userId>/workspaces/<workspace>/`
- 工作空间状态：
  `config/users/<userId>/workspaces/<workspace>/state/status.json`

## 当前模型

### 工作空间运行时

工作空间启动时：

- 仍会准备 Paseo daemon
- 仍会安装 harness tooling
- 会尝试挂载当前用户激活中的 Codex 凭证
- 如果没有激活中的 Codex 凭证，工作空间仍然可以启动

没有激活 Codex 凭证时，状态应该表达为：

- 基础设施已就绪
- 凭证未选中

而不是：

- agent 被禁用
- daemon 未开启

## 主流程

### 1. 创建工作空间

1. 前端提交工作空间名称。
2. 后端创建工作空间目录和 driver spec。
3. 后端渲染 manifest。
4. 后端写入驱动选择和状态文件。
5. 如请求要求启动，则继续启动默认 driver。

工作空间脚手架：

- 不会隐式创建默认 Codex 凭证
- 不会把凭证创建当成工作空间创建副作用

### 2. 查看工作空间

工作空间详情页同时展示三类信息：

- 基础设施状态
  - backend
  - daemon
  - supported harnesses
- 凭证状态
  - 当前用户是否已选中 Codex 凭证
  - 当前 driver 是否有工作空间级 override
- 资产和控制项

要求：

- daemon 状态和凭证状态必须分开展示
- 没有 Codex 凭证时，不能把 daemon 状态展示成被关闭

### 3. 工作空间级绑定与解绑

当前 `/paseo/bind` 和 `/paseo/unbind` 仍然保留，但它们只是兼容路径。

绑定时：

1. 前端选择一个 `agent-auth` 凭证。
2. 后端只更新当前 driver spec 的
   `credentials.bindings[purpose=agent-auth]`。
3. 后端保留其他绑定，如 `git-auth`。
4. 后端重渲染并重启当前 driver。

解绑时：

1. 后端只移除当前 driver spec 里的 `agent-auth` 绑定。
2. 用户级激活凭证仍然存在。
3. 后端重渲染并重启当前 driver。

关键约束：

- 绑定和解绑不再改写 `agent.kind`
- 绑定和解绑不再改写 `agent.persist_state`
- 绑定和解绑不负责开启或关闭 daemon / harness

## 状态语义

工作空间状态至少要分开表达：

- backend 是否存在、是否运行
- daemon 是否 ready、是否可配对
- harness tooling 是否可用
- Codex 凭证是否已选中

因此：

- 没有激活 Codex 凭证，可以是 `workspace ready`
- 该情况下凭证状态应是 `not-selected`

## 页面职责

### Workspaces 页

- 负责列出工作空间
- 负责展示状态和编排进度

### Workspace Detail 页

- 负责展示基础设施状态
- 负责展示凭证状态
- 负责执行 driver 切换、停止、删除和兼容 override

## 边界

- 工作空间级绑定只是覆盖路径，不是主要凭证管理入口。
