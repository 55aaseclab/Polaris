import { checkFfiAdmission } from "polaris-workflow";
import type { FfiRpcRequest } from "polaris-workflow";

export const WORKFLOW_LIVE_ADAPTER_FLAG = "POLARIS_WORKFLOW_LIVE_ADAPTER";
export const WORKFLOW_LIVE_WORKER_BINDING_FLAG = "POLARIS_WORKFLOW_LIVE_WORKER_BINDING";
export const WORKFLOW_LIVE_RELEASE_PROFILE_ID = "0.3.0-single-host";
export const WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID = "vault.artifact.metadata.read";

export type WorkflowLiveWorkerPrecondition =
  | "metadata-action"
  | "read-only-action"
  | "action-disabled"
  | "action-enabled"
  | "source-review"
  | "worker-unwired"
  | "worker-binding-state"
  | "release-profile"
  | "timeout"
  | "retry"
  | "budget"
  | "kill-switch"
  | "receipt-reconciliation"
  | "audit"
  | "rollback"
  | "deployment-evidence";

export type WorkflowLiveGate =
  | "receipt-reconciliation"
  | "budget"
  | "kill-switch"
  | "audit"
  | "rollback"
  | "deployment-evidence";

export const REQUIRED_WORKFLOW_LIVE_GATES = [
  "receipt-reconciliation",
  "budget",
  "kill-switch",
  "audit",
  "rollback",
  "deployment-evidence",
] as const satisfies readonly WorkflowLiveGate[];

export interface WorkflowLiveReadiness {
  receiptReconciliation: boolean;
  budget: boolean;
  killSwitch: boolean;
  audit: boolean;
  rollback: boolean;
  deploymentEvidence: boolean;
}

export interface WorkflowLiveWorkerReleaseProfile {
  readonly id: string;
  readonly capacity: {
    readonly jobWorkerConcurrency: number;
    readonly jobLeaseMs: number;
  };
  readonly slo: {
    readonly readP95Ms: number;
    readonly recoverySeconds: number;
  };
}

export interface WorkflowLiveWorkerIntegrationPreconditions {
  readonly sourceReview?: boolean;
  readonly workerWiring?: "unwired" | "candidate";
  readonly timeout?: {
    readonly perAttemptMs?: number;
    readonly maxTotalMs?: number;
    readonly abortSignal?: boolean;
  };
  readonly retry?: {
    readonly maxAttempts?: number;
    readonly idempotentByRequestId?: boolean;
    readonly retryOnlyReadFailures?: boolean;
  };
  readonly budget?: {
    readonly releaseProfileId?: string;
    readonly maxConcurrentLiveReads?: number;
    readonly countsAgainstJobWorker?: boolean;
    readonly readP95Ms?: number;
  };
  readonly killSwitch?: {
    readonly environmentFlag?: string;
    readonly disabledValue?: "disabled";
    readonly failClosedWhenUnset?: boolean;
    readonly checkedBeforeEachAttempt?: boolean;
  };
  readonly receiptReconciliation?: {
    readonly durableReceipts?: boolean;
    readonly duplicateRequestIdsReconcile?: boolean;
    readonly admittedFailuresPersisted?: boolean;
  };
  readonly audit?: {
    readonly immutableEvents?: boolean;
    readonly noPreAdmissionWrites?: boolean;
  };
  readonly rollback?: {
    readonly disablesWorkerBinding?: boolean;
    readonly preservesDurableEvidence?: boolean;
  };
  readonly deploymentEvidence?: {
    readonly releaseId?: string;
    readonly profileId?: string;
    readonly focusedChecks?: readonly string[];
  };
}

export interface WorkflowActionCatalogEntry {
  readonly id: string;
  readonly version: 1;
  readonly port: string;
  readonly portVersion: string;
  readonly effect: FfiRpcRequest["call"]["effect"];
  readonly builtin?: string;
  readonly risk: "read" | "workspace" | "external" | "human";
  readonly adapter: "polaris-human" | "future-vault";
  readonly liveEnabled: boolean;
  readonly requiredGates: readonly WorkflowLiveGate[];
  readonly description: string;
}

export type WorkflowLiveInvocationDecision =
  | {
      allowed: true;
      action: WorkflowActionCatalogEntry;
      reasons: string[];
    }
  | {
      allowed: false;
      code: string;
      message: string;
      reasons: string[];
      action?: WorkflowActionCatalogEntry;
    };

export type WorkflowLiveWorkerIntegrationDecision =
  | {
      ready: true;
      action: WorkflowActionCatalogEntry;
      reasons: string[];
    }
  | {
      ready: false;
      code: string;
      message: string;
      reasons: WorkflowLiveWorkerPrecondition[];
      action?: WorkflowActionCatalogEntry;
    };

export interface EvaluateWorkflowLiveInvocationInput {
  request: FfiRpcRequest;
  environment?: Record<string, string | undefined>;
  readiness?: Partial<WorkflowLiveReadiness>;
  catalog?: readonly WorkflowActionCatalogEntry[];
  now?: Date;
}

export interface EvaluateWorkflowLiveWorkerIntegrationInput {
  actionId?: string;
  catalog?: readonly WorkflowActionCatalogEntry[];
  releaseProfile?: WorkflowLiveWorkerReleaseProfile;
  preconditions?: WorkflowLiveWorkerIntegrationPreconditions;
  stage?: "review" | "candidate";
}

const ACTION_CATALOG = [
  {
    id: "manual.review",
    version: 1,
    port: "manual.review",
    portVersion: "1.0.0",
    effect: "human",
    builtin: "manual.review",
    risk: "human",
    adapter: "polaris-human",
    liveEnabled: false,
    requiredGates: REQUIRED_WORKFLOW_LIVE_GATES,
    description: "Human approval interface owned by Polaris workflow state.",
  },
  {
    id: WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
    version: 1,
    port: "ArtifactMetadata",
    portVersion: "1.0.0",
    effect: "read",
    risk: "read",
    adapter: "future-vault",
    liveEnabled: false,
    requiredGates: REQUIRED_WORKFLOW_LIVE_GATES,
    description: "Future read-only Vault artifact metadata action.",
  },
] as const satisfies readonly WorkflowActionCatalogEntry[];

const REQUIRED_WORKFLOW_LIVE_WORKER_FOCUSED_CHECKS = [
  "polaris-workflow-live-boundary",
  "polaris-workflow-live-vault-adapter",
] as const;

function readinessForGate(
  readiness: Partial<WorkflowLiveReadiness> | undefined,
  gate: WorkflowLiveGate,
): boolean {
  if (!readiness) return false;
  if (gate === "receipt-reconciliation") return readiness.receiptReconciliation === true;
  if (gate === "kill-switch") return readiness.killSwitch === true;
  if (gate === "deployment-evidence") return readiness.deploymentEvidence === true;
  return readiness[gate] === true;
}

export function missingWorkflowLiveGates(
  readiness?: Partial<WorkflowLiveReadiness>,
  requiredGates: readonly WorkflowLiveGate[] = REQUIRED_WORKFLOW_LIVE_GATES,
): WorkflowLiveGate[] {
  return requiredGates.filter((gate) => !readinessForGate(readiness, gate));
}

export function listWorkflowActionCatalog(): readonly WorkflowActionCatalogEntry[] {
  return ACTION_CATALOG;
}

export function findWorkflowActionById(
  actionId: string,
  catalog: readonly WorkflowActionCatalogEntry[] = ACTION_CATALOG,
): WorkflowActionCatalogEntry | undefined {
  const id = actionId.trim();
  if (!id) return undefined;
  return catalog.find((action) => action.id === id);
}

export function findWorkflowActionForCall(
  request: FfiRpcRequest,
  catalog: readonly WorkflowActionCatalogEntry[] = ACTION_CATALOG,
): WorkflowActionCatalogEntry | undefined {
  return catalog.find((action) => {
    if (action.effect !== request.call.effect || action.portVersion !== request.call.version) {
      return false;
    }
    if (action.builtin) {
      return action.builtin === request.call.builtin;
    }
    return action.port === request.call.port && !request.call.builtin;
  });
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasFocusedChecks(actual: readonly string[] | undefined): boolean {
  if (!actual) return false;
  const checks = new Set(actual.map((entry) => entry.trim()).filter(Boolean));
  return REQUIRED_WORKFLOW_LIVE_WORKER_FOCUSED_CHECKS.every((entry) => checks.has(entry));
}

function profileIsCurrentSingleHost(
  profile: WorkflowLiveWorkerReleaseProfile | undefined,
): profile is WorkflowLiveWorkerReleaseProfile {
  return profile?.id === WORKFLOW_LIVE_RELEASE_PROFILE_ID
    && isPositiveInteger(profile.capacity.jobWorkerConcurrency)
    && isPositiveInteger(profile.capacity.jobLeaseMs)
    && isPositiveInteger(profile.slo.readP95Ms)
    && isPositiveInteger(profile.slo.recoverySeconds);
}

export function missingWorkflowLiveWorkerIntegrationPreconditions(
  input: EvaluateWorkflowLiveWorkerIntegrationInput = {},
): WorkflowLiveWorkerPrecondition[] {
  const missing: WorkflowLiveWorkerPrecondition[] = [];
  const stage = input.stage ?? "review";
  const actionId = input.actionId?.trim() || WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID;
  const action = findWorkflowActionById(actionId, input.catalog);
  if (!action || action.id !== WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID) {
    missing.push("metadata-action");
  } else {
    if (action.effect !== "read" || action.risk !== "read" || action.adapter !== "future-vault") {
      missing.push("read-only-action");
    }
    if (stage === "review" && action.liveEnabled !== false) {
      missing.push("action-disabled");
    }
    if (stage === "candidate" && action.liveEnabled !== true) {
      missing.push("action-enabled");
    }
  }

  const preconditions = input.preconditions;
  const releaseProfile = input.releaseProfile;
  const profileReady = profileIsCurrentSingleHost(releaseProfile);
  if (preconditions?.sourceReview !== true) {
    missing.push("source-review");
  }
  if (stage === "review" && preconditions?.workerWiring !== "unwired") {
    missing.push("worker-unwired");
  }
  if (stage === "candidate" && preconditions?.workerWiring !== "candidate") {
    missing.push("worker-binding-state");
  }
  if (!profileReady) {
    missing.push("release-profile");
  }

  const timeout = preconditions?.timeout;
  const timeoutValid = Boolean(
    timeout
      && isPositiveInteger(timeout.perAttemptMs)
      && isPositiveInteger(timeout.maxTotalMs)
      && timeout.abortSignal === true
      && timeout.perAttemptMs <= timeout.maxTotalMs
      && profileReady
      && timeout.maxTotalMs <= releaseProfile.slo.readP95Ms
      && timeout.maxTotalMs < releaseProfile.capacity.jobLeaseMs,
  );
  if (!timeoutValid) {
    missing.push("timeout");
  }

  const retry = preconditions?.retry;
  const retryValid = Boolean(
    retry
      && isPositiveInteger(retry.maxAttempts)
      && retry.maxAttempts <= 2
      && retry.idempotentByRequestId === true
      && retry.retryOnlyReadFailures === true
      && timeout
      && isPositiveInteger(timeout.perAttemptMs)
      && isPositiveInteger(timeout.maxTotalMs)
      && timeout.perAttemptMs * retry.maxAttempts <= timeout.maxTotalMs,
  );
  if (!retryValid) {
    missing.push("retry");
  }

  const budget = preconditions?.budget;
  const budgetValid = Boolean(
    budget
      && profileReady
      && budget.releaseProfileId === releaseProfile.id
      && isPositiveInteger(budget.maxConcurrentLiveReads)
      && budget.maxConcurrentLiveReads <= releaseProfile.capacity.jobWorkerConcurrency
      && budget.countsAgainstJobWorker === true
      && budget.readP95Ms === releaseProfile.slo.readP95Ms,
  );
  if (!budgetValid) {
    missing.push("budget");
  }

  const killSwitch = preconditions?.killSwitch;
  if (
    !killSwitch
    || killSwitch.environmentFlag !== WORKFLOW_LIVE_WORKER_BINDING_FLAG
    || killSwitch.disabledValue !== "disabled"
    || killSwitch.failClosedWhenUnset !== true
    || killSwitch.checkedBeforeEachAttempt !== true
  ) {
    missing.push("kill-switch");
  }

  const receipt = preconditions?.receiptReconciliation;
  if (
    !receipt
    || receipt.durableReceipts !== true
    || receipt.duplicateRequestIdsReconcile !== true
    || receipt.admittedFailuresPersisted !== true
  ) {
    missing.push("receipt-reconciliation");
  }

  const audit = preconditions?.audit;
  if (
    !audit
    || audit.immutableEvents !== true
    || audit.noPreAdmissionWrites !== true
  ) {
    missing.push("audit");
  }

  const rollback = preconditions?.rollback;
  if (
    !rollback
    || rollback.disablesWorkerBinding !== true
    || rollback.preservesDurableEvidence !== true
  ) {
    missing.push("rollback");
  }

  const deploymentEvidence = preconditions?.deploymentEvidence;
  if (
    !deploymentEvidence
    || !nonEmptyString(deploymentEvidence.releaseId)
    || !profileReady
    || deploymentEvidence.profileId !== releaseProfile.id
    || !hasFocusedChecks(deploymentEvidence.focusedChecks)
  ) {
    missing.push("deployment-evidence");
  }

  return missing;
}

export function evaluateWorkflowLiveWorkerIntegration(
  input: EvaluateWorkflowLiveWorkerIntegrationInput = {},
): WorkflowLiveWorkerIntegrationDecision {
  const actionId = input.actionId?.trim() || WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID;
  const action = findWorkflowActionById(actionId, input.catalog);
  const missing = missingWorkflowLiveWorkerIntegrationPreconditions(input);
  if (missing.length > 0) {
    return {
      ready: false,
      code: "workflow-live-worker-preconditions-incomplete",
      message: `Workflow live worker integration is missing preconditions: ${missing.join(", ")}`,
      reasons: missing,
      ...(action ? { action } : {}),
    };
  }
  if (!action) {
    return {
      ready: false,
      code: "workflow-live-worker-action-not-found",
      message: "Workflow live worker integration requires a cataloged action",
      reasons: ["metadata-action"],
    };
  }
  return {
    ready: true,
    action,
    reasons: input.stage === "candidate"
      ? [
        "metadata-action-source-reviewed",
        "worker-binding-candidate",
        "release-profile-budget-preserved",
      ]
      : [
        "metadata-action-source-reviewed",
        "worker-remains-unwired",
        "release-profile-budget-preserved",
      ],
  };
}

export function evaluateWorkflowLiveInvocation(
  input: EvaluateWorkflowLiveInvocationInput,
): WorkflowLiveInvocationDecision {
  const admission = checkFfiAdmission(input.request, input.now);
  if (!admission.allowed) {
    return {
      allowed: false,
      code: admission.code,
      message: admission.message,
      reasons: ["ffi-admission-denied"],
    };
  }
  const action = findWorkflowActionForCall(input.request, input.catalog);
  if (!action) {
    return {
      allowed: false,
      code: "workflow-action-not-cataloged",
      message: "Workflow live execution requires a cataloged action",
      reasons: ["action-catalog-required"],
    };
  }
  if (input.request.mode !== "live") {
    return {
      allowed: false,
      code: "live-mode-required",
      message: "Workflow live adapter accepts only live RPC requests",
      reasons: ["live-mode-required"],
      action,
    };
  }
  if (input.environment?.[WORKFLOW_LIVE_ADAPTER_FLAG] !== "enabled") {
    return {
      allowed: false,
      code: "live-adapter-disabled",
      message: "Workflow live adapter is disabled by deployment policy",
      reasons: ["feature-flag-disabled"],
      action,
    };
  }
  const missing = missingWorkflowLiveGates(input.readiness, action.requiredGates);
  if (missing.length > 0) {
    return {
      allowed: false,
      code: "live-adapter-gates-incomplete",
      message: `Workflow live adapter is missing gates: ${missing.join(", ")}`,
      reasons: missing,
      action,
    };
  }
  if (!action.liveEnabled) {
    return {
      allowed: false,
      code: "workflow-action-disabled",
      message: "Cataloged workflow action is not enabled for live execution",
      reasons: ["action-disabled"],
      action,
    };
  }
  return {
    allowed: true,
    action,
    reasons: ["ffi-admission-allowed", "live-gates-complete"],
  };
}
