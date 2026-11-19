# Polaris 工作流观察台

[English](README.md)

本版按 Apache 2.0 许可证从 [Polaris](https://github.com/55aaseclab/Polaris) 原生门户整理，保留原生工作台、运行卡片、时间线和工作流图，按工作区只读浏览。浏览现有记录无需运行执行器。

使用 Node 22.16 或更高版本，执行 `npm ci`、`npm run build`、`npm test` 和 `npm start`，打开本机 8787 端口。未配置数据时显示空工作台。需接入现有记录时，把原生运行和工作流投影写入源码目录外的 0600 私有 JSON 文件，将 `POLARIS_OBSERVATIONS_FILE` 指向该文件、`PRAXIS_WORKSPACE_ID` 设置为文件的工作区标识。接口逐次核对。组织部署通过 Praxis 原生登录网关访问。
