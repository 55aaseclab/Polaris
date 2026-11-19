# Polaris 工作流观察台

[English](README.md)

[Polaris](https://github.com/55aaseclab/polaris) 本版采用 Apache 2.0 许可证，保留原生工作台、运行卡片、时间线和工作流图，按工作区只读浏览。浏览现有记录无需运行执行器。

使用 Node 22.16 或更高版本，执行 `npm ci`、`npm run build`、`npm test` 和 `npm start`，打开本机 8787 端口。未配置数据时显示空工作台。需接入现有记录时，把原生运行和工作流投影写入源码目录外的 0600 私有 JSON 文件，将 `POLARIS_OBSERVATIONS_FILE` 指向该文件、`PRAXIS_WORKSPACE_ID` 设置为文件的工作区标识。接口逐次核对。组织部署通过 Praxis 原生登录网关访问。

应用自有的 `praxis-provider.mjs` 向 Praxis Settings 提供运行观察数据的位置清单。Polaris 作为 runtime，不向工作台发布卡片。


内部只读 `GET /api/praxis/traces` 与 provider `getTraces` 只提供经批准观察的元数据，包括运行与流程标识、已记录状态和时间、已有版本、有限分段元数据及不透明产物引用。不返回命令、原始日志、错误正文、输入输出或凭据。分页保留失败运行。本来源只证明运行观察，不补造历史 MCP 调用、提交或回读。
