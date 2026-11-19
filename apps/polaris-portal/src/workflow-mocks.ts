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
