import { checkFfiAdmission } from "polaris-workflow";
import type { FfiRpcRequest } from "polaris-workflow";

export const WORKFLOW_LIVE_ADAPTER_FLAG = "POLARIS_WORKFLOW_LIVE_ADAPTER";

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

export interface EvaluateWorkflowLiveInvocationInput {
  request: FfiRpcRequest;
  environment?: Record<string, string | undefined>;
  readiness?: Partial<WorkflowLiveReadiness>;
  catalog?: readonly WorkflowActionCatalogEntry[];
  now?: Date;
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
    id: "vault.artifact.metadata.read",
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
