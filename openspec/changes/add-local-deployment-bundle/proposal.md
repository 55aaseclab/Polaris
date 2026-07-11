## Why

Polaris 现在有开发态本地运行链路，但还没有面向非技术用户的本地安
装与启动链路。用户如果要在 Linux、Windows、macOS 上本地使用
Polaris，当前仍然要理解源码仓库、开发脚本、环境变量和多进程开发服
务，这和产品化交付目标不匹配。

现在需要先补一条独立于本地开发的本地安装与发布路径，把 Polaris 变成
可构建、可打包、可发布、可安装的 Docker-only 本地发行版，并把复杂度
收敛到安装后的 GUI 和 CLI 两个入口背后。

## What Changes

- 新增 Polaris 本地安装包阶段一能力定义，覆盖 Linux、Windows、
  macOS 的 Docker-only 单机部署。
- 新增统一的本地控制动作范围，包括安装、启动、停止、状态检查、打
  开、日志、升级、诊断和卸载。
- 新增安装后 GUI 与 CLI 双入口要求，两者共用同一套内部本地控制层，
  不分别维护不同运行逻辑。
- 新增 release artifact 目标，至少覆盖 Debian `.deb` 和 Windows
  `.exe` 构建输出，并允许同一套发布流程扩展到 macOS。
- 明确本地部署与本地开发是两条不同链路，本地部署不依赖开发态的
  `vite` dev server、`tsx watch` 或源码工作流。
- 明确阶段一非目标，不覆盖 `pod`、`kubevirt-vm`、host nginx、blue/
  green、systemd 或本地常驻控制服务。

## Capabilities

### New Capabilities
- `local-deployment-bundle`: 定义 Polaris 阶段一本地发行版的安装包、
  release artifact、安装后启动、升级、诊断和卸载体验，以及 GUI/CLI
  双入口与共享底座约束。

### Modified Capabilities
- `workspace-portal`: 门户需要明确区分本地开发运行与本地部署运行，并允
  许本地部署通过固定产物而不是开发服务器提供访问入口。

## Impact

- `apps/docs` 中的 Polaris 本地部署与本地开发文档结构
- `apps/polaris` 与 `apps/polaris-web` 的本地产物和运行入口定义
- 本地 Docker Compose 或等价本地编排产物
- 安装包、发布产物和 GitHub release 构建流程
- 安装后 GUI、CLI 和内部控制层的后续实现范围
- 本地数据目录、端口占用、Docker 预检和错误提示策略
