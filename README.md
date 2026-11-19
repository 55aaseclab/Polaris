# Polaris workflow observer

[简体中文](README.zh-CN.md)

This Apache 2.0 edition of [Polaris](https://github.com/55aaseclab/polaris) provides the native Polaris work desk, run cards, execution timelines and workflow graphs. It reads the chosen workspace’s observations. No executor is needed to view existing observations.

Use Node 22.16 or later. Run `npm ci`, `npm run build`, `npm test` and `npm start`, then open http://127.0.0.1:8787/. The server binds to loopback. With no data configured, the workflow catalog and work desk are empty. Choose the English or Simplified Chinese interface in the portal navigation.

An external workflow system can publish a read-only JSON snapshot outside the source directory. Point `POLARIS_OBSERVATIONS_FILE` to the absolute path of a 0600 file owned by the service account and set `PRAXIS_WORKSPACE_ID` to the same workspace ID. The file is re-read on each request. Use the native types exported by `packages/polaris-shell/src/workflow.ts`: `packs` contains workflow packs, `runs` contains run projections, `graphs` contains graph projections including pack and flow, and `events` maps run IDs to ordered events. The envelope also has a required `workspaceId`. A mismatch or invalid file fails closed. Only intentionally projected content should be included. For a deployed organization, use the authenticated Praxis gateway; the portal labels and assets support the `/apps/polaris/` mount. Source code does not include workflow records, credentials, vaults or executable workflows.

[Product requirements](apps/docs/site/development/prd.md) · [Roadmap](apps/docs/site/development/roadmap.md) · [Apache 2.0 license](LICENSE)

The app-owned `praxis-provider.mjs` describes the runtime observation data location for Praxis Settings. Polaris is the runtime and does not publish workbench cards.
