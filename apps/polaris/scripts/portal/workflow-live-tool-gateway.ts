import {
  createHash,
} from "node:crypto";
import type { FfiRpcRequest } from "polaris-workflow";
import type {
  PolarisControlStore,
  WorkflowEffectReceiptRecord,
} from "./control-store.js";
import {
  evaluateWorkflowLiveInvocation,
  type EvaluateWorkflowLiveInvocationInput,
  type WorkflowActionCatalogEntry,
  type WorkflowLiveInvocationDecision,
} from "./workflow-live-boundary.js";

export class WorkflowLiveToolExecutionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "WorkflowLiveToolExecutionError";
  }
}

export interface WorkflowLiveToolExecutorInput {
  request: FfiRpcRequest;
  action: WorkflowActionCatalogEntry;
  decision: Extract<WorkflowLiveInvocationDecision, { allowed: true }>;
  signal?: AbortSignal;
}

export type WorkflowLiveToolExecutor = (
  input: WorkflowLiveToolExecutorInput,
) => Promise<unknown> | unknown;

export type WorkflowLiveToolInvocationResult<TOutput> =
  | {
      allowed: true;
      action: WorkflowActionCatalogEntry;
      reasons: string[];
      output: TOutput;
    }
  | {
      allowed: false;
      code: string;
      message: string;
      reasons: string[];
      action?: WorkflowActionCatalogEntry;
    };

export interface WorkflowLiveToolDefinition<TOutput> {
  actionId: string;
  executorFamily: WorkflowActionCatalogEntry["adapter"];
  auditAction: string;
  auditIdPrefix?: string;
  auditId?: (request: FfiRpcRequest) => string;
  failureReason: string;
  timeoutReason: string;
  execute: WorkflowLiveToolExecutor;
  normalize: (value: unknown) => TOutput;
  receiptOutput: (output: TOutput) => Record<string, unknown>;
  auditMetadata?: (output: TOutput) => Record<string, unknown>;
  unsupportedActionCode?: string;
  unsupportedActionMessage?: string;
  unsupportedActionReason?: string;
  readFailedCode?: string;
  readFailedMessage?: string;
}

export interface WorkflowLiveToolInvocationInput<TOutput>
  extends EvaluateWorkflowLiveInvocationInput {
  tool: WorkflowLiveToolDefinition<TOutput>;
  execute?: WorkflowLiveToolExecutor;
  signal?: AbortSignal;
}

export interface WorkflowLiveToolDurableEvidenceInput<TOutput>
  extends WorkflowLiveToolInvocationInput<TOutput> {
  store: PolarisControlStore;
}

export async function invokeWorkflowLiveTool<TOutput>(
  input: WorkflowLiveToolInvocationInput<TOutput>,
): Promise<WorkflowLiveToolInvocationResult<TOutput>> {
  const decision = evaluateWorkflowLiveInvocation(input);
  if (!decision.allowed) {
    return decision;
  }
  const action = decision.action;
  if (
    action.id !== input.tool.actionId
    || action.adapter !== input.tool.executorFamily
  ) {
    return {
      allowed: false,
      code: input.tool.unsupportedActionCode ?? "workflow-live-tool-action-required",
      message: input.tool.unsupportedActionMessage
        ?? "Workflow live tool gateway received an unsupported action",
      reasons: [input.tool.unsupportedActionReason ?? "tool-action-required"],
      action,
    };
  }
  try {
    const execute = input.execute ?? input.tool.execute;
    const output = input.tool.normalize(
      await execute({
        request: input.request,
        action,
        decision,
        signal: input.signal,
      }),
    );
    return {
      allowed: true,
      action,
      reasons: decision.reasons,
      output,
    };
  } catch (error) {
    return {
      allowed: false,
      code: error instanceof WorkflowLiveToolExecutionError
        ? error.code
        : input.tool.readFailedCode ?? "workflow-live-tool-execution-failed",
      message: error instanceof Error
        ? error.message
        : input.tool.readFailedMessage ?? "Workflow live tool execution failed",
      reasons: [input.tool.failureReason],
      action,
    };
  }
}

function outputDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex")}`;
}

function auditIdForToolInvocation<TOutput>(
  request: FfiRpcRequest,
  tool: WorkflowLiveToolDefinition<TOutput>,
): string {
  if (tool.auditId) return tool.auditId(request);
  return `${tool.auditIdPrefix ?? "workflow-live-tool"}:${createHash("sha256")
    .update(tool.auditAction, "utf8")
    .update("\0", "utf8")
    .update(request.tenantId, "utf8")
    .update("\0", "utf8")
    .update(request.runId, "utf8")
    .update("\0", "utf8")
    .update(request.requestId, "utf8")
    .digest("hex")}`;
}

function receiptForToolInvocation<TOutput>(input: {
  request: FfiRpcRequest;
  tool: WorkflowLiveToolDefinition<TOutput>;
  result: WorkflowLiveToolInvocationResult<TOutput>;
  startedAt: string;
  completedAt: string;
}): WorkflowEffectReceiptRecord {
  const status = input.result.allowed ? "completed" : "failed";
  return {
    id: `receipt-${input.request.requestId}`,
    runId: input.request.runId,
    tenantId: input.request.tenantId,
    requestId: input.request.requestId,
    port: input.request.call.port,
    version: input.request.call.version,
    effect: input.request.call.effect,
    status,
    input: input.request.input,
    output: input.result.allowed ? input.tool.receiptOutput(input.result.output) : {},
    ...(!input.result.allowed
      ? {
        errorCode: input.result.code,
        errorMessage: input.result.message,
      }
      : {}),
    createdAt: input.startedAt,
    completedAt: input.completedAt,
  };
}

export function shouldRecordWorkflowLiveToolEvidence<TOutput>(input: {
  tool: WorkflowLiveToolDefinition<TOutput>;
  result: WorkflowLiveToolInvocationResult<TOutput>;
}): boolean {
  const { tool, result } = input;
  return result.allowed
    || (
      !result.allowed
      && result.action?.id === tool.actionId
      && (
        result.reasons.includes(tool.failureReason)
        || result.reasons.includes(tool.timeoutReason)
      )
    );
}

export function recordWorkflowLiveToolEvidence<TOutput>(input: {
  store: PolarisControlStore;
  request: FfiRpcRequest;
  tool: WorkflowLiveToolDefinition<TOutput>;
  result: WorkflowLiveToolInvocationResult<TOutput>;
  startedAt: string;
  completedAt: string;
}): void {
  if (!shouldRecordWorkflowLiveToolEvidence({
    tool: input.tool,
    result: input.result,
  })) {
    return;
  }
  input.store.recordWorkflowEffectReceipt(
    receiptForToolInvocation({
      request: input.request,
      tool: input.tool,
      result: input.result,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
    }),
  );
  input.store.recordAuditOnce({
    id: auditIdForToolInvocation(input.request, input.tool),
    actorId: input.request.tenantId,
    tenantId: input.request.tenantId,
    vaultId: input.request.vaultId,
    action: input.tool.auditAction,
    requestId: input.request.requestId,
    outcome: input.result.allowed ? "success" : "failure",
    metadata: {
      action: input.result.action?.id ?? input.tool.actionId,
      port: input.request.call.port,
      version: input.request.call.version,
      effect: input.request.call.effect,
      executorFamily: input.tool.executorFamily,
      runId: input.request.runId,
      idempotencyKey: input.request.idempotencyKey,
      reasons: input.result.reasons,
      ...(input.result.allowed
        ? {
          outputDigest: outputDigest(input.result.output),
          ...(input.tool.auditMetadata?.(input.result.output) ?? {}),
        }
        : { errorCode: input.result.code }),
    },
  });
}

export async function invokeWorkflowLiveToolWithEvidence<TOutput>(
  input: WorkflowLiveToolDurableEvidenceInput<TOutput>,
): Promise<WorkflowLiveToolInvocationResult<TOutput>> {
  const startedAt = new Date().toISOString();
  const result = await invokeWorkflowLiveTool(input);
  const completedAt = new Date().toISOString();
  recordWorkflowLiveToolEvidence({
    store: input.store,
    request: input.request,
    tool: input.tool,
    result,
    startedAt,
    completedAt,
  });
  return result;
}
