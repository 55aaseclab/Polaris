import {
  listPortalDomainPacks,
  listPortalWorkflowVaults,
} from "../../portal/service.js";
import {
  getPolarisControlStore,
} from "../../portal/control-store.js";
import {
  WorkflowControlService,
} from "../../portal/workflow-control.js";
import {
  WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
} from "../../portal/workflow-live-boundary.js";

type AdmitLiveMetadataOptions = {
  tenantId?: string;
  vaultId?: string;
  packId?: string;
  flowId?: string;
  operatorId?: string;
  releaseId?: string;
  values: Record<string, string>;
  candidateLiveEnabled: boolean;
  wait: boolean;
  json: boolean;
  dedupeKey?: string;
};

export type WorkflowAdmitLiveMetadataSummary = {
  mode: "live";
  action: typeof WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID;
  admitted: true;
  tenantId: string;
  vaultId: string;
  packId: string;
  flowId: string;
  runId: string;
  status: string;
  receipts: number;
  artifacts: number;
  auditEvents: number;
};

function usage(): never {
  throw new Error(
    "Usage: pnpm --dir apps/polaris run polaris -- ops workflow-admit-live-metadata --tenant <userId> --vault <vault> --pack <packId> --flow <flowId> --operator <operatorId> --candidate-live-enabled [--value key=value ...] [--release-id <id>] [--dedupe-key <key>] [--wait] [--json]",
  );
}

function parseKeyValue(raw: string): [string, string] {
  const at = raw.indexOf("=");
  const key = (at >= 0 ? raw.slice(0, at) : raw).trim();
  if (!key) usage();
  return [key, at >= 0 ? raw.slice(at + 1) : ""];
}

function parseArgs(argv: string[]): AdmitLiveMetadataOptions {
  const options: AdmitLiveMetadataOptions = {
    values: {},
    candidateLiveEnabled: false,
    wait: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") {
      options.json = true;
      continue;
    }
    if (value === "--wait") {
      options.wait = true;
      continue;
    }
    if (value === "--candidate-live-enabled") {
      options.candidateLiveEnabled = true;
      continue;
    }
    if (value === "--tenant" || value === "--user") {
      const tenantId = argv[index + 1]?.trim();
      if (!tenantId) usage();
      options.tenantId = tenantId;
      index += 1;
      continue;
    }
    if (value === "--vault") {
      const vaultId = argv[index + 1]?.trim();
      if (!vaultId) usage();
      options.vaultId = vaultId;
      index += 1;
      continue;
    }
    if (value === "--pack") {
      const packId = argv[index + 1]?.trim();
      if (!packId) usage();
      options.packId = packId;
      index += 1;
      continue;
    }
    if (value === "--flow") {
      const flowId = argv[index + 1]?.trim();
      if (!flowId) usage();
      options.flowId = flowId;
      index += 1;
      continue;
    }
    if (value === "--operator") {
      const operatorId = argv[index + 1]?.trim();
      if (!operatorId) usage();
      options.operatorId = operatorId;
      index += 1;
      continue;
    }
    if (value === "--release-id") {
      const releaseId = argv[index + 1]?.trim();
      if (!releaseId) usage();
      options.releaseId = releaseId;
      index += 1;
      continue;
    }
    if (value === "--dedupe-key") {
      const dedupeKey = argv[index + 1]?.trim();
      if (!dedupeKey) usage();
      options.dedupeKey = dedupeKey;
      index += 1;
      continue;
    }
    if (value === "--value") {
      const raw = argv[index + 1];
      if (raw === undefined) usage();
      const [key, fieldValue] = parseKeyValue(raw);
      options.values[key] = fieldValue;
      index += 1;
      continue;
    }
    usage();
  }
  if (
    !options.tenantId
    || !options.vaultId
    || !options.packId
    || !options.flowId
    || !options.operatorId
    || !options.candidateLiveEnabled
  ) {
    usage();
  }
  return options;
}

async function waitForTerminalRun(
  service: WorkflowControlService,
  tenantId: string,
  runId: string,
): Promise<Awaited<ReturnType<WorkflowControlService["getRun"]>>> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const run = await service.getRun(tenantId, runId);
    if (["succeeded", "failed", "cancelled", "waiting"].includes(run.status)) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return service.getRun(tenantId, runId);
}

export async function runWorkflowAdmitLiveMetadata(
  options: AdmitLiveMetadataOptions,
): Promise<WorkflowAdmitLiveMetadataSummary> {
  const tenantId = options.tenantId?.trim() ?? "";
  const releaseId = options.releaseId?.trim()
    || process.env.POLARIS_RELEASE_ID?.trim()
    || "local-admission";
  const service = new WorkflowControlService({
    importMetaUrl: import.meta.url,
    listPacks: listPortalDomainPacks,
    listVaults: listPortalWorkflowVaults,
    autoStart: true,
  });
  try {
    const admitted = await service.admitLiveMetadataRun(tenantId, {
      operatorId: options.operatorId ?? "",
      vaultId: options.vaultId ?? "",
      packId: options.packId ?? "",
      flowId: options.flowId ?? "",
      values: options.values,
      candidateLiveEnabled: options.candidateLiveEnabled,
      releaseId,
      dedupeKey: options.dedupeKey,
    });
    const run = options.wait
      ? await waitForTerminalRun(service, tenantId, admitted.id)
      : admitted;
    const store = getPolarisControlStore(import.meta.url);
    const auditEvents = store.listAuditEvents().filter((event) =>
      event.tenantId === tenantId
      && event.vaultId === run.vaultId
      && (
        event.requestId === run.id
        || run.receipts.some((receipt) => receipt.requestId === event.requestId)
      )
    );
    return {
      mode: "live",
      action: WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
      admitted: true,
      tenantId,
      vaultId: run.vaultId,
      packId: run.packId,
      flowId: run.flowId,
      runId: run.id,
      status: run.status,
      receipts: run.receipts.length,
      artifacts: run.artifacts.length,
      auditEvents: auditEvents.length,
    };
  } finally {
    service.close();
  }
}

export async function workflowAdmitLiveMetadataCommand(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const summary = await runWorkflowAdmitLiveMetadata(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `workflow-admit-live-metadata action=${summary.action}`,
      `tenant=${summary.tenantId}`,
      `vault=${summary.vaultId}`,
      `pack=${summary.packId}`,
      `flow=${summary.flowId}`,
      `run=${summary.runId}`,
      `status=${summary.status}`,
      `receipts=${summary.receipts}`,
      `artifacts=${summary.artifacts}`,
    ].join(" "),
  );
  process.stdout.write("\n");
}
