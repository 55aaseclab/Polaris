# Polaris 门户业务流程

本文档描述 Polaris 门户当前采用的业务模型。

重点是把三件事拆开：

- Paseo daemon 生命周期
- workspace 内可用的 harness / CLI
- 用户选择的凭证

这三者相关，但不是同一个开关。

## 一句话原则

- Clerk 负责认证。
- Polaris 负责用户资料、凭证、工作空间和运行时状态。
- Paseo daemon 与 harness 可用性属于基础设施。
- 凭证选择属于用户级配置，不负责开启或关闭基础设施。

## 核心对象

- Polaris 用户：业务主体，主键是 `userId`。
- Clerk 用户：登录主体，提供登录态和基础身份。
- 工作空间：用户拥有的开发运行环境。
- 用户凭证：用户级对象，当前重点是 `ssh-key` 和 `codex-auth`。
- 工作空间凭证绑定：兼容路径，只在当前驱动上覆盖某个用途。

## 文件落点

- 用户资料：`config/users/profiles/<userId>.yaml`
- 用户凭证：`config/users/<userId>/credentials/*.yaml`
- 工作空间定义：
  `config/users/<userId>/workspaces/<workspace>/`
- 工作空间状态：
  `config/users/<userId>/workspaces/<workspace>/state/status.json`

## 当前模型

### 用户创建

用户创建时只创建用户资料和用户画像要求的必需凭证。

当前用户画像只要求 SSH，因此：

- 会创建 `github-ssh` 这类托管 SSH 凭证
- 会生成 SSH key material
- 不会隐式创建默认 Codex 凭证

### 用户级 Codex 凭证

Codex 凭证现在是用户级对象。

当前第一阶段只提供一个模板：

- `RightCode Codex`

用户可以：

- 新增 Codex 凭证
- 删除 Codex 凭证
- 激活一个 Codex 凭证为当前默认值

同一时间，一个用户只有一个激活中的 Codex 凭证。

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

### 1. 登录

1. 用户通过 Clerk 登录。
2. 前端读取 Clerk 用户信息。
3. 前端查询 Clerk 到 Polaris 用户的映射。
4. 前端跳转到 `/users/<userId>/workspaces`。
5. 后端按用户作用域返回工作空间列表。

异常：

- 没有映射：提示用户未完成 Polaris 侧绑定。
- 普通用户访问他人作用域：返回 `403`。

### 2. 注册

1. 用户通过 Clerk 完成注册。
2. 前端拿到 Clerk 用户名、用户 ID、邮箱和显示名。
3. 前端调用 Polaris 用户创建接口。
4. 后端创建用户资料。
5. 后端按用户画像创建必需凭证。
6. 后端写入 Clerk 到 Polaris 的稳定映射。
7. 前端进入该用户的工作空间首页。

当前注册后自动创建的仅有：

- 用户资料
- 默认托管 SSH 凭证
- Clerk 映射

不会自动创建：

- Codex provider 凭证

### 3. 删除用户

1. 前端请求删除 Polaris 用户。
2. 后端删除用户资料。
3. 后端通过共享 credential service 删除该用户的托管凭证与物料。
4. 后端删除用户工作空间目录和映射。
5. 门户侧按映射结果删除 Clerk 用户。

### 4. 创建工作空间

1. 前端提交工作空间名称。
2. 后端创建工作空间目录和 driver spec。
3. 后端渲染 manifest。
4. 后端写入驱动选择和状态文件。
5. 如请求要求启动，则继续启动默认 driver。

工作空间脚手架：

- 不会隐式创建默认 Codex 凭证
- 不会把凭证创建当成工作空间创建副作用

### 5. 查看工作空间

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

### 6. 新增 Codex 凭证

1. 用户进入 `Profile` 页。
2. 前端展示 `RightCode Codex` 模板。
3. 用户输入 label 和 API key。
4. 前端调用 `POST /api/users/<userId>/credentials`。
5. 后端通过共享 credential service 创建 `codex-auth` 凭证。
6. 后端写入 registry YAML、`auth.json` 和 `config.toml`。
7. 前端刷新凭证列表。

产物：

- `config/users/<userId>/credentials/<credentialId>.yaml`
- `config/users/<userId>/credentials/codex/<credentialId>/auth.json`
- `config/users/<userId>/credentials/codex/<credentialId>/config.toml`

### 7. 激活 Codex 凭证

1. 用户在 `Profile` 页选择一个 Codex 凭证。
2. 前端调用
   `POST /api/users/<userId>/credentials/<credentialId>/activate`。
3. 后端更新该用户凭证 registry 中的激活标记。
4. 后续工作空间运行时默认挂载该用户当前激活的 Codex 凭证。

激活行为是用户级选择，不是工作空间基础设施开关。

### 8. 删除 Codex 凭证

1. 用户在 `Profile` 页删除一个 Codex 凭证。
2. 前端调用
   `DELETE /api/users/<userId>/credentials/<credentialId>`。
3. 后端通过共享 credential service 删除 registry 与生成物料。
4. 前端刷新列表。

### 9. 工作空间级绑定与解绑

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

### 登录 / 注册页

- 负责 Clerk 会话建立
- 负责触发 Polaris 用户创建或查找映射

### Workspaces 页

- 负责列出工作空间
- 负责展示状态和编排进度

### Workspace Detail 页

- 负责展示基础设施状态
- 负责展示凭证状态
- 负责执行 driver 切换、停止、删除和兼容 override

### Profile 页

- 负责管理用户级凭证
- 负责新增、删除、激活 Codex 凭证

## 边界

- Clerk 不管理 Polaris 工作空间。
- Polaris 不管理用户密码。
- 用户级凭证不应再通过工作空间脚手架隐式创建。
- 工作空间级绑定只是覆盖路径，不是主要凭证管理入口。
