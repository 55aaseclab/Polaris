import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { addDomainPack, listDomainPackProjections } from "../../config/domain-packs.js";
import { closePolarisControlStore } from "../../portal/control-store.js";
import { WorkflowControlService } from "../../portal/workflow-control.js";
import type {
  WorkflowDomainPackProjection,
  WorkflowVaultProjection,
} from "@polaris/polaris-shell";

const MOCK_PACK_SOURCE = `
domain SmokePack version "1.0.0"
title "Mock workflow smoke pack"
description "Synthetic workflow used to verify mocked FFI and tools."

port ReviewPlan version "1.0.0" {
  builtin manual.review
  in { title: String, instructions: String }
  out { approved: Boolean, reviewId: ID }
  effect human
}

flow Review title "Mock approval" create {
  needs { ReviewPlan }
  input { subject: String required }
  steps {
    review "Review" {
      uses { subject }
      call ReviewPlan
      output { approved: Boolean, reviewId: ID }
    }
  }
  output { approved: Boolean from approved, reviewId: ID from reviewId }
  ui { layout form primary "Review" }
}

flow Summarize title "Mock summary" create {
  input { subject: String required }
  steps {
    summarize "Summarize" {
      uses { subject }
      output { summary: String }
    }
  }
  output { summary: String from summary }
  ui { layout form primary "Summarize" }
}
`;

type SmokeSummary = {
  tenantId: string;
  packId: string;
  packVersion: string;
  packDigest: string;
  vaultId: string;
  runId: string;
  approvalRunId: string;
  summaryRunId: string;
  suggestionId: string;
  receipts: number;
  artifacts: number;
  events: number;
};

function usage(): never {
  throw new Error(
    "Usage: pnpm --dir apps/polaris run polaris -- ops workflow-smoke [--json]",
  );
}

function parseArgs(argv: string[]): { json: boolean } {
  const options = { json: false };
  for (const value of argv) {
    if (value === "--json") {
      options.json = true;
      continue;
    }
    usage();
  }
  return options;
}

function syntheticVault(id: string): WorkflowVaultProjection {
  return {
    id,
    name: id,
    description: "Synthetic executable Vault",
    kind: "existing",
    status: "running",
    canRun: true,
    availabilityReason: null,
    profile: "Synthetic / test",
    capacity: "Synthetic capacity",
    surfaces: [],
    serverId: null,
    wanghaiId: null,
  };
}

function createSmokeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "polaris-workflow-smoke-"));
}

async function installSmokePack(root: string): Promise<WorkflowDomainPackProjection> {
  const sourcePath = path.join(root, "smoke-pack.ord");
  fs.writeFileSync(sourcePath, MOCK_PACK_SOURCE, "utf8");
  const installed = await addDomainPack(import.meta.url, sourcePath);
  const pack = listDomainPackProjections(import.meta.url).find(
    (candidate) => candidate.id === installed.pack.id,
  );
  if (!pack) {
    throw new Error("Smoke pack was not visible after installation");
  }
  return pack;
}

async function runWorkflowSmoke(): Promise<SmokeSummary> {
  const root = createSmokeRoot();
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    POLARIS_DATA_ROOT: process.env.POLARIS_DATA_ROOT,
    POLARIS_CONTROL_STORE_PATH: process.env.POLARIS_CONTROL_STORE_PATH,
  };
  const tenantId = `tenant-${randomUUID().slice(0, 8)}`;
  const vaultId = `vault-${randomUUID().slice(0, 8)}`;

  process.env.NODE_ENV = "test";
  process.env.POLARIS_DATA_ROOT = path.join(root, "data");
  process.env.POLARIS_CONTROL_STORE_PATH = path.join(root, "control.sqlite");
  closePolarisControlStore();

  try {
    const pack = await installSmokePack(root);
    const service = new WorkflowControlService({
      importMetaUrl: import.meta.url,
      listPacks: () => [pack],
      listVaults: async () => [syntheticVault(vaultId)],
      autoStart: false,
      pollMs: 50,
    });
    try {
      await service.saveSetup(tenantId, {
        completed: true,
        domainPackId: pack.id,
        vaultId,
        enabledWorkflowKeys: [`${pack.id}:Review`, `${pack.id}:Summarize`],
        completedAt: null,
      });

      const afterSetup = await service.listRuns(tenantId);
      const review = afterSetup.runs.find((run) => run.flowId === "Review");
      const summary = afterSetup.runs.find((run) => run.flowId === "Summarize");
      if (!review || !summary) {
        throw new Error("Smoke setup did not enqueue both flows");
      }
      if (review.status !== "waiting") {
        throw new Error(`Approval flow did not pause for approval: ${review.status}`);
      }
      if (review.receipts.length !== 1 || review.receipts[0]?.status !== "waiting") {
        throw new Error("Approval flow did not record a waiting receipt");
      }
      if (summary.status !== "succeeded" || summary.artifacts.length !== 1) {
        throw new Error("Non-approval flow did not complete with an artifact");
      }

      const approved = await service.approve(tenantId, review.id);
      if (approved.status !== "running") {
        throw new Error("Approval did not resume the run");
      }
      await service.listRuns(tenantId);

      const completed = await service.getRun(tenantId, review.id);
      if (completed.status !== "succeeded") {
        throw new Error(`Approved flow did not complete: ${completed.status}`);
      }
      if (completed.receipts.length !== 1 || completed.artifacts.length !== 1) {
        throw new Error("Approved flow did not persist exactly one receipt and one artifact");
      }
      if (completed.events.every((event) => event.kind !== "approved")) {
        throw new Error("Approved flow did not record approval evidence");
      }

      const suggestion = await service.createSuggestion(tenantId, completed.id);
      const events = await service.events(tenantId, completed.id, 0);
      return {
        tenantId,
        packId: pack.id,
        packVersion: pack.version,
        packDigest: pack.digest,
        vaultId,
        runId: completed.id,
        approvalRunId: review.id,
        summaryRunId: summary.id,
        suggestionId: suggestion.id,
        receipts: completed.receipts.length,
        artifacts: completed.artifacts.length,
        events: events.events.length,
      };
    } finally {
      service.close();
    }
  } finally {
    closePolarisControlStore();
    fs.rmSync(root, { recursive: true, force: true });
    if (previousEnv.NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousEnv.NODE_ENV;
    }
    if (previousEnv.POLARIS_DATA_ROOT === undefined) {
      delete process.env.POLARIS_DATA_ROOT;
    } else {
      process.env.POLARIS_DATA_ROOT = previousEnv.POLARIS_DATA_ROOT;
    }
    if (previousEnv.POLARIS_CONTROL_STORE_PATH === undefined) {
      delete process.env.POLARIS_CONTROL_STORE_PATH;
    } else {
      process.env.POLARIS_CONTROL_STORE_PATH = previousEnv.POLARIS_CONTROL_STORE_PATH;
    }
  }
}

export async function workflowSmokeCommand(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const summary = await runWorkflowSmoke();
  const payload = {
    mode: "mock",
    ffi: "mocked",
    tools: "mocked",
    ...summary,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `workflow-smoke mode=${payload.mode}`,
      `tenant=${payload.tenantId}`,
      `pack=${payload.packId}@${payload.packVersion}`,
      `vault=${payload.vaultId}`,
      `run=${payload.runId}`,
      `approval-run=${payload.approvalRunId}`,
      `summary-run=${payload.summaryRunId}`,
      `suggestion=${payload.suggestionId}`,
      `receipts=${payload.receipts}`,
      `artifacts=${payload.artifacts}`,
      `events=${payload.events}`,
    ].join(" "),
  );
  process.stdout.write("\n");
}
