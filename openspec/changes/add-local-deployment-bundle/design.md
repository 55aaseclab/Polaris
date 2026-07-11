## Context

Polaris 当前已经有本地开发运行链路，但这条链路面向的是仓库开发者，
不是本地部署用户。现有本地运行依赖源码 checkout、`pnpm install`、
开发态脚本、`tsx watch`、`vite` dev server，以及多进程开发服务协
同。这能支持开发迭代，但不能作为面向非技术用户的本地安装和运行体
验。

这次变更只定义阶段一本地安装包能力。阶段一强调四点：

- 支持 Linux、Windows、macOS 的单机本地部署
- 统一使用 Docker-only 运行底座
- 同时提供安装后的 GUI 和 CLI 两个入口，但不引入常驻本地控制服务
- 通过 release artifact 交付，而不是把内部控制层直接暴露成产品入口

本地部署与本地开发需要明确分开。开发态链路继续保留给仓库开发者，本
地部署则引入独立的发行链路、固定产物和固定控制动作。

## Goals / Non-Goals

**Goals:**

- 定义一个独立于本地开发的本地安装包与发布流程
- 让安装后的 GUI 与 CLI 共用同一套本地控制动作和运行模型
- 把用户可见操作压缩为安装、启动、停止、状态检查、打开、日志、升
  级、诊断和卸载
- 把阶段一本地后端约束为 `docker`
- 把运行复杂度收敛到固定产物、固定镜像、固定数据目录和固定端口配置
- 把交付物收敛到 Debian `.deb`、Windows `.exe` 和可扩展的 macOS
  打包流程

**Non-Goals:**

- 不在阶段一支持 `pod` 或 `kubevirt-vm`
- 不复用本地开发态 `vite` dev server 或 `tsx watch`
- 不引入 host nginx、blue/green、systemd 或远程部署能力
- 不引入本地常驻 installer daemon、tray app 或后台控制服务
- 不要求关闭 GUI 后保留额外的本地控制进程

## Decisions

### 1. 本地部署与本地开发分成两条链路

阶段一本地部署不从现有 local dev stack 演化，而是新增独立链路。

原因：

- 开发链路的目标是代码迭代
- 部署链路的目标是稳定使用
- 把两者混在一起会把开发依赖暴露给非技术用户

备选方案：

- 直接包装现有 `run-polaris-local-stack-service.sh`
  - 未采用，因为它仍然依赖开发态服务与源码工作流

### 2. 阶段一本地运行只支持 Docker-only

本地发行版统一建立在 Docker 之上，不在阶段一暴露 `pod`、
`kubevirt-vm` 或 Linux 专属高级隔离模式。

原因：

- Linux、Windows、macOS 三端最容易统一的是 Docker
- `pod` 和 `kubevirt-vm` 明显更偏 Linux 基础设施
- 先把“能安装、能启动、能稳定使用”跑通，比先追求全部后端更重要

备选方案：

- 三端同时支持全部后端
  - 未采用，因为安装复杂度、依赖检查和排障成本都会显著上升

### 3. GUI 和 CLI 双入口共用同一控制底座

安装后的 GUI 和 CLI 不做两套独立逻辑。GUI 和 CLI 都调用同一组一次
性控制动作。

控制动作范围：

- `install`
- `start`
- `stop`
- `restart`
- `status`
- `open`
- `logs`
- `doctor`
- `upgrade`
- `uninstall`

原因：

- 保证两种入口行为一致
- 降低测试和排障成本
- 方便先做 CLI，再逐步接上 GUI，或先做 GUI，再回补 CLI

备选方案：

- GUI 和 CLI 各自维护一套流程
  - 未采用，因为会很快发生行为漂移

### 4. 本地控制层不做常驻服务

阶段一本地控制动作全部设计为一次性命令。命令执行后退出，不引入本地
常驻控制服务。

原因：

- 非技术用户不需要额外理解后台守护进程
- 跨平台实现更简单
- 进程生命周期更清楚

备选方案：

- 新增本地 installer daemon 或 launcher service
  - 未采用，因为它增加了额外进程管理和排障复杂度

### 5. 本地部署使用固定产物而不是开发服务器

阶段一本地部署必须使用固定构建产物、固定镜像或等价发行材料，而不是
依赖 `vite` dev server、`tsx watch` 或源码热更新。

原因：

- 本地部署需要稳定性和可重复性
- 非技术用户不应承担开发工具链安装成本

备选方案：

- 本地部署直接运行开发服务器
  - 未采用，因为这仍然是开发运行，不是本地部署

### 6. 本地数据目录按系统约定放置

阶段一需要为用户隐藏 `POLARIS_DATA_ROOT` 细节，但内部仍应保持明确、
可迁移的数据根目录。

建议目录：

- Linux: `~/.local/share/polaris`
- macOS: `~/Library/Application Support/Polaris`
- Windows: `%LOCALAPPDATA%\\Polaris`

原因：

- 避免把 repo 内路径暴露成用户心智
- 方便安装、升级、卸载和诊断

### 7. 安装包和 release artifact 是主入口

阶段一对用户交付的不是 `pnpm run polaris:local-deploy ...` 这种仓库命
令，而是安装包和 release artifact。

最少交付物：

- Debian `.deb`
- Windows `.exe`

可扩展交付物：

- macOS 原生包或等价发布物

原因：

- 非技术用户不会把内部控制层当成产品入口
- 用户心智应该是“下载安装后启动”，不是“拿到仓库后执行命令”
- 内部控制层仍然重要，但它应该服务安装包，而不是取代安装包

备选方案：

- 直接把内部 CLI 和薄 GUI 当作最终产品入口
  - 未采用，因为它把实现层暴露成了产品层

## Risks / Trade-offs

- [Docker 仍然是前置依赖] → 安装器和 CLI 都需要先做 Docker 预检，并
  给出面向普通用户的错误提示
- [Windows/macOS 与 Linux 网络模型不一致] → 阶段一本地部署不得依赖
  host network 或 `docker0` 这类 Linux 宿主机假设
- [GUI 与 CLI 同时定义会放大范围] → 先统一动作和底座，再逐步接入口，
  不把两套界面逻辑混进底层实现
- [本地部署与本地开发并存会带来文档混淆] → 文档必须显式拆成 local
  development 与 local deployment 两个章节
- [阶段一只支持 docker 会降低高级隔离能力] → 在 proposal 和 docs 中
  明确这是阶段性范围，不把高级后端承诺进本地发行版首发
- [安装包与内部控制层会出现双层结构] → 用共享控制动作收住行为差异，
  让安装包只负责交付和安装后入口

## Migration Plan

1. 先在文档和 OpenSpec 中确立阶段一本地部署范围与非目标
2. 定义统一的本地控制动作和本地数据目录约定
3. 准备固定产物和 Docker-only 本地编排材料
4. 在同一底座上分别接入 CLI 和 GUI 入口
5. 明确现有开发脚本继续服务本地开发，不重命名为本地部署入口

回滚策略：

- 如果阶段一本地发行链路未完成，现有本地开发链路保持不变
- 本地部署入口可以独立回退，不影响仓库开发者继续使用当前 local
  stack

## Open Questions

- GUI 第一阶段是薄启动器，还是完整安装器加启动器合一
- `open` 动作是只打开浏览器，还是还要在未运行时自动触发 `start`
- 升级策略是重新拉取镜像后原地重启，还是保留版本选择
- 本地部署是否需要第一阶段就接入首次初始化向导，而不是纯文件配置
