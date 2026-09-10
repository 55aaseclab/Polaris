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

export type WorkflowFlowProjection = {
  id: string;
  title: string;
  summary: string;
  estimate: string;
  approvalRequired: boolean;
  groupId?: string;
  groupTitle?: string;
  fields: WorkflowField[];
};

export type WorkflowGraphNode = {
  id: string;
  label: string;
  kind: "input" | "step" | "output";
  role?: string;
  call?: string;
  effect?: string;
  uses: string[];
  outputs: string[];
  capabilities?: string[];
  retry?: { maxAttempts: number; backoffMs: number };
  timeoutMs?: number;
  terminal?: boolean;
};

export type WorkflowGraphEdge = {
  from: string;
  to: string;
  field?: string;
  when?: string;
  feedback?: string;
  feedbackAs?: string;
  resetAttempts?: boolean;
};

export type WorkflowGraphProjection = {
  packId: string;
  packVersion: string;
  packDigest: string;
  flowId: string;
  flowTitle: string;
  flow: {
    nodes: WorkflowGraphNode[];
    edges: WorkflowGraphEdge[];
  };
};

export type WorkflowDomainPackProjection = {
  id: string;
  title: string;
  category: string;
  description: string;
  version: string;
  languageVersion?: string;
  digest: string;
  capabilities: string[];
  accent: "green" | "blue" | "amber";
  warnings?: string[];
  flows: WorkflowFlowProjection[];
};

export type WorkflowVaultProjection = {
  id: string;
  name: string;
  description: string;
  kind: "existing" | "disposable";
  /** Canonical Polaris VaultStatus.driver.status. */
  status: string | null;
  /** Derived by Polaris admission; the Portal never infers this locally. */
  canRun: boolean;
  availabilityReason: string | null;
  profile: string;
  capacity: string;
  surfaces: string[];
  serverId: string | null;
  wanghaiId: string | null;
};

export type WorkflowEventTone = "neutral" | "accent" | "warning" | "success";

export type WorkflowEvent = {
  id: string;
  sequence: number;
  kind: string;
  title: string;
  detail: string;
  timestamp: string;
  tone: WorkflowEventTone;
};

export type WorkflowArtifact = {
  id: string;
  name: string;
  kind: "report" | "data" | "log";
  size: string;
  summary: string;
  content: string;
  digest?: string;
  redacted?: boolean;
};

export type WorkflowMockScenario =
  | "normal"
  | "quota-denied"
  | "vault-unavailable"
  | "executor-failure";

export type WorkflowExecutionClass = "pure" | "workspace" | "ai";

/**
 * Where Polaris executes a workflow. `none` is the explicit host path; a
 * concrete Vault is represented by `vault` and remains server-resolved.
 */
export type WorkflowExecutionDriver = "none" | "vault";

export type WorkflowEffectReceipt = {
  id: string;
  requestId: string;
  port: string;
  version: string;
  effect: string;
  status: string;
  createdAt: string;
  completedAt: string;
};

export type WorkflowRunProjection = {
  id: string;
  packId: string;
  flowId: string;
  packVersion: string;
  packDigest: string;
  /** Null for host execution (`driver: "none"`). */
  vaultId: string | null;
  vaultName: string;
  driver?: WorkflowExecutionDriver;
  status: WorkflowStatus;
  priority: WorkflowPriority;
  title: string;
  summary: string;
  input: Record<string, string>;
  progress: number;
  createdAt: string;
  updatedAt: string;
  approvalRequired: boolean;
  source: "manual" | "provisioning" | "retry" | "suggestion";
  executionClass: WorkflowExecutionClass;
  capabilityLeaseId: string;
  capabilityLeaseExpiresAt: string;
  policy: {
    decision: "allow" | "deny";
    mode: "mock" | "host" | "live";
    reasons: string[];
  };
  events: WorkflowEvent[];
  receipts: WorkflowEffectReceipt[];
  artifacts: WorkflowArtifact[];
  error?: {
    code: string;
    message: string;
  };
};

export type WorkflowWorkCard = {
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

export type WorkflowRunRequest = {
  packId: string;
  flowId: string;
  /** Omit this for host execution. */
  vaultId?: string | null;
  /** Defaults to `none` when no Vault is supplied. */
  driver?: WorkflowExecutionDriver;
  values: Record<string, string>;
  scenario?: WorkflowMockScenario;
};

export type WorkflowRunsResponse = {
  runs: WorkflowRunProjection[];
  replayCursor: number;
};

export type WorkflowEventsResponse = {
  runId: string;
  events: WorkflowEvent[];
  nextCursor: number;
};

export type WorkflowSetupProjection = {
  completed: boolean;
  domainPackId: string | null;
  /** Null selects the Polaris host as the default execution location. */
  vaultId: string | null;
  enabledWorkflowKeys: string[];
  completedAt: string | null;
};

export type WorkflowSetupRequest = WorkflowSetupProjection;

export type WorkflowSuggestionProjection = {
  id: string;
  sourceRunId: string;
  packId: string;
  flowId: string;
  status: "suggested" | "accepted" | "dismissed";
  draft: Record<string, unknown>;
  evidence: string[];
  createdAt: string;
  updatedAt: string;
};
