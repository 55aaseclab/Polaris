# Polaris 门户业务流程

本文档描述 Polaris 门户的主要业务链路。

目标是统一前端、后端、认证和工作空间编排的职责边界。

## 一句话原则

- Clerk 负责认证。
- Polaris 负责用户资料、凭证、工作空间和运行时状态。
- 前端负责发起动作、展示进度、展示结果。
- 后端负责校验权限、落盘状态、执行编排。

## 核心对象

- 用户：门户中的业务主体，使用 `userId` 作为 Polaris 内部标识。
- Clerk 用户：认证主体，提供登录态和基础身份信息。
- 工作空间：用户拥有的开发运行环境。
- 凭证：用户级对象，供工作空间按用途绑定。
- 驱动：工作空间运行目标，当前包括 `docker`、`pod:gvisor`、
  `pod:data-container`、`kubevirt-vm`。

## 权责分工

### 认证与授权

- 前端通过 Clerk 完成登录、登出、注册。
- 后端不直接管理密码。
- 后端根据登录后的用户身份，将 Clerk 用户映射到 Polaris 用户。
- 普通用户只能访问自己的
  `/users/<userId>/workspaces/...` 路由。
- 管理员可以访问其他用户路由。

### 数据与状态

- 用户归属以 `config/users/<userId>/projects/<workspace>/` 为准。
- 用户资料以 `config/users/profiles/<userId>.yaml` 为准。
- 用户凭证以 `config/users/<userId>/credentials/*.yaml` 为准。
- 工作空间状态、驱动选择、编排进度由 Polaris 写入并维护。

## 主业务流程

### 1. 前端登录

前端登录 := Clerk 登录 -> 前端拿到会话 -> 前端解析当前用户映射 ->
前端跳转到该用户工作空间首页

细化流程：

1. 用户进入登录页。
2. 前端调用 Clerk 登录。
3. Clerk 返回已认证会话。
4. 前端根据 Clerk 用户名或映射表识别 Polaris `userId`。
5. 前端跳转到 `/users/<userId>/workspaces`。
6. 前端请求用户工作空间列表。
7. 后端校验访问范围并返回工作空间摘要。
8. 前端展示工作空间首页。

异常分支：

- 没有 Polaris 用户映射：前端提示未完成用户绑定。
- 用户访问了其他普通用户的路由：后端返回 `403`。
- 用户资料不存在：后端返回 `404`。

### 2. 前端注册

前端注册 := Clerk 注册 -> 后端创建 Polaris 用户 -> 前端自动登录 ->
前端进入工作空间首页

细化流程：

1. 用户在前端完成 Clerk 注册。
2. 前端拿到 Clerk 用户名、邮箱和基础资料。
3. 前端调用后端创建 Polaris 用户。
4. 后端创建用户资料和默认凭证目录。
5. 后端返回新建用户资料。
6. 前端使用 Clerk 会话进入已登录状态。
7. 前端跳转到 `/users/<userId>/workspaces`。
8. 前端显示空工作空间页或已有工作空间页。

后端创建内容：

- 用户资料。
- 默认凭证注册目录。
- 用户角色和套餐信息。
- Clerk 用户名到 Polaris 用户的稳定映射关系。

异常分支：

- Clerk 注册成功但 Polaris 用户创建失败：前端提示注册未完成。
- 用户名冲突：后端拒绝创建并返回错误原因。

### 3. 删除用户

删除用户 := 前端发起删除用户 -> 后端执行本地 Polaris 删除 ->
webportal 清理对应 Clerk 用户 -> 前端退出登录或返回列表页

细化流程：

1. 用户进入 `Settings` 页，或管理员进入用户管理页。
2. 前端发起删除用户动作并要求二次确认。
3. 前端调用后端删除用户接口。
4. 后端校验目标用户是否存在。
5. 后端先执行本地 `user delete`。
6. 本地删除会移除用户资料、用户目录和 Clerk 到 Polaris 的映射。
7. 本地删除返回被移除的 `removedClerkUsernames`。
8. webportal 使用这些用户名调用 Clerk Backend API 删除 Clerk 用户。
9. 删除成功后，前端对“删自己”执行登出并回到登录页。
10. 管理员删除其他用户时，前端返回用户列表或管理页。

删除范围：

- 用户资料。
- 用户工作空间目录。
- 用户凭证目录。
- 用户状态目录。
- 用户映射关系。
- 对应的 Clerk 用户记录。

异常分支：

- 用户不存在：后端返回 `404`。
- 本地 Polaris 删除失败：后端返回删除失败。
- 本地删除成功但 Clerk 删除失败：后端返回错误，前端提示 Clerk 清理失败。

### 4. 用户进入工作空间首页

进入首页 := 前端请求工作空间列表 -> 后端返回用户拥有的工作空间 ->
前端展示列表、状态和入口

细化流程：

1. 前端请求 `/api/users/<userId>/workspaces`。
2. 后端读取该用户名下的工作空间目录。
3. 后端汇总每个工作空间的驱动、状态、进度和 live target。
4. 前端展示工作空间卡片或侧边栏列表。

首页展示重点：

- 工作空间名称。
- 已配置驱动。
- 当前选中驱动。
- 当前状态。
- 编排进度。
- 进入运行时的链接。

### 5. 用户创建工作空间

用户创建工作空间 := 前端点击创建工作空间 -> 后端阻塞式创建并编排
工作空间 -> 前端显示工作空间

细化流程：

1. 用户输入工作空间名称。
2. 前端调用 `POST /api/users/<userId>/workspaces`。
3. 后端校验用户和工作空间名称。
4. 后端在用户目录下创建工作空间目录。
5. 后端确保驱动规格存在。
6. 后端确保工作空间镜像存在。
7. 后端渲染各驱动的后端清单。
8. 后端收集状态并写入默认驱动选择。
9. 后端返回编排进度结果。
10. 前端刷新列表并打开该工作空间详情。

当前创建完成标准：

- 工作空间目录已创建。
- `docker`、`pod:gvisor`、`kubevirt-vm` 规格已就绪。
- 对应 manifest 已生成。
- 默认驱动选择已写入状态。
- 进度状态已标记完成。

异常分支：

- 镜像不可用：后端返回创建失败。
- manifest 渲染失败：后端返回创建失败。
- 编排中断：后端写入 `error` 进度，前端展示失败状态。

### 6. 用户查看工作空间详情

查看工作空间 := 前端打开工作空间 -> 后端返回工作空间详情 ->
前端展示运行时、资产、凭证绑定和控制项

细化流程：

1. 前端请求
   `/api/users/<userId>/workspaces/<workspaceName>`。
2. 后端返回工作空间详情。
3. 前端展示概览页或默认嵌入的 Paseo 页面。
4. 前端展示驱动状态、daemon 状态、live target。
5. 前端展示规格文件、生成物、镜像标签、持久卷和 memory 资产。
6. 前端展示该工作空间绑定的凭证用途。

### 7. 用户切换工作空间驱动

切换驱动 := 前端选择目标驱动 -> 后端切换工作空间驱动 ->
前端刷新详情页

细化流程：

1. 用户在控制区选择目标驱动。
2. 前端调用
   `POST /api/users/<userId>/workspaces/<workspaceName>/switch`。
3. 后端校验目标驱动是否合法且可用。
4. 后端执行驱动切换。
5. 后端更新工作空间选中驱动状态。
6. 前端刷新页面并展示新驱动状态。

异常分支：

- 目标驱动未准备好：后端拒绝切换。
- 切换过程失败：前端保留原状态并提示失败。

### 8. 用户停止工作空间

停止工作空间 := 前端点击停止 -> 后端停止当前选中驱动 ->
前端刷新状态

细化流程：

1. 用户点击停止工作空间。
2. 前端调用
   `POST /api/users/<userId>/workspaces/<workspaceName>/stop`。
3. 后端读取当前选中驱动。
4. 后端停止对应运行时。
5. 前端刷新详情，展示已停止或未启动状态。

### 9. 用户删除工作空间

删除工作空间 := 前端点击删除 -> 后端校验工作空间未运行 ->
后端删除工作空间定义和状态 -> 前端返回列表页

细化流程：

1. 用户点击删除并二次确认。
2. 前端调用
   `DELETE /api/users/<userId>/workspaces/<workspaceName>`。
3. 后端校验工作空间当前未运行。
4. 后端删除工作空间目录和关联状态。
5. 后端更新用户派生索引。
6. 前端跳转回工作空间列表。

约束：

- 运行中的工作空间不能直接删除。

### 10. 用户新增 Credential

新增 Credential := 前端进入 Profile 页 -> 前端填写 codex credential 表单 ->
后端调用 CLI 创建 credential -> 前端刷新 credential 列表

细化流程：

1. 用户进入 `Profile` 页。
2. 前端展示当前用户的 credential 列表和新增表单。
3. 用户选择 `codex` 类型。
4. 用户填写 label、provider name、base URL 和 API key。
5. 前端调用 `POST /api/users/<userId>/credentials`。
6. 后端校验目标用户存在且请求参数合法。
7. 后端调用本地
   `pnpm --dir apps/polaris run polaris -- user credential create ...`。
8. CLI 按模板生成 registry YAML。
9. CLI 同时生成 `auth.json` 和 `config.toml`。
10. 后端重新读取该用户 credential 列表并返回新建结果。
11. 前端刷新表格并展示新 credential。

当前 codex 模板输出：

- `config/users/<userId>/credentials/<credentialId>.yaml`
- `config/users/<userId>/credentials/codex/<credentialId>/auth.json`
- `config/users/<userId>/credentials/codex/<credentialId>/config.toml`

异常分支：

- 用户不存在：后端返回 `404` 或创建失败。
- 参数缺失：后端返回 `400`。
- CLI 创建失败：后端返回创建失败原因。
- 文件写入失败：后端返回创建失败原因。

### 11. 用户删除 Credential

删除 Credential := 前端在 Profile 页点击删除 -> 后端调用 CLI 删除
credential -> 前端刷新 credential 列表

细化流程：

1. 用户在 `Profile` 页查看 credential 列表。
2. 用户对某个 credential 点击删除并二次确认。
3. 前端调用
   `DELETE /api/users/<userId>/credentials/<credentialId>`。
4. 后端校验目标用户和 credential 是否存在。
5. 后端调用本地
   `pnpm --dir apps/polaris run polaris -- user credential delete ...`。
6. CLI 删除 credential registry YAML。
7. CLI 删除该 credential 对应的 `auth.json` 和 `config.toml`。
8. 后端返回删除结果和已删除文件路径。
9. 前端刷新表格并移除该 credential。

删除范围：

- credential registry 文件。
- credential 生成出的 `codex` 配置文件。

异常分支：

- credential 不存在：后端返回删除失败或空删除结果。
- 文件部分缺失：后端尽力删除剩余文件并返回结果。
- CLI 删除失败：后端返回删除失败原因。

## 页面级业务视图

### 登录页

- 目标是建立会话。
- 成功后进入用户首页。

### 注册页

- 目标是创建 Clerk 身份和 Polaris 用户。
- 成功后直接登录。

### 工作空间列表页

- 目标是查看全部工作空间和创建入口。
- 重点展示状态、进度和入口。

### 工作空间详情页

- 目标是查看单个工作空间运行情况。
- 重点展示 Paseo、开发环境资产、memory 资产和控制动作。

## 状态定义建议

- `queued`：已进入队列，尚未开始。
- `starting`：开始创建工作空间。
- `specs`：正在准备驱动规格。
- `images`：正在准备镜像。
- `manifests`：正在生成 manifest。
- `status`：正在汇总状态。
- `selection`：正在确认默认驱动。
- `done`：创建完成。
- `error`：创建失败。

## 业务边界

- Clerk 不是工作空间系统。
- Polaris 不负责用户密码管理。
- 前端不直接判断工作空间归属。
- 工作空间归属和可见性由后端判定。
- 用户资料、凭证、工作空间是三个独立对象。

## 后续可继续补充的流程

- 邀请成员加入工作空间。
- 管理员跨用户查看和代运维。
- 凭证绑定到工作空间的编辑流程。
- 工作空间模板选择流程。
- 工作空间创建后的首次启动流程。
- 失败重试和恢复流程。
