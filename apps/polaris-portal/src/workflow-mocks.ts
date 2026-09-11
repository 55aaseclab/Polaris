import type {
  WorkflowArtifact,
  WorkflowDomainPackProjection,
  WorkflowEvent,
  WorkflowEventTone,
  WorkflowFlowProjection,
  WorkflowPriority as ShellWorkflowPriority,
  WorkflowRunProjection,
  WorkflowStatus as ShellWorkflowStatus,
  WorkflowVaultProjection,
  WorkflowWorkCard,
} from "@polaris/polaris-shell";

export type WorkflowStatus =
  ShellWorkflowStatus;

export type WorkflowPriority = ShellWorkflowPriority;

export type WorkflowField = WorkflowFlowProjection["fields"][number];

export type MockWorkflowFlow = WorkflowFlowProjection;

export type MockDomainPack = WorkflowDomainPackProjection;

export type MockWorkflowVault = WorkflowVaultProjection;

export type { WorkflowEventTone };

export type MockWorkflowEvent = WorkflowEvent;

export type MockWorkflowArtifact = WorkflowArtifact;

export type MockWorkflowRun = WorkflowRunProjection;

export type MockWorkCard = WorkflowWorkCard;

export type WorkflowSetup = {
  completed: boolean;
  domainPackId: string | null;
  vaultId: string | null;
  enabledWorkflowKeys: string[];
  completedAt: string | null;
};

export type WorkflowMockState = {
  packs: MockDomainPack[];
  vaults: MockWorkflowVault[];
  runs: Record<string, MockWorkflowRun>;
  cards: MockWorkCard[];
  replayCursor: number;
  setup: WorkflowSetup;
};

export function workflowKey(packId: string, flowId: string): string {
  return `${packId}:${flowId}`;
}

export function workflowKeysForPack(
  packs: MockDomainPack[],
  domainPackId: string | null,
  keys: string[],
): string[] {
  const pack = domainPackId ? packs.find((candidate) => candidate.id === domainPackId) : null;
  if (!pack) return [];
  const available = new Set(pack.flows.map((flow) => workflowKey(pack.id, flow.id)));
  return [...new Set(keys.filter((key) => available.has(key)))];
}

const INITIAL_TIMESTAMP = "2026-08-11T08:30:00.000Z";

export const MOCK_WORKFLOW_VAULTS: MockWorkflowVault[] = [
  {
    id: "vault-long-running",
    name: "long-running",
    description: "Workspace for long-running tasks",
    kind: "existing",
    status: "running",
    canRun: true,
    availabilityReason: null,
    profile: "General / Long-running",
    capacity: "2 slots available",
    surfaces: [],
    serverId: null,
    wanghaiId: null,
  },
  {
    id: "vault-default",
    name: "default-work",
    description: "Default Vault for everyday tasks",
    kind: "existing",
    status: "running",
    canRun: true,
    availabilityReason: null,
    profile: "General / Interactive",
    capacity: "1 slot available",
    surfaces: [],
    serverId: null,
    wanghaiId: null,
  },
  {
    id: "vault-disposable",
    name: "disposable-review",
    description: "Disposable runtime reclaimed after completion",
    kind: "disposable",
    status: null,
    canRun: false,
    availabilityReason: "Created on submission",
    profile: "Review / Disposable",
    capacity: "Created on submission",
    surfaces: [],
    serverId: null,
    wanghaiId: null,
  },
];

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function cardsFromRuns(runs: MockWorkflowRun[]): MockWorkCard[] {
  return runs.map((run) => ({
    id: `card-${run.id}`,
    runId: run.id,
    title: run.title,
    summary: run.summary,
    packId: run.packId,
    flowId: run.flowId,
    vaultName: run.vaultName,
    status: run.status,
    priority: run.priority,
    updatedAt: run.updatedAt,
  }));
}

function seedRun(
  pack: MockDomainPack,
  flow: MockWorkflowFlow,
  vault: MockWorkflowVault,
  index: number,
): MockWorkflowRun {
  const status: WorkflowStatus = index === 0 && flow.approvalRequired
    ? "waiting"
    : index === 1
      ? "running"
      : "succeeded";
  const createdAt = new Date(Date.parse(INITIAL_TIMESTAMP) + index * 15 * 60 * 1000).toISOString();
  const updatedAt = new Date(Date.parse(createdAt) + 12 * 60 * 1000).toISOString();
  const input = Object.fromEntries(flow.fields.map((field) => [field.id, "synthetic input"]));
  const events: MockWorkflowEvent[] = [
    {
      id: `mock-event-${index + 1}-latest`,
      sequence: 2,
      kind: status,
      title: status === "waiting" ? "Waiting for review" : status === "running" ? "Run started in Vault" : "Result generated",
      detail: status === "waiting"
        ? "The result is ready and needs review before continuing."
        : status === "running"
          ? "The mock executor is advancing this workflow."
          : "The mock executor generated a synthetic artifact.",
      timestamp: updatedAt,
      tone: status === "waiting" ? "warning" : status === "running" ? "accent" : "success",
    },
    {
      id: `mock-event-${index + 1}-queued`,
      sequence: 1,
      kind: "submitted",
      title: "Submitted to execution queue",
      detail: `Using ${pack.title} · ${vault.name}`,
      timestamp: createdAt,
      tone: "neutral",
    },
  ];
  const artifacts: MockWorkflowArtifact[] = status === "succeeded"
    ? [{
      id: `mock-artifact-${index + 1}`,
      name: `${flow.id}-result.md`,
      kind: "report",
      size: "12 KB",
      summary: "Synthetic result generated by the mock executor",
      content: `# ${flow.title}\n\nThis synthetic artifact was generated by the Portal mock executor.`,
    }]
    : [];
  const receipts: MockWorkflowRun["receipts"] = status === "succeeded"
    ? [{
      id: `mock-receipt-${index + 1}`,
      requestId: `mock-request-${index + 1}`,
      stepId: "summarize",
      stepLabel: "Summarize",
      outputFields: ["summary", "confidence"],
      port: "SyntheticTool",
      version: "1.0.0",
      effect: "ffi",
      status: "completed",
      input: { subject: input.subject ?? "synthetic input" },
      output: { summary: `${flow.title} generated`, confidence: 1 },
      createdAt,
      completedAt: updatedAt,
    }]
    : [];
  return {
    id: `mock-run-${index + 1}`,
    packId: pack.id,
    flowId: flow.id,
    packVersion: pack.version,
    packDigest: pack.digest,
    vaultId: vault.id,
    vaultName: vault.name,
    status,
    priority: index === 0 ? "urgent" : index === 1 ? "normal" : "low",
    title: flow.title,
    summary: flow.summary,
    input,
    progress: status === "waiting" ? 78 : status === "running" ? 46 : 100,
    createdAt,
    updatedAt,
    approvalRequired: flow.approvalRequired,
    source: "manual",
    executionClass: "workspace",
    capabilityLeaseId: `mock-lease-${index + 1}`,
    capabilityLeaseExpiresAt: new Date(Date.parse(updatedAt) + 30 * 60_000).toISOString(),
    policy: {
      decision: "allow",
      mode: "mock",
      reasons: ["synthetic-fixture"],
    },
    events,
    steps: receipts.map((receipt) => ({
      id: `mock-step-${index + 1}`,
      sequence: 1,
      stepId: receipt.stepId ?? "summarize",
      stepLabel: receipt.stepLabel ?? "Summarize",
      status: receipt.status === "failed" ? "failed" : "completed",
      detail: "Synthetic step completed",
      call: receipt.port,
      input: receipt.input,
      output: receipt.output,
      outputFields: receipt.outputFields ?? Object.keys(receipt.output),
      createdAt: receipt.createdAt,
      completedAt: receipt.completedAt,
    })),
    receipts,
    artifacts,
  };
}

export function createMockRunsForCatalog(
  packs: MockDomainPack[],
  vaults: MockWorkflowVault[] = MOCK_WORKFLOW_VAULTS,
): MockWorkflowRun[] {
  if (vaults.length === 0) return [];
  const available = packs
    .flatMap((pack) => pack.flows.map((flow) => ({ pack, flow })))
    .sort((left, right) => Number(right.flow.approvalRequired) - Number(left.flow.approvalRequired));
  return available
    .slice(0, 3)
    .map(({ pack, flow }, index) => seedRun(pack, flow, vaults[index % vaults.length]!, index));
}

/**
 * The Portal keeps synthetic Vaults and execution projections for the first
 * vertical slice. The catalog and every pack/flow identity come from the
 * authenticated Polaris API.
 */
export function createInitialWorkflowState(): WorkflowMockState {
  return {
    packs: [],
    vaults: [],
    runs: {},
    cards: [],
    replayCursor: 0,
    setup: {
      completed: false,
      domainPackId: null,
      vaultId: null,
      enabledWorkflowKeys: [],
      completedAt: null,
    },
  };
}

export function packForRun(
  packs: MockDomainPack[],
  run: MockWorkflowRun,
): MockDomainPack | undefined {
  return packs.find((pack) => pack.id === run.packId);
}

export function flowForRun(
  packs: MockDomainPack[],
  run: MockWorkflowRun,
): MockWorkflowFlow | undefined {
  return packForRun(packs, run)?.flows.find((flow) => flow.id === run.flowId);
}

export function updateCardFromRun(
  cards: MockWorkCard[],
  run: MockWorkflowRun,
): MockWorkCard[] {
  return cards.map((card) => card.runId === run.id
    ? {
      ...card,
      title: run.title,
      summary: run.summary,
      status: run.status,
      updatedAt: run.updatedAt,
      vaultName: run.vaultName,
    }
    : card);
}
