export type WorkflowStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WorkflowPriority = "urgent" | "normal" | "low";

export type WorkflowField = {
  id: string;
  label: string;
  type: "text" | "textarea";
  placeholder: string;
  required: boolean;
};

export type MockWorkflowFlow = {
  id: string;
  title: string;
  summary: string;
  estimate: string;
  approvalRequired: boolean;
  groupId?: string;
  groupTitle?: string;
  fields: WorkflowField[];
};

export type MockDomainPack = {
  id: string;
  title: string;
  category: string;
  description: string;
  version: string;
  digest: string;
  capabilities: string[];
  accent: "green" | "blue" | "amber";
  flows: MockWorkflowFlow[];
};

export type MockWorkflowVault = {
  id: string;
  name: string;
  description: string;
  kind: "existing" | "disposable";
  status: "running" | "ready" | "starting";
  profile: string;
  capacity: string;
};

export type WorkflowEventTone = "neutral" | "accent" | "warning" | "success";

export type MockWorkflowEvent = {
  id: string;
  title: string;
  detail: string;
  timestamp: string;
  tone: WorkflowEventTone;
};

export type MockWorkflowArtifact = {
  id: string;
  name: string;
  kind: "report" | "data" | "log";
  size: string;
  summary: string;
  content: string;
};

export type MockWorkflowRun = {
  id: string;
  packId: string;
  flowId: string;
  vaultId: string;
  vaultName: string;
  status: WorkflowStatus;
  priority: WorkflowPriority;
  title: string;
  summary: string;
  input: Record<string, string>;
  progress: number;
  createdAt: string;
  updatedAt: string;
  approvalRequired: boolean;
  events: MockWorkflowEvent[];
  artifacts: MockWorkflowArtifact[];
  error?: string;
};

export type MockWorkCard = {
  id: string;
  runId: string;
  title: string;
  summary: string;
  packId: string;
  flowId: string;
  vaultName: string;
  status: WorkflowStatus;
  priority: WorkflowPriority;
  updatedAt: string;
};

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
  setup: WorkflowSetup;
};

export function workflowKey(packId: string, flowId: string): string {
  return `${packId}:${flowId}`;
}

const INITIAL_TIMESTAMP = "2026-08-11T08:30:00.000Z";

export const MOCK_WORKFLOW_VAULTS: MockWorkflowVault[] = [
  {
    id: "vault-long-running",
    name: "long-running",
    description: "长期任务的工作舱",
    kind: "existing",
    status: "running",
    profile: "General / 长周期",
    capacity: "2 个运行位可用",
  },
  {
    id: "vault-default",
    name: "default-work",
    description: "日常轻量任务的默认 Vault",
    kind: "existing",
    status: "running",
    profile: "General / 交互",
    capacity: "1 个运行位可用",
  },
  {
    id: "vault-disposable",
    name: "disposable-review",
    description: "完成后自动回收的临时执行舱",
    kind: "disposable",
    status: "ready",
    profile: "Review / 一次性",
    capacity: "提交时创建",
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
  const input = Object.fromEntries(flow.fields.map((field) => [field.id, "示例输入"]));
  const events: MockWorkflowEvent[] = [
    {
      id: `mock-event-${index + 1}-latest`,
      title: status === "waiting" ? "等待人工确认" : status === "running" ? "已在 Vault 中开始运行" : "结果已生成",
      detail: status === "waiting"
        ? "结果已准备好，下一步需要人工确认。"
        : status === "running"
          ? "mock executor 正在推进这个工作流。"
          : "mock executor 已生成一个示例产物。",
      timestamp: updatedAt,
      tone: status === "waiting" ? "warning" : status === "running" ? "accent" : "success",
    },
    {
      id: `mock-event-${index + 1}-queued`,
      title: "已提交到执行队列",
      detail: `将使用 ${pack.title} · ${vault.name}`,
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
      summary: "mock executor 生成的结果摘要",
      content: `# ${flow.title}\n\n这是由 Portal mock executor 生成的 synthetic artifact。`,
    }]
    : [];
  return {
    id: `mock-run-${index + 1}`,
    packId: pack.id,
    flowId: flow.id,
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
    events,
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
    vaults: clone(MOCK_WORKFLOW_VAULTS),
    runs: {},
    cards: [],
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
