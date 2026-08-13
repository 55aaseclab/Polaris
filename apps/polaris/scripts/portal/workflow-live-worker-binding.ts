import type { FfiRpcRequest } from "polaris-workflow";
import {
  evaluateWorkflowLiveWorkerIntegration,
  WORKFLOW_LIVE_ADAPTER_FLAG,
  WORKFLOW_LIVE_WORKER_BINDING_FLAG,
  WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
  type EvaluateWorkflowLiveWorkerIntegrationInput,
  type WorkflowActionCatalogEntry,
  type WorkflowLiveReadiness,
  type WorkflowLiveWorkerIntegrationPreconditions,
  type WorkflowLiveWorkerReleaseProfile,
} from "./workflow-live-boundary.js";
import {
  invokeWorkflowLiveVaultArtifactMetadata,
  recordWorkflowLiveVaultArtifactMetadataEvidence,
  WorkflowLiveVaultMetadataReadError,
  type WorkflowLiveVaultArtifactMetadataInvocationResult,
  type WorkflowLiveVaultArtifactMetadataReader,
} from "./workflow-live-vault-adapter.js";
import type { PolarisControlStore } from "./control-store.js";

export interface WorkflowLiveMetadataWorkerBindingInput {
  store: PolarisControlStore;
  request: FfiRpcRequest;
  environment?: Record<string, string | undefined>;
  readiness: WorkflowLiveReadiness;
  releaseProfile: WorkflowLiveWorkerReleaseProfile;
  preconditions: WorkflowLiveWorkerIntegrationPreconditions;
  catalog: readonly WorkflowActionCatalogEntry[];
  readMetadata?: WorkflowLiveVaultArtifactMetadataReader;
  now?: Date;
}

export type WorkflowLiveMetadataWorkerBindingResult =
  WorkflowLiveVaultArtifactMetadataInvocationResult & {
    attempts: number;
    workerBinding: "disabled" | "executed";
  };

let activeLiveToolReads = 0;

export function rollbackWorkflowLiveMetadataWorkerBinding(
  environment: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...environment,
    [WORKFLOW_LIVE_WORKER_BINDING_FLAG]: "disabled",
  };
}

function disabledResult(
  code: string,
  message: string,
  reasons: string[],
): WorkflowLiveMetadataWorkerBindingResult {
  return {
    allowed: false,
    code,
    message,
    reasons,
    attempts: 0,
    workerBinding: "disabled",
  };
}

function metadataAction(
  catalog: readonly WorkflowActionCatalogEntry[],
): WorkflowActionCatalogEntry | undefined {
  return catalog.find((action) => action.id === WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID);
}

function retryableMetadataReadFailure(
  result: WorkflowLiveVaultArtifactMetadataInvocationResult,
): boolean {
  return !result.allowed && result.code === "live-vault-metadata-read-failed";
}

function timeoutResult(
  action: WorkflowActionCatalogEntry,
): WorkflowLiveVaultArtifactMetadataInvocationResult {
  return {
    allowed: false,
    code: "live-vault-metadata-timeout",
    message: "Workflow live Vault metadata read exceeded its execution deadline",
    reasons: ["metadata-read-timeout"],
    action,
  };
}

function createTimeoutError(): WorkflowLiveVaultMetadataReadError {
  return new WorkflowLiveVaultMetadataReadError(
    "Workflow live Vault metadata read exceeded its execution deadline",
    "live-vault-metadata-timeout",
  );
}

async function withAttemptTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(createTimeoutError());
        reject(createTimeoutError());
      }, timeoutMs);
      run(controller.signal).then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function invokeWorkflowLiveVaultArtifactMetadataFromWorker(
  input: WorkflowLiveMetadataWorkerBindingInput,
): Promise<WorkflowLiveMetadataWorkerBindingResult> {
  if (input.environment?.[WORKFLOW_LIVE_WORKER_BINDING_FLAG] !== "enabled") {
    return disabledResult(
      "live-worker-binding-disabled",
      "Workflow live metadata worker binding is disabled by deployment policy",
      ["worker-binding-disabled"],
    );
  }
  if (input.environment?.[WORKFLOW_LIVE_ADAPTER_FLAG] !== "enabled") {
    return disabledResult(
      "live-adapter-disabled",
      "Workflow live tool gateway is disabled by deployment policy",
      ["feature-flag-disabled"],
    );
  }

  const integration = evaluateWorkflowLiveWorkerIntegration({
    actionId: WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
    catalog: input.catalog,
    releaseProfile: input.releaseProfile,
    preconditions: input.preconditions,
    stage: "candidate",
  } satisfies EvaluateWorkflowLiveWorkerIntegrationInput);
  if (!integration.ready) {
    return {
      allowed: false,
      code: integration.code,
      message: integration.message,
      reasons: integration.reasons,
      action: integration.action,
      attempts: 0,
      workerBinding: "disabled",
    };
  }

  const budget = input.preconditions.budget;
  const maxConcurrentLiveReads = Math.max(1, Math.floor(budget?.maxConcurrentLiveReads ?? 1));
  if (activeLiveToolReads >= maxConcurrentLiveReads) {
    return {
      allowed: false,
      code: "live-worker-budget-exhausted",
      message: "Workflow live metadata worker binding has exhausted its live-read budget",
      reasons: ["live-worker-budget-exhausted"],
      action: integration.action,
      attempts: 0,
      workerBinding: "disabled",
    };
  }

  const startedAt = new Date().toISOString();
  const maxAttempts = Math.max(1, Math.floor(input.preconditions.retry?.maxAttempts ?? 1));
  const perAttemptMs = Math.max(1, Math.floor(input.preconditions.timeout?.perAttemptMs ?? 1));
  const maxTotalMs = Math.max(perAttemptMs, Math.floor(input.preconditions.timeout?.maxTotalMs ?? perAttemptMs));
  const deadlineMs = Date.now() + maxTotalMs;
  let attempts = 0;
  let finalResult: WorkflowLiveVaultArtifactMetadataInvocationResult | null = null;

  activeLiveToolReads += 1;
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (input.environment?.[WORKFLOW_LIVE_WORKER_BINDING_FLAG] !== "enabled") {
        finalResult = {
          allowed: false,
          code: "live-worker-binding-disabled",
          message: "Workflow live metadata worker binding was disabled before retry",
          reasons: ["worker-binding-disabled"],
          action: integration.action,
        };
        break;
      }

      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        finalResult = timeoutResult(integration.action);
        break;
      }

      attempts = attempt + 1;
      const attemptResult = await withAttemptTimeout(
        Math.min(perAttemptMs, remainingMs),
        (signal) => invokeWorkflowLiveVaultArtifactMetadata({
          request: input.request,
          environment: {
            ...input.environment,
          },
          readiness: input.readiness,
          catalog: input.catalog,
          now: input.now,
          readMetadata: input.readMetadata,
          signal,
        }),
      ).catch((error): WorkflowLiveVaultArtifactMetadataInvocationResult => {
        if (error instanceof WorkflowLiveVaultMetadataReadError) {
          return {
            allowed: false,
            code: error.code,
            message: error.message,
            reasons: [error.code === "live-vault-metadata-timeout"
              ? "metadata-read-timeout"
              : "metadata-read-failed"],
            action: integration.action,
          };
        }
        return {
          allowed: false,
          code: "live-vault-metadata-read-failed",
          message: error instanceof Error
            ? error.message
            : "Workflow live Vault metadata read failed",
          reasons: ["metadata-read-failed"],
          action: integration.action,
        };
      });

      finalResult = attemptResult;
      if (!retryableMetadataReadFailure(attemptResult) || attempts >= maxAttempts) {
        break;
      }
    }
  } finally {
    activeLiveToolReads -= 1;
  }

  const completedAt = new Date().toISOString();
  const result = finalResult ?? timeoutResult(metadataAction(input.catalog) ?? integration.action);
  recordWorkflowLiveVaultArtifactMetadataEvidence({
    store: input.store,
    request: input.request,
    result,
    startedAt,
    completedAt,
  });
  return {
    ...result,
    attempts,
    workerBinding: "executed",
  };
}
