# Polaris workflow observer

[简体中文](README.zh-CN.md)

This Apache 2.0 edition of [Polaris](https://github.com/55aaseclab/polaris) provides the native Polaris work desk, run cards, execution timelines and workflow graphs. It reads the chosen workspace’s observations. No executor is needed to view existing observations.

Use Node 22.16 or later. Run `npm ci`, `npm run build`, `npm test` and `npm start`, then open http://127.0.0.1:8787/. The server binds to loopback. With no data configured, the workflow catalog and work desk are empty. Choose the English or Simplified Chinese interface in the portal navigation.

An external workflow system can publish a read-only JSON snapshot outside the source directory. Point `POLARIS_OBSERVATIONS_FILE` to the absolute path of a 0600 file owned by the service account and set `PRAXIS_WORKSPACE_ID` to the same workspace ID. The file is re-read on each request. Use the native types exported by `packages/polaris-shell/src/workflow.ts`: `packs` contains workflow packs, `runs` contains run projections, `graphs` contains graph projections including pack and flow, and `events` maps run IDs to ordered events. The envelope also has a required `workspaceId`. A mismatch or invalid file fails closed. Only intentionally projected content should be included. For a deployed organization, use the authenticated Praxis gateway; the portal labels and assets support the `/apps/polaris/` mount. Source code does not include workflow records, credentials, vaults or executable workflows.

[Product requirements](apps/docs/site/development/prd.md) · [Roadmap](apps/docs/site/development/roadmap.md) · [Apache 2.0 license](LICENSE)

The app-owned `praxis-provider.mjs` describes the runtime observation data location for Praxis Settings. Polaris is the runtime and does not publish workbench cards.


The read-only internal `GET /api/praxis/traces` endpoint and provider `getTraces` publish only approved observation metadata: run/flow identifiers, recorded state and times, available versions, bounded step metadata and opaque artifact references. No command, raw log, error body, input/output body or credential is included. Pagination covers existing failed runs too. This source establishes runtime observations, not historical MCP invocation, commit or readback evidence.

## Praxis registration

App release: `0.1.2`. The app owns [`praxis-app.json`](praxis-app.json), its English and Simplified Chinese presentation, the icon at `public/praxis-icon.svg`, the declared PRD locations and any legacy icon aliases. `schemaVersion: 1` identifies the registration format; it is separate from this app release and from data, protocol and document revisions. Package and lockfile release metadata, where present, agree with the declaration.

[`apps.example.json`](apps.example.json) registers a local alias by referencing `./praxis-app.json` and `http://127.0.0.1:8787/`. Start the standalone service described above before using the example; registration does not start a backend or grant account, administrator or business-data access. Installation origins, data locations and access policy remain separately configured.

## App-owned container build

`Dockerfile.praxis` builds this application from its own repository, without a Praxis checkout or an external build context:

```sh
docker build -f Dockerfile.praxis -t praxis-polaris:local .
```

Use the application configuration and persistent data locations documented above when running the image. The Praxis installation consumes the same app-owned build and deployment declaration.

## 应用自有容器构建

`Dockerfile.praxis` 可直接从本应用仓库构建，无需 Praxis 源码或额外构建上下文：

```sh
docker build -f Dockerfile.praxis -t praxis-polaris:local .
```

运行镜像时沿用上文的应用配置与持久数据位置。Praxis 安装流程使用同一份应用自有构建文件与部署声明。
