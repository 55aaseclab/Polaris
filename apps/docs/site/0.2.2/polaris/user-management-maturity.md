# Polaris 用户管理成熟度

本文档描述 Polaris 当前的用户管理模型。

重点是把四件事拆开：

- Clerk 认证
- Polaris 用户资料
- 用户级凭证
- Clerk 到 Polaris 的稳定映射

这四者相关，但不是同一个对象。

## 一句话原则

- Clerk 负责登录态和认证入口。
- Polaris 负责用户资料、用户凭证和工作空间归属。
- 用户级凭证属于 Polaris 用户，不属于单个工作空间。
- 工作空间不负责隐式创建用户级凭证。

## 核心对象

- Polaris 用户：业务主体，主键是 `userId`。
- Clerk 用户：登录主体，提供登录态和基础身份。
- 用户资料：Polaris 用户的资料与画像。
- 用户凭证：Polaris 用户拥有的可复用凭证。
- Clerk 映射：Clerk 用户与 Polaris 用户之间的稳定绑定。

## 文件落点

- 用户资料：`config/users/profiles/<userId>.yaml`
- 用户凭证：`config/users/<userId>/credentials/*.yaml`
- 用户工作空间：
  `config/users/<userId>/workspaces/<workspace>/`
- 用户映射：`config/users/user-map.json`

## 当前模型

### 用户资料

用户资料是 Polaris 的一等对象。

当前承载：

- 用户 ID
- name
- email
- GitHub 账号信息
- SSH 策略
- agent identity 默认值
- 用户拥有的工作空间列表

用户资料与 Clerk 映射共同定义登录后的用户归属。

其中：

- 用户资料负责 Polaris 侧业务身份
- Clerk 映射负责从认证身份定位到 Polaris 用户

Clerk 映射不内嵌在用户资料字段里。

它独立保存在 `config/users/user-map.json`。

当前映射键包括：

- `clerkUserId`
- `clerkUsername`

当前映射结果字段是：

- `polarisUserId`

### 用户创建

用户创建时只创建用户资料和用户画像要求的必需凭证。

当前用户画像只要求 SSH，因此：

- 会创建 `github-ssh` 这类托管 SSH 凭证
- 会生成 SSH key material
- 不会隐式创建默认 Codex 凭证

### 用户删除

删除用户时会清理该用户的主要控制面状态。

当前范围包括：

- 删除用户资料
- 删除用户级凭证及其物料
- 删除用户工作空间目录
- 删除 Clerk 到 Polaris 的映射

当前不会删除 Clerk 平台上的用户对象。

### 用户级凭证模型

凭证现在是用户级对象。

当前重点包括：

- `ssh-key`
- `codex-auth`
- `claude-auth`
- `copilot-auth`
- `opencode-auth`
- `pi-auth`

当前可按多 harness 管理用户级凭证。

当前典型 harness 包括：

- `ssh`
- `codex`
- `claude`
- `copilot`
- `opencode`
- `pi`

用户可以：

- 新增用户级凭证
- 删除用户级凭证
- 激活一个可激活凭证为当前默认值

当前约束是：

- 同一时间，一个用户只有一个激活中的 Codex 凭证
- 工作空间可以继续声明工作空间级 override

### 用户级多凭证模型

Polaris 已经按用户维度建模凭证，而不是按工作空间维度建模。

当前语义是：

- 一个用户可以拥有多个凭证
- 一个凭证可以声明多个用途
- 工作空间可以按 purpose 绑定某个用户凭证
- 用户级激活凭证可以作为工作空间默认值

### 用户与工作空间的关系

当前所有权边界是：

- 一个工作空间只能属于一个用户
- 一个用户可以拥有多个工作空间
- 同一个 project 名当前不能被多个用户同时拥有

工作空间创建时：

- 必须显式选择 `user_profile`
- 不会顺带创建用户级 Codex 凭证
- 不会把用户管理逻辑塞进工作空间脚手架

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

当前删除用户是控制面能力，不是当前门户主流程。

当前门户没有提供删除用户按钮。

当前删除行为如果执行，范围包括：

1. 删除 Polaris 用户资料。
2. 删除该用户的托管凭证与物料。
3. 删除该用户的工作空间目录。
4. 删除 Clerk 到 Polaris 的本地映射。

当前不会删除 Clerk 平台上的用户对象。

### 4. 新增用户级凭证

1. 用户进入 `Profile` 页。
2. 前端展示当前可用的凭证模板。
3. 用户输入该模板要求的凭证信息。
4. 前端调用 `POST /api/users/<userId>/credentials`。
5. 后端通过共享 credential service 创建对应的用户级凭证。
6. 后端写入 registry YAML 和该凭证对应的生成物料。
7. 前端刷新凭证列表。

当前会按具体 harness 和 provider 生成对应物料。

例如 Codex 类凭证的典型产物是：

- `config/users/<userId>/credentials/<credentialId>.yaml`
- `config/users/<userId>/credentials/codex/<credentialId>/auth.json`
- `config/users/<userId>/credentials/codex/<credentialId>/config.toml`

### 5. 激活用户级凭证

1. 用户在 `Profile` 页选择一个可激活的用户级凭证。
2. 前端调用
   `POST /api/users/<userId>/credentials/<credentialId>/activate`。
3. 后端更新该用户凭证 registry 中的激活标记。
4. 后续工作空间运行时默认解析该用户当前激活的对应凭证。

激活行为是用户级选择，不是工作空间基础设施开关。

当前激活语义会随凭证类型与 harness 能力生效。

### 6. 删除用户级凭证

1. 用户在 `Profile` 页删除一个用户级凭证。
2. 前端调用
   `DELETE /api/users/<userId>/credentials/<credentialId>`。
3. 后端通过共享 credential service 删除 registry 与生成物料。
4. 前端刷新列表。

## 页面职责

### 登录 / 注册页

- 负责 Clerk 会话建立
- 负责触发 Polaris 用户创建或查找映射

### Profile 页

- 负责展示用户资料
- 负责管理用户级凭证
- 负责新增、删除、激活用户级凭证

## 边界

- Clerk 不管理 Polaris 工作空间。
- Polaris 不管理用户密码。
- 用户级凭证不应再通过工作空间脚手架隐式创建。
- 工作空间级绑定只是覆盖路径，不是主要凭证管理入口。

## CLI 设计

当前用户管理已经有明确的 CLI 命令面。

根入口是：

```bash
pnpm --dir apps/polaris run polaris -- user ...
```

### 用户创建

```bash
pnpm --dir apps/polaris run polaris -- user create <userProfileId> \
  [--name <name>] \
  [--email <email>] \
  [--clerk <username>] \
  [--clerk-user-id <id>] \
  [--role <admin|user>] \
  [--plan <free|pro>]
```

当前语义是：

- 创建用户资料
- 创建画像要求的默认凭证
- 可同时写入 `clerkUsername` 映射
- 可同时写入 `clerkUserId` 映射
- 可同时声明 `role` 和 `plan`

### 用户删除

```bash
pnpm --dir apps/polaris run polaris -- user delete <userProfileId>
```

当前语义是：

- 删除用户资料
- 删除用户根目录
- 删除该用户全部托管凭证
- 删除该用户对应的 Clerk 映射
- 不删除 Clerk 平台上的用户对象

### 用户级凭证新增

```bash
pnpm --dir apps/polaris run polaris -- user credential add <userProfileId> \
  --harness <ssh|codex|claude|copilot|opencode|pi> \
  [--credential-id <id>] \
  [--label <label>] \
  [--provider-name <name>] \
  [--base-url <url>] \
  [--api-key <key>] \
  [--preset-id <id>] \
  [--model <name>] \
  [--activate]
```

当前也保留同义入口：

```bash
pnpm --dir apps/polaris run polaris -- user credential create ...
```

当前语义是：

- 按 harness 创建用户级凭证
- 支持 provider preset 和自定义 provider 参数
- 可在创建时直接激活

### 用户级凭证列表

```bash
pnpm --dir apps/polaris run polaris -- user credential list <userProfileId>
```

当前语义是：

- 列出该用户全部托管凭证
- 返回 registry 视图而不是工作空间绑定视图

### 用户级凭证激活

```bash
pnpm --dir apps/polaris run polaris -- user credential activate <userProfileId> <credentialId>
```

当前语义是：

- 在用户作用域激活目标凭证
- 后续工作空间默认解析该用户当前激活的对应凭证

### 用户级凭证删除

```bash
pnpm --dir apps/polaris run polaris -- user credential delete <userProfileId> <credentialId>
```

当前语义是：

- 删除凭证 registry 条目
- 删除该凭证生成物料

### 设计约束

- `user` 命令面负责用户资料和用户级凭证。
- 工作空间级 override 不放在 `user credential activate` 内表达。
- 运行时 live switch 属于工作空间命令面，不属于用户管理命令面。
- Clerk 映射通过 `user create` 进入，不内嵌在用户资料 YAML 中。
