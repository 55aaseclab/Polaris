import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AsyncFfiHost,
  FfiCallLog,
  FfiInvokeRequest,
  FfiInvokeResult,
  FfiRpcRequest,
  FfiRpcResponse,
  PortAst,
} from "polaris-workflow";
import {
  builtinCallForPort,
  DocStore,
  FFI_RPC_PROTOCOL_VERSION,
  mockRpcResponse,
  parsePortRef,
  resolvePort,
  type Program,
} from "polaris-workflow";
import type {
  WorkflowLiveVaultArtifactMetadataReader,
} from "./workflow-live-vault-adapter.js";
import {
  invokeWorkflowLiveVaultArtifactMetadataFromWorker,
} from "./workflow-live-worker-binding.js";
import { WorkflowToolDispatcher } from "./workflow-tool-dispatcher.js";
import {
  REQUIRED_WORKFLOW_LIVE_GATES,
  WORKFLOW_LIVE_ADAPTER_FLAG,
  WORKFLOW_LIVE_PROJECTION_EXECUTOR_FAMILY,
  WORKFLOW_LIVE_RELEASE_PROFILE_ID,
  WORKFLOW_LIVE_WORKER_BINDING_FLAG,
  WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
  type WorkflowActionCatalogEntry,
  type WorkflowLiveReadiness,
  type WorkflowLiveWorkerIntegrationPreconditions,
  type WorkflowLiveWorkerReleaseProfile,
} from "./workflow-live-boundary.js";
import type {
  WorkflowArtifact,
  WorkflowDomainPackProjection,
  WorkflowEffectReceipt,
  WorkflowEvent,
  WorkflowEventsResponse,
  WorkflowExecutionClass,
  WorkflowExecutionDriver,
  WorkflowMockScenario,
  WorkflowRunProjection,
  WorkflowStepResult,
  WorkflowRunRequest,
  WorkflowRunsResponse,
  WorkflowSetupProjection,
  WorkflowSetupRequest,
  WorkflowSuggestionProjection,
  WorkflowVaultProjection,
} from "@polaris/polaris-shell";
import {
  loadVerifiedDomainPackRuntime,
} from "../config/domain-packs.js";
import {
  getPolarisControlStore,
  type PolarisControlStore,
  type WorkflowRunRecord,
} from "./control-store.js";
import { isHostVaultMode } from "../config/vault-mode.js";
import { repoRoot } from "../utils/paths.js";

export class WorkflowControlError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "WorkflowControlError";
  }
}

type WorkflowControlOptions = {
  importMetaUrl: string;
  listPacks: () => WorkflowDomainPackProjection[];
  listVaults: (tenantId: string) => Promise<WorkflowVaultProjection[]>;
  now?: () => Date;
  pollMs?: number;
  autoStart?: boolean;
  liveMetadataReader?: WorkflowLiveVaultArtifactMetadataReader;
};

type ProvisionHook = (tenantId: string, vaultId: string) => void;
const provisionHooks = new Set<ProvisionHook>();

// The durable workflow tables historically require a scope ID. Host runs use
// this internal scope only for lease/idempotency bookkeeping; it is never
// returned as a Vault to the browser.
const HOST_EXECUTION_SCOPE_ID = "__polaris_host__";
const HOST_EXECUTION_SCOPE_NAME = "Polaris host";

function executionDriverForRun(
  run: Pick<WorkflowRunRecord, "executionDriver" | "policy">,
): WorkflowExecutionDriver {
  return run.executionDriver ?? (run.policy.executionDriver === "none" ? "none" : "vault");
}

function requestedExecutionDriver(input: WorkflowRunRequest): WorkflowExecutionDriver {
  const explicit = input.driver;
  if (explicit === "none" && input.vaultId?.trim()) {
    throw new WorkflowControlError(
      "driver=none cannot be combined with a Vault",
      400,
      "host-driver-vault-conflict",
    );
  }
  if (explicit === "vault" && !input.vaultId?.trim()) {
    throw new WorkflowControlError(
      "driver=vault requires a Vault",
      400,
      "vault-driver-required",
    );
  }
  const driver = explicit ?? (input.vaultId?.trim() ? "vault" : "none");
  if (driver === "vault" && isHostVaultMode()) {
    throw new WorkflowControlError(
      "POLARIS_VAULT_MODE=host disables Vault execution",
      403,
      "host-vault-mode",
    );
  }
  return driver;
}

export type WorkflowLiveMetadataAdmissionRequest = {
  operatorId: string;
  vaultId: string;
  packId: string;
  flowId: string;
  values: Record<string, string>;
  candidateLiveEnabled: boolean;
  releaseId: string;
  actionId?: string;
  dedupeKey?: string;
};

export function registerWorkflowProvisionHook(hook: ProvisionHook): () => void {
  provisionHooks.add(hook);
  return () => provisionHooks.delete(hook);
}

export function notifyWorkflowVaultProvisioned(tenantId: string, vaultId: string): void {
  for (const hook of provisionHooks) hook(tenantId, vaultId);
}

function safeInput(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [String(key), String(value ?? "")]),
  );
}

function flowFromPack(
  packs: WorkflowDomainPackProjection[],
  packId: string,
  flowId: string,
): { pack: WorkflowDomainPackProjection; flow: WorkflowDomainPackProjection["flows"][number] } | null {
  const pack = packs.find((candidate) => candidate.id === packId);
  const flow = pack?.flows.find((candidate) => candidate.id === flowId);
  return pack && flow ? { pack, flow } : null;
}

function defaultFlowInput(flow: WorkflowDomainPackProjection["flows"][number]): Record<string, string> {
  return Object.fromEntries(flow.fields.map((field) => [field.id, "synthetic provisioning input"]));
}

function portAstFromProgramPort(port: Program["ports"][number]): PortAst {
  return {
    kind: "Port",
    name: port.name,
    version: port.version,
    qualifiedName: port.qualifiedName,
    effect: port.effect as PortAst["effect"],
    ...(port.builtin ? { builtin: port.builtin } : {}),
    ...(port.binding ? { binding: port.binding } : {}),
    inFields: port.inFields.map((field) => {
      const [name, ...typeParts] = field.split(":");
      return { name: name ?? field, type: typeParts.join(":") || "String" };
    }),
    outFields: port.outFields.map((field) => {
      const [name, ...typeParts] = field.split(":");
      return { name: name ?? field, type: typeParts.join(":") || "String" };
    }),
  };
}

function programPortsAsAst(program: Program): PortAst[] {
  return program.ports.map(portAstFromProgramPort);
}

function workflowLiveAdmissionAuditId(tenantId: string, runId: string): string {
  return `workflow-live-admission:${createHash("sha256")
    .update(tenantId, "utf8")
    .update("\0", "utf8")
    .update(runId, "utf8")
    .digest("hex")}`;
}

function liveMetadataCallsForFlow(program: Program, flowId: string): Array<{
  stepId: string;
  call: string;
  port: PortAst | null;
}> {
  const flow = program.flows.find((candidate) => candidate.meta.name === flowId);
  if (!flow) return [];
  const ports = programPortsAsAst(program);
  return flow.meta.steps
    .filter((step) => step.call)
    .map((step) => {
      const ref = parsePortRef(step.call ?? "");
      const port = resolvePort(ports, ref.name, ref.version);
      return {
        stepId: step.id,
        call: step.call ?? "",
        port,
      };
    });
}

function projectionForRun(
  run: WorkflowRunRecord,
  packs: WorkflowDomainPackProjection[],
): WorkflowRunProjection {
  const driver = executionDriverForRun(run);
  const pack = packs.find((candidate) => candidate.id === run.packId);
  const flow = pack?.flows.find((candidate) => candidate.id === run.flowId);
  const artifacts: WorkflowArtifact[] = run.artifacts.map((artifact) => ({
    id: artifact.id,
    name: artifact.name,
    kind: artifact.kind,
    size: artifact.size,
    summary: artifact.summary,
    content: artifact.content,
    ...(artifact.digest ? { digest: artifact.digest } : {}),
    redacted: artifact.redacted,
  }));
  const receipts: WorkflowEffectReceipt[] = run.receipts.map((receipt) => ({
    id: receipt.id,
    requestId: receipt.requestId,
    ...(receipt.stepId ? { stepId: receipt.stepId } : {}),
    ...(receipt.stepLabel ? { stepLabel: receipt.stepLabel } : {}),
    outputFields: receipt.outputFields ?? [],
    port: receipt.port,
    version: receipt.version,
    effect: receipt.effect,
    status: receipt.status,
    input: receipt.input,
    output: receipt.output,
    ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
    ...(receipt.errorMessage ? { errorMessage: receipt.errorMessage } : {}),
    createdAt: receipt.createdAt,
    completedAt: receipt.completedAt,
  }));
  const steps: WorkflowStepResult[] = run.steps.map((step) => ({
    id: step.id,
    sequence: step.sequence,
    stepId: step.stepId,
    stepLabel: step.stepLabel,
    status: step.status,
    detail: step.detail,
    ...(step.call ? { call: step.call } : {}),
    input: step.input,
    output: step.output,
    outputFields: step.outputFields,
    createdAt: step.createdAt,
    completedAt: step.completedAt,
  }));
  const events: WorkflowEvent[] = run.events.map((event) => ({
    id: event.id,
    sequence: event.sequence,
    kind: event.kind,
    title: event.title,
    detail: event.detail,
    timestamp: event.timestamp,
    tone: event.tone,
  }));
  return {
    id: run.id,
    packId: run.packId,
    flowId: run.flowId,
    packVersion: run.packVersion,
    packDigest: run.packDigest,
    vaultId: driver === "none" ? null : run.vaultId,
    vaultName: driver === "none" ? HOST_EXECUTION_SCOPE_NAME : run.vaultName,
    driver,
    status: run.status,
    priority: run.priority,
    title: flow?.title ?? run.flowId,
    summary: flow?.summary ?? "由 Polaris 控制面调度的工作流运行",
    input: run.input,
    progress: run.progress,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    approvalRequired: run.approvalRequired,
    source: run.source,
    executionClass: run.executionClass,
    capabilityLeaseId: run.capabilityLeaseId,
    capabilityLeaseExpiresAt: run.capabilityLeaseExpiresAt,
    policy: {
      decision: run.policy.decision === "deny" ? "deny" : "allow",
      mode: run.policy.mode === "live"
        ? "live"
        : run.policy.mode === "host"
          ? "host"
          : "mock",
      reasons: Array.isArray(run.policy.reasons)
        ? run.policy.reasons.map((reason) => String(reason))
        : [],
    },
    events,
    steps,
    receipts,
    artifacts,
    ...(run.errorCode || run.errorMessage
      ? { error: { code: run.errorCode ?? "workflow-failed", message: run.errorMessage ?? "workflow failed" } }
      : {}),
  };
}

class WorkflowRpcHost implements AsyncFfiHost {
  readonly log: FfiCallLog[] = [];
  readonly rpcLog: Array<{
    request: FfiRpcRequest;
    response: FfiRpcResponse;
    evidenceRecorded?: boolean;
  }> = [];
  private readonly ports: PortAst[];
  private readonly toolDispatcher?: WorkflowToolDispatcher;
  private callSequence = 0;

  constructor(
    private readonly run: WorkflowRunRecord,
    private readonly program: Program,
    private readonly options: {
      store: PolarisControlStore;
      environment: Record<string, string | undefined>;
      now: () => Date;
      importMetaUrl: string;
      liveMetadataReader?: WorkflowLiveVaultArtifactMetadataReader;
    },
  ) {
    this.ports = programPortsAsAst(program);
    if (run.policy.mode === "host") {
      this.toolDispatcher = new WorkflowToolDispatcher(run, this.ports, {
        importMetaUrl: options.importMetaUrl,
        environment: options.environment,
      });
    }
  }

  private policyMode(): "mock" | "live" {
    return this.run.policy.mode === "live" ? "live" : "mock";
  }

  private liveRequestedFor(port: PortAst): boolean {
    return this.policyMode() === "live"
      && port.effect === "read"
      && port.version === "1.0.0"
      && (port.qualifiedName ?? port.name) === "ArtifactMetadata";
  }

  private liveReadiness(): WorkflowLiveReadiness {
    return {
      receiptReconciliation: true,
      budget: true,
      killSwitch: true,
      audit: true,
      rollback: true,
      deploymentEvidence: true,
    };
  }

  private readReleaseProfile(): WorkflowLiveWorkerReleaseProfile {
    const profilePath = path.join(
      repoRoot(import.meta.url),
      "config",
      "release-profiles",
      `${WORKFLOW_LIVE_RELEASE_PROFILE_ID}.json`,
    );
    const parsed = JSON.parse(fs.readFileSync(profilePath, "utf8")) as {
      id?: unknown;
      capacity?: {
        jobWorkerConcurrency?: unknown;
        jobLeaseMs?: unknown;
      };
      slo?: {
        readP95Ms?: unknown;
        recoverySeconds?: unknown;
      };
    };
    return {
      id: String(parsed.id ?? ""),
      capacity: {
        jobWorkerConcurrency: Number(parsed.capacity?.jobWorkerConcurrency),
        jobLeaseMs: Number(parsed.capacity?.jobLeaseMs),
      },
      slo: {
        readP95Ms: Number(parsed.slo?.readP95Ms),
        recoverySeconds: Number(parsed.slo?.recoverySeconds),
      },
    };
  }

  private livePreconditions(
    profile: WorkflowLiveWorkerReleaseProfile,
  ): WorkflowLiveWorkerIntegrationPreconditions {
    const perAttemptMs = Math.max(1, Math.floor(profile.slo.readP95Ms / 2));
    const maxTotalMs = Math.max(perAttemptMs, profile.slo.readP95Ms);
    return {
      sourceReview: true,
      workerWiring: "candidate",
      timeout: {
        perAttemptMs,
        maxTotalMs,
        abortSignal: true,
      },
      retry: {
        maxAttempts: 2,
        idempotentByRequestId: true,
        retryOnlyReadFailures: true,
      },
      budget: {
        releaseProfileId: profile.id,
        maxConcurrentLiveReads: 1,
        countsAgainstJobWorker: true,
        readP95Ms: profile.slo.readP95Ms,
      },
      killSwitch: {
        environmentFlag: WORKFLOW_LIVE_WORKER_BINDING_FLAG,
        disabledValue: "disabled",
        failClosedWhenUnset: true,
        checkedBeforeEachAttempt: true,
      },
      receiptReconciliation: {
        durableReceipts: true,
        duplicateRequestIdsReconcile: true,
        admittedFailuresPersisted: true,
      },
      audit: {
        immutableEvents: true,
        noPreAdmissionWrites: true,
      },
      rollback: {
        disablesWorkerBinding: true,
        preservesDurableEvidence: true,
      },
      deploymentEvidence: {
        releaseId: this.options.environment.POLARIS_RELEASE_ID?.trim() || "local-worker",
        profileId: profile.id,
        focusedChecks: [
          "polaris-workflow-live-boundary",
          "polaris-workflow-live-tool-gateway",
          "polaris-workflow-control",
        ],
      },
    };
  }

  private candidateMetadataAction(): WorkflowActionCatalogEntry {
    return {
      id: WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
      version: 1,
      port: "ArtifactMetadata",
      portVersion: "1.0.0",
      effect: "read",
      risk: "read",
      adapter: WORKFLOW_LIVE_PROJECTION_EXECUTOR_FAMILY,
      liveEnabled: true,
      requiredGates: REQUIRED_WORKFLOW_LIVE_GATES,
      description: "Candidate read-only Vault artifact metadata action.",
    };
  }

  private createRpcRequest(
    port: PortAst,
    req: FfiInvokeRequest,
    mode: "mock" | "live",
  ): FfiRpcRequest {
    const builtin = builtinCallForPort(port);
    const requestId = `ffi-${this.run.id}-${++this.callSequence}`;
    return {
      protocolVersion: FFI_RPC_PROTOCOL_VERSION,
      requestId,
      idempotencyKey: `${this.run.id}:${requestId}`,
      runId: this.run.id,
      tenantId: this.run.tenantId,
      vaultId: this.run.vaultId,
      pack: {
        id: this.run.packId,
        version: this.run.packVersion,
        digest: this.run.packDigest,
      },
      capabilityLease: {
        id: this.run.capabilityLeaseId,
        packDigest: this.run.packDigest,
        vaultId: this.run.vaultId,
        expiresAt: this.run.capabilityLeaseExpiresAt,
      },
      call: {
        port: port.qualifiedName ?? port.name,
        version: port.version,
        effect: port.effect,
        ...(builtin ? { builtin: builtin.id } : {}),
      },
      input: { ...req.input },
      mode,
      ...(req.meta?.stepId ? { stepId: req.meta.stepId } : {}),
      ...(this.stepLabel(req.meta?.flowName, req.meta?.stepId) ? { stepLabel: this.stepLabel(req.meta?.flowName, req.meta?.stepId) } : {}),
      outputFields: req.meta?.outputFields ?? [],
      traceId: req.meta?.flowName,
    };
  }

  private stepLabel(flowName: string | undefined, stepId: string | undefined): string | undefined {
    if (!flowName || !stepId) return undefined;
    return this.program.flows
      .find((flow) => flow.meta.name === flowName)
      ?.meta.steps.find((step) => step.id === stepId)
      ?.label;
  }

  private logRpcInvocation(input: {
    req: FfiInvokeRequest;
    request: FfiRpcRequest;
    response: FfiRpcResponse;
    evidenceRecorded?: boolean;
  }): FfiInvokeResult {
    const { req, request, response, evidenceRecorded } = input;
    this.rpcLog.push({ request, response, evidenceRecorded });
    this.log.push({
      at: response.receipt.startedAt,
      port: req.port,
      ...(req.version ? { version: req.version } : {}),
      ...(req.meta?.stepId ? { stepId: req.meta.stepId } : {}),
      ...(req.meta?.flowName ? { flowName: req.meta.flowName } : {}),
      ...(req.meta?.mode ? { mode: req.meta.mode } : {}),
      input: { ...req.input },
      output: { ...response.output },
      ok: response.status !== "failed" && response.status !== "denied",
      detail: `rpc://${request.call.port}@${request.call.version} (${response.status})`,
    });
    return {
      ok: response.status !== "failed" && response.status !== "denied",
      output: response.output,
      detail: `rpc://${request.call.port}@${request.call.version} (${response.status})`,
      ...(response.error ? { error: response.error.message } : {}),
      resolvedVersion: request.call.version,
    };
  }

  private liveMetadataResponse(input: {
    request: FfiRpcRequest;
    result: Awaited<ReturnType<typeof invokeWorkflowLiveVaultArtifactMetadataFromWorker>>;
  }): FfiRpcResponse {
    const completedAt = this.options.now().toISOString();
    if (input.result.allowed) {
      const output = {
        artifactCount: input.result.metadata.artifactCount,
        latestTitles: input.result.metadata.latestTitles.join("\n"),
        pendingMemoryChanges: input.result.metadata.pendingMemoryChanges,
      };
      return {
        protocolVersion: FFI_RPC_PROTOCOL_VERSION,
        requestId: input.request.requestId,
        status: "completed",
        output,
        receipt: {
          id: `receipt-${input.request.requestId}`,
          requestId: input.request.requestId,
          status: "completed",
          call: input.request.call,
          startedAt: completedAt,
          completedAt,
        },
      };
    }
    return {
      protocolVersion: FFI_RPC_PROTOCOL_VERSION,
      requestId: input.request.requestId,
      status: "failed",
      output: {},
      receipt: {
        id: `receipt-${input.request.requestId}`,
        requestId: input.request.requestId,
        status: "failed",
        call: input.request.call,
        startedAt: completedAt,
        completedAt,
      },
      error: {
        code: input.result.code,
        message: input.result.message,
      },
    };
  }

  has(port: string, version?: string): boolean {
    return resolvePort(this.ports, port, version) != null;
  }

  clearLog(): void {
    this.log.length = 0;
    this.rpcLog.length = 0;
  }

  invoke(req: FfiInvokeRequest): FfiInvokeResult {
    const port = resolvePort(this.ports, req.port, req.version);
    if (!port) {
      return {
        ok: false,
        output: {},
        error: `FFI port is not available: ${req.port}${req.version ? `@${req.version}` : ""}`,
      };
    }
    if (this.liveRequestedFor(port)) {
      return {
        ok: false,
        output: {},
        error: "Workflow live FFI requires async worker execution",
        resolvedVersion: port.version,
      };
    }
    return this.invokeMock(req, port);
  }

  async invokeAsync(req: FfiInvokeRequest): Promise<FfiInvokeResult> {
    const port = resolvePort(this.ports, req.port, req.version);
    if (!port) {
      return {
        ok: false,
        output: {},
        error: `FFI port is not available: ${req.port}${req.version ? `@${req.version}` : ""}`,
      };
    }
    if (!this.liveRequestedFor(port)) {
      if (this.toolDispatcher?.has(port.name)) {
        const request = this.createRpcRequest(port, req, "mock");
        const result = await this.toolDispatcher.invoke(req, port);
        const completedAt = this.options.now().toISOString();
        const response: FfiRpcResponse = {
          protocolVersion: FFI_RPC_PROTOCOL_VERSION,
          requestId: request.requestId,
          status: result.ok ? "completed" : "failed",
          output: result.output,
          receipt: {
            id: `receipt-${request.requestId}`,
            requestId: request.requestId,
            status: result.ok ? "completed" : "failed",
            call: request.call,
            startedAt: completedAt,
            completedAt,
          },
          ...(result.error
            ? { error: { code: "common-tool-failed", message: result.error } }
            : {}),
        };
        return this.logRpcInvocation({
          req,
          request,
          response,
          evidenceRecorded: result.ok,
        });
      }
      return this.invokeMock(req, port);
    }
    const request = this.createRpcRequest(port, req, "live");
    const profile = this.readReleaseProfile();
    const result = await invokeWorkflowLiveVaultArtifactMetadataFromWorker({
      store: this.options.store,
      request,
      environment: this.options.environment,
      readiness: this.liveReadiness(),
      releaseProfile: profile,
      preconditions: this.livePreconditions(profile),
      catalog: [this.candidateMetadataAction()],
      now: this.options.now(),
      readMetadata: this.options.liveMetadataReader,
    });
    return this.logRpcInvocation({
      req,
      request,
      response: this.liveMetadataResponse({ request, result }),
      evidenceRecorded: result.workerBinding === "executed",
    });
  }

  private invokeMock(req: FfiInvokeRequest, port: PortAst): FfiInvokeResult {
    const request = this.createRpcRequest(port, req, "mock");
    const response = mockRpcResponse(request);
    response.output = Object.fromEntries(port.outFields.map((field) => {
      if (field.type === "Boolean") {
        return [field.name, /pending/iu.test(field.name) ? false : true];
      }
      if (field.type === "Number" || field.type === "Money") return [field.name, 0];
      if (field.type === "ID" || /Id$/u.test(field.name)) {
        return [field.name, `${field.name}-${request.requestId}`];
      }
      return [field.name, `ffi:${port.name}@${port.version}/${field.name}`];
    }));
    if (this.run.executionDriver === "none" && port.effect === "human") {
      response.status = "completed";
      response.receipt.status = "completed";
      for (const field of port.outFields) {
        if (field.type === "Boolean" && /pending|passed|valid/iu.test(field.name)) {
          response.output[field.name] = !/pending/iu.test(field.name);
        }
      }
    }
    if (port.effect === "human" && this.run.executionDriver !== "none") {
      response.output.approved = true;
      response.output.reviewId = response.output.reviewId ?? `review-${request.requestId}`;
      response.status = "waiting";
      response.receipt.status = "waiting";
    }
    return this.logRpcInvocation({ req, request, response });
  }
}

function executionClassForProgram(program: Program, flowId: string): WorkflowExecutionClass {
  const flow = program.flows.find((candidate) => candidate.meta.name === flowId);
  if (!flow) return "ai";
  return flow.meta.steps.some((step) => Boolean(step.call)) ? "ai" : "pure";
}

function mockArtifact(run: WorkflowRunRecord, output: Record<string, unknown>): WorkflowArtifact {
  const live = run.policy.mode === "live";
  const driver = executionDriverForRun(run);
  const source = live
    ? "Polaris live workflow adapter"
    : driver === "none"
      ? "Polaris host executor"
      : "Polaris mock Vault Host";
  const content = [
    `# ${run.flowId}`,
    "",
    `Synthetic artifact from the ${source}.`,
    `run: ${run.id}`,
    `pack: ${run.packId}@${run.packVersion}`,
    `pack-digest: ${run.packDigest}`,
    `${driver === "none" ? "execution-driver: none" : `vault: ${run.vaultName}`}`,
    `output: ${JSON.stringify(output)}`,
  ].join("\n");
  return {
    id: `artifact-${run.id}`,
    name: `${run.flowId}-result.md`,
    kind: "report",
    size: `${Buffer.byteLength(content, "utf8")} B`,
    summary: live
      ? "Polaris live workflow adapter 生成的 synthetic artifact"
      : driver === "none"
        ? "Polaris host executor 生成的 synthetic artifact"
        : "mock Vault Host 生成的 synthetic artifact",
    content,
    digest: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
    redacted: false,
  };
}

export class WorkflowControlService {
  private readonly store: PolarisControlStore;
  private readonly now: () => Date;
  private readonly workerId = `workflow-${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly pollMs: number;
  private readonly autoStart: boolean;
  private timer: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly options: WorkflowControlOptions) {
    this.store = getPolarisControlStore(options.importMetaUrl);
    this.now = options.now ?? (() => new Date());
    this.pollMs = Math.max(50, Math.floor(options.pollMs ?? 250));
    this.autoStart = options.autoStart !== false;
    if (this.autoStart) {
      this.timer = setInterval(() => void this.drain(), this.pollMs);
      this.timer.unref();
      void this.drain();
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getSetup(tenantId: string): WorkflowSetupProjection {
    const setup = this.store.getWorkflowSetup(tenantId);
    return setup
      ? {
          completed: setup.completed,
          domainPackId: setup.domainPackId,
          vaultId: setup.vaultId,
          enabledWorkflowKeys: setup.enabledWorkflowKeys,
          completedAt: setup.completedAt,
        }
      : {
          completed: false,
          domainPackId: null,
          vaultId: null,
          enabledWorkflowKeys: [],
          completedAt: null,
        };
  }

  async saveSetup(tenantId: string, input: WorkflowSetupRequest): Promise<WorkflowSetupProjection> {
    const packs = this.options.listPacks();
    const pack = input.domainPackId ? packs.find((candidate) => candidate.id === input.domainPackId) : null;
    const enabledWorkflowKeys = [...new Set(
      input.enabledWorkflowKeys.map((key) => String(key).trim()).filter(Boolean),
    )];
    if (input.completed && (!pack || enabledWorkflowKeys.length === 0)) {
      throw new WorkflowControlError("首次设置需要域包和至少一个工作流", 400, "workflow-setup-incomplete");
    }
    if (input.completed) {
      if (!pack) {
        throw new WorkflowControlError("设置使用的域包不存在", 404, "workflow-pack-not-found");
      }
      if (input.vaultId?.trim()) {
        const vaults = await this.options.listVaults(tenantId);
        const vault = vaults.find((candidate) => candidate.id === input.vaultId);
        if (!vault || !vault.canRun) {
          throw new WorkflowControlError("设置使用的 Vault 当前不可运行", 409, "vault-unavailable");
        }
      }
      const invalid = enabledWorkflowKeys.some((key) => {
        const [packId, flowId] = key.split(":");
        return packId !== pack.id || !pack.flows.some((flow) => flow.id === flowId);
      });
      if (invalid) {
        throw new WorkflowControlError("设置包含未安装或不属于当前域包的工作流", 400, "workflow-not-found");
      }
    }
    const saved = this.store.saveWorkflowSetup({
      tenantId,
      completed: input.completed,
      domainPackId: input.domainPackId,
      vaultId: input.vaultId,
      enabledWorkflowKeys,
      completedAt: input.completedAt,
    });
    if (saved.completed) await this.enqueueEnabledWorkflows(tenantId);
    return {
      completed: saved.completed,
      domainPackId: saved.domainPackId,
      vaultId: saved.vaultId,
      enabledWorkflowKeys: saved.enabledWorkflowKeys,
      completedAt: saved.completedAt,
    };
  }

  async notifyProvisioned(tenantId: string, vaultId: string): Promise<void> {
    const setup = this.store.getWorkflowSetup(tenantId);
    if (!setup?.completed || setup.vaultId !== vaultId) return;
    await this.enqueueEnabledWorkflows(tenantId);
    await this.drain();
  }

  async listRuns(tenantId: string): Promise<WorkflowRunsResponse> {
    // The production worker is driven by its timer in server mode. In
    // synchronous test or maintenance mode, drain the queue before returning
    // the projection so callers observe the same state transition.
    if (this.autoStart) {
      void this.enqueueEnabledWorkflows(tenantId)
        .then(() => this.drain())
        .catch(() => undefined);
    } else {
      await this.enqueueEnabledWorkflows(tenantId);
      await this.drain();
    }
    const runs = this.store.listWorkflowRuns(tenantId).map((run) => projectionForRun(run, this.options.listPacks()));
    const events = this.store.listWorkflowRuns(tenantId).flatMap((run) => run.events);
    return {
      runs,
      replayCursor: events.reduce((cursor, event) => Math.max(cursor, event.cursor), 0),
    };
  }

  async getRun(tenantId: string, runId: string): Promise<WorkflowRunProjection> {
    const run = this.store.getWorkflowRun(tenantId, runId);
    if (!run) throw new WorkflowControlError("运行不存在", 404, "run-not-found");
    return projectionForRun(run, this.options.listPacks());
  }

  getArtifact(tenantId: string, runId: string, artifactId: string): {
    run: WorkflowRunRecord;
    artifact: WorkflowRunRecord["artifacts"][number];
  } {
    const run = this.store.getWorkflowRun(tenantId, runId);
    if (!run) throw new WorkflowControlError("运行不存在", 404, "run-not-found");
    const artifact = run.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) {
      throw new WorkflowControlError("产物不存在", 404, "artifact-not-found");
    }
    return { run, artifact };
  }

  async createRun(tenantId: string, input: WorkflowRunRequest): Promise<WorkflowRunProjection> {
    return this.createAdmittedRun(tenantId, input, "manual");
  }

  async admitLiveMetadataRun(
    tenantId: string,
    input: WorkflowLiveMetadataAdmissionRequest,
  ): Promise<WorkflowRunProjection> {
    const operatorId = input.operatorId.trim();
    const releaseId = input.releaseId.trim();
    const actionId = input.actionId?.trim() || WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID;
    if (!operatorId) {
      throw new WorkflowControlError("Live workflow admission requires an operator identity", 400, "operator-required");
    }
    if (!releaseId) {
      throw new WorkflowControlError("Live workflow admission requires a release id", 400, "release-id-required");
    }
    if (!input.candidateLiveEnabled) {
      throw new WorkflowControlError(
        "Live workflow admission requires explicit candidate acknowledgement",
        400,
        "candidate-live-ack-required",
      );
    }
    if (actionId !== WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID) {
      throw new WorkflowControlError(
        "Only vault.artifact.metadata.read can be admitted through this live path",
        400,
        "live-action-not-supported",
      );
    }
    const missingFlags = [
      WORKFLOW_LIVE_ADAPTER_FLAG,
      WORKFLOW_LIVE_WORKER_BINDING_FLAG,
    ].filter((key) => process.env[key] !== "enabled");
    if (missingFlags.length > 0) {
      throw new WorkflowControlError(
        `Live workflow admission requires ${missingFlags.map((key) => `${key}=enabled`).join(", ")}`,
        409,
        "live-deployment-disabled",
      );
    }

    const packs = this.options.listPacks();
    const selected = flowFromPack(packs, input.packId, input.flowId);
    if (!selected) throw new WorkflowControlError("工作流或流程不存在", 404, "workflow-not-found");
    const vaults = await this.options.listVaults(tenantId);
    const vault = vaults.find((candidate) => candidate.id === input.vaultId);
    if (!vault) throw new WorkflowControlError("目标 Vault 不属于当前用户", 404, "vault-not-found");
    if (!vault.canRun) {
      throw new WorkflowControlError("目标 Vault 当前不可用", 409, "vault-unavailable");
    }
    const values = safeInput(input.values);
    const missingInput = selected.flow.fields.find((field) =>
      field.required && !values[field.id]?.trim()
    );
    if (missingInput) {
      throw new WorkflowControlError(
        `Live workflow admission is missing required input: ${missingInput.id}`,
        400,
        "workflow-input-required",
      );
    }

    const runtime = this.loadPinnedRuntime(selected.pack.id, selected.pack.version, selected.pack.digest);
    const program = runtime.pipeline.program!;
    const calls = liveMetadataCallsForFlow(program, selected.flow.id);
    if (calls.length !== 1) {
      throw new WorkflowControlError(
        "Live metadata admission requires exactly one workflow tool call",
        400,
        "live-flow-call-shape-invalid",
      );
    }
    const call = calls[0]!;
    const port = call.port;
    if (
      !port
      || port.effect !== "read"
      || port.version !== "1.0.0"
      || (port.qualifiedName ?? port.name) !== "ArtifactMetadata"
    ) {
      throw new WorkflowControlError(
        "Live metadata admission accepts only ArtifactMetadata@1.0.0 read calls",
        400,
        "live-flow-call-not-supported",
      );
    }

    const executionClass = executionClassForProgram(program, selected.flow.id);
    const now = this.now();
    const leaseExpiresAt = new Date(now.getTime() + 30 * 60_000).toISOString();
    const run = this.store.createWorkflowRun({
      tenantId,
      vaultId: vault.id,
      vaultName: vault.name,
      packId: selected.pack.id,
      packVersion: selected.pack.version,
      packDigest: selected.pack.digest,
      flowId: selected.flow.id,
      source: "manual",
      priority: "normal",
      input: values,
      approvalRequired: false,
      executionClass,
      executionDriver: "vault",
      capabilityLease: {
        capabilities: [WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID],
        expiresAt: leaseExpiresAt,
      },
      policy: {
        decision: "allow",
        mode: "live",
        reasons: [
          "operator-live-admission",
          "candidate-live-metadata",
          "pack-digest-pinned",
          "vault-capability-lease",
          `release:${releaseId}`,
        ],
      },
      dedupeKey: input.dedupeKey?.trim()
        || `workflow-live-metadata-admission:${tenantId}:${randomUUID()}`,
      event: {
        kind: "submitted",
        title: "Live metadata workflow admitted",
        detail: `Operator ${operatorId} admitted ${WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID}.`,
        tone: "accent",
      },
    });
    this.store.recordAuditOnce({
      id: workflowLiveAdmissionAuditId(tenantId, run.id),
      actorId: operatorId,
      tenantId,
      vaultId: vault.id,
      action: "workflow.live.admit",
      requestId: run.id,
      outcome: "success",
      metadata: {
        runId: run.id,
        actionId: WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
        packId: selected.pack.id,
        packVersion: selected.pack.version,
        packDigest: selected.pack.digest,
        flowId: selected.flow.id,
        call: call.call,
        releaseId,
        policyMode: "live",
      },
    });
    if (this.autoStart) void this.drain();
    return projectionForRun(run, packs);
  }

  private async createAdmittedRun(
    tenantId: string,
    input: WorkflowRunRequest,
    source: "manual" | "retry",
  ): Promise<WorkflowRunProjection> {
    const packs = this.options.listPacks();
    const selected = flowFromPack(packs, input.packId, input.flowId);
    if (!selected) throw new WorkflowControlError("工作流或流程不存在", 404, "workflow-not-found");
    const driver = requestedExecutionDriver(input);
    let vaultId = HOST_EXECUTION_SCOPE_ID;
    let vaultName = HOST_EXECUTION_SCOPE_NAME;
    if (driver === "vault") {
      const requestedVaultId = input.vaultId?.trim() || "";
      const vaults = await this.options.listVaults(tenantId);
      const vault = vaults.find((candidate) => candidate.id === requestedVaultId);
      if (!vault) throw new WorkflowControlError("目标 Vault 不属于当前用户", 404, "vault-not-found");
      if (input.scenario === "vault-unavailable" || !vault.canRun) {
        throw new WorkflowControlError("目标 Vault 当前不可用", 409, "vault-unavailable");
      }
      vaultId = vault.id;
      vaultName = vault.name;
    }
    if (input.scenario === "quota-denied") {
      throw new WorkflowControlError(
        driver === "none" ? "当前 host 工作流配额已用尽" : "当前 Vault 的工作流配额已用尽",
        429,
        "quota-denied",
      );
    }
    const values = safeInput(input.values);
    const missingInput = selected.flow.fields.find((field) =>
      field.required && !values[field.id]?.trim()
    );
    if (missingInput) {
      throw new WorkflowControlError(
        `工作流缺少必填输入：${missingInput.id}`,
        400,
        "workflow-input-required",
      );
    }
    const runtime = this.loadPinnedRuntime(selected.pack.id, selected.pack.version, selected.pack.digest);
    const executionClass = executionClassForProgram(runtime.pipeline.program!, selected.flow.id);
    const now = this.now();
    const leaseExpiresAt = new Date(now.getTime() + 30 * 60_000).toISOString();
    const run = this.store.createWorkflowRun({
      tenantId,
      vaultId,
      vaultName,
      packId: selected.pack.id,
      packVersion: selected.pack.version,
      packDigest: selected.pack.digest,
      flowId: selected.flow.id,
      source,
      input: values,
      approvalRequired: selected.flow.approvalRequired,
      executionClass,
      executionDriver: driver,
      scenario: input.scenario ?? "normal",
      capabilityLease: {
        capabilities: selected.pack.capabilities,
        expiresAt: leaseExpiresAt,
      },
      policy: {
        decision: "allow",
        mode: driver === "none" ? "host" : "mock",
        executionDriver: driver,
        reasons: driver === "none"
          ? [
              "pack-digest-pinned",
              "host-execution",
              "flow-program",
            ]
          : ["pack-digest-pinned", "vault-capability-lease", "mock-host-only"],
      },
      dedupeKey: `workflow-manual:${tenantId}:${randomUUID()}`,
      event: {
        kind: "submitted",
        title: "已提交到执行队列",
        detail: driver === "none"
          ? `已固定 ${selected.pack.title}@${selected.pack.version} · Polaris host`
          : `已固定 ${selected.pack.title}@${selected.pack.version} · ${vaultName}`,
        tone: "neutral",
      },
    });
    if (this.autoStart) void this.drain();
    return projectionForRun(run, packs);
  }

  async approve(tenantId: string, runId: string): Promise<WorkflowRunProjection> {
    const run = this.store.getWorkflowRun(tenantId, runId);
    if (!run) throw new WorkflowControlError("运行不存在", 404, "run-not-found");
    if (run.status !== "waiting") {
      throw new WorkflowControlError("当前运行不在等待确认状态", 409, "approval-not-available");
    }
    const updated = this.store.updateWorkflowRun({
      tenantId,
      runId,
      status: "running",
      progress: Math.max(80, run.progress),
      output: { ...run.output, approvalGranted: true },
      event: {
        kind: "approved",
        title: "已批准继续运行",
        detail: "当前用户确认了下一步产出。",
        tone: "accent",
      },
    });
    if (this.autoStart) void this.drain();
    return projectionForRun(updated, this.options.listPacks());
  }

  async cancel(tenantId: string, runId: string): Promise<WorkflowRunProjection> {
    const updated = this.store.requestWorkflowCancellation(tenantId, runId);
    if (!updated) {
      const existing = this.store.getWorkflowRun(tenantId, runId);
      if (!existing) throw new WorkflowControlError("运行不存在", 404, "run-not-found");
      throw new WorkflowControlError("当前运行不可取消", 409, "cancel-not-available");
    }
    return projectionForRun(updated, this.options.listPacks());
  }

  async deleteRun(tenantId: string, runId: string): Promise<void> {
    const result = this.store.deleteWorkflowRun(tenantId, runId);
    if (result === "missing") {
      throw new WorkflowControlError("运行不存在", 404, "run-not-found");
    }
    if (result === "active") {
      throw new WorkflowControlError("运行完成后才可以删除", 409, "delete-not-available");
    }
  }

  async retry(tenantId: string, runId: string, scenario: WorkflowMockScenario = "normal"): Promise<WorkflowRunProjection> {
    const previous = this.store.getWorkflowRun(tenantId, runId);
    if (!previous) throw new WorkflowControlError("运行不存在", 404, "run-not-found");
    if (previous.status !== "failed" && previous.status !== "cancelled") {
      throw new WorkflowControlError("只有失败或取消的运行可以重试", 409, "retry-not-available");
    }
    const driver = executionDriverForRun(previous);
    const next = await this.createAdmittedRun(tenantId, {
      packId: previous.packId,
      flowId: previous.flowId,
      ...(driver === "vault" ? { vaultId: previous.vaultId, driver } : { driver }),
      values: previous.input,
      scenario,
    }, "retry");
    return next;
  }

  async events(tenantId: string, runId: string, after = 0): Promise<WorkflowEventsResponse> {
    const run = this.store.getWorkflowRun(tenantId, runId);
    if (!run) throw new WorkflowControlError("运行不存在", 404, "run-not-found");
    const replay = this.store.listWorkflowEvents(tenantId, runId, after);
    return {
      runId,
      events: replay.events.map((event) => ({
        id: event.id,
        sequence: event.sequence,
        kind: event.kind,
        title: event.title,
        detail: event.detail,
        timestamp: event.timestamp,
        tone: event.tone,
      })),
      nextCursor: replay.nextCursor,
    };
  }

  async createSuggestion(tenantId: string, runId: string): Promise<WorkflowSuggestionProjection> {
    const run = this.store.getWorkflowRun(tenantId, runId);
    if (!run) throw new WorkflowControlError("运行不存在", 404, "run-not-found");
    if (run.status !== "succeeded") {
      throw new WorkflowControlError("只有成功运行可以生成 workflow draft", 409, "suggestion-not-ready");
    }
    const suggestion = this.store.createWorkflowSuggestion({
      tenantId,
      sourceRunId: run.id,
      packId: run.packId,
      flowId: run.flowId,
      status: "suggested",
      draft: {
        kind: "workflow-draft",
        source: "server-confirmed-workflow-run",
        pack: { id: run.packId, version: run.packVersion, digest: run.packDigest },
        flowId: run.flowId,
        calls: run.receipts.map((receipt) => `${receipt.port}@${receipt.version}`),
      },
      evidence: [run.id, ...run.events.map((event) => event.id)],
    });
    return {
      id: suggestion.id,
      sourceRunId: suggestion.sourceRunId,
      packId: suggestion.packId,
      flowId: suggestion.flowId,
      status: suggestion.status,
      draft: suggestion.draft,
      evidence: suggestion.evidence,
      createdAt: suggestion.createdAt,
      updatedAt: suggestion.updatedAt,
    };
  }

  listSuggestions(tenantId: string): WorkflowSuggestionProjection[] {
    return this.store.listWorkflowSuggestions(tenantId).map((suggestion) => ({
      id: suggestion.id,
      sourceRunId: suggestion.sourceRunId,
      packId: suggestion.packId,
      flowId: suggestion.flowId,
      status: suggestion.status,
      draft: suggestion.draft,
      evidence: suggestion.evidence,
      createdAt: suggestion.createdAt,
      updatedAt: suggestion.updatedAt,
    }));
  }

  private loadPinnedRuntime(packId: string, packVersion: string, packDigest: string) {
    try {
      return loadVerifiedDomainPackRuntime(
        this.options.importMetaUrl,
        packId,
        packVersion,
        packDigest,
      );
    } catch (error) {
      throw new WorkflowControlError(
        error instanceof Error ? error.message : "固定的 Domain Pack 不可用",
        409,
        "pack-pin-unavailable",
      );
    }
  }

  private async enqueueEnabledWorkflows(tenantId: string): Promise<void> {
    const setup = this.store.getWorkflowSetup(tenantId);
    if (!setup?.completed || !setup.domainPackId || !setup.vaultId) return;
    const packs = this.options.listPacks();
    const pack = packs.find((candidate) => candidate.id === setup.domainPackId);
    if (!pack) return;
    let vault: WorkflowVaultProjection | undefined;
    try {
      vault = (await this.options.listVaults(tenantId)).find((candidate) => candidate.id === setup.vaultId);
    } catch {
      // Provisioning is an optional side effect of a previously configured
      // Vault. It must not make the host-first work desk unavailable while
      // that Vault is stopped, being repaired, or temporarily unobservable.
      return;
    }
    if (!vault?.canRun) return;
    const existing = this.store.listWorkflowRuns(tenantId);
    for (const key of setup.enabledWorkflowKeys) {
      const [, flowId] = key.split(":");
      const flow = pack.flows.find((candidate) => candidate.id === flowId);
      if (!flow) continue;
      if (existing.some((run) => run.source === "provisioning" && run.packDigest === pack.digest && run.flowId === flow.id && run.vaultId === vault.id)) {
        continue;
      }
      const runtime = this.loadPinnedRuntime(pack.id, pack.version, pack.digest);
      const executionClass = executionClassForProgram(runtime.pipeline.program!, flow.id);
      const now = this.now();
      const created = this.store.createWorkflowRun({
        tenantId,
        vaultId: vault.id,
        vaultName: vault.name,
        packId: pack.id,
        packVersion: pack.version,
        packDigest: pack.digest,
        flowId: flow.id,
        source: "provisioning",
        priority: flow.approvalRequired ? "urgent" : "normal",
        input: defaultFlowInput(flow),
        approvalRequired: flow.approvalRequired,
        executionClass,
        executionDriver: "vault",
        capabilityLease: {
          capabilities: pack.capabilities,
          expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
        },
        policy: {
          decision: "allow",
          mode: "mock",
          reasons: ["pack-digest-pinned", "vault-capability-lease", "provisioning-enqueue", "mock-host-only"],
        },
        dedupeKey: `workflow-provisioning:${tenantId}:${pack.id}:${pack.version}:${pack.digest}:${flow.id}:${vault.id}`,
        event: {
          kind: "submitted",
          title: "已由首次设置加入执行队列",
          detail: `已固定 ${pack.title}@${pack.version} · ${vault.name}`,
          tone: "neutral",
        },
      });
      existing.push(created);
    }
  }

  private async drain(): Promise<void> {
    if (this.closed) return;
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = (async () => {
      for (;;) {
        if (this.closed) return;
        const run = this.store.claimWorkflowRun(this.workerId);
        if (!run) return;
        try {
          await this.execute(run);
        } catch (error) {
          this.fail(
            run,
            "workflow-worker-error",
            error instanceof Error ? error.message : "workflow worker failed unexpectedly",
          );
        }
      }
    })().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  private async execute(run: WorkflowRunRecord): Promise<void> {
    const driver = executionDriverForRun(run);
    const lease = this.store.getWorkflowCapabilityLease(run.tenantId, run.capabilityLeaseId);
    if (!lease || lease.status !== "active" || lease.packDigest !== run.packDigest || lease.vaultId !== run.vaultId) {
      this.fail(
        run,
        "capability-lease-invalid",
        driver === "none" ? "运行没有有效的 host capability lease" : "运行没有有效的 Vault capability lease",
      );
      return;
    }
    if (driver === "vault") {
      const vault = (await this.options.listVaults(run.tenantId)).find((candidate) => candidate.id === run.vaultId);
      if (!vault?.canRun) {
        this.fail(run, "vault-unavailable", "执行前 Vault admission recheck 失败");
        return;
      }
    }
    if (run.scenario === "executor-failure") {
      this.fail(run, "executor-failure", "mock Vault Host 报告了一个可重试错误");
      return;
    }
    if (this.store.getWorkflowRun(run.tenantId, run.id)?.status === "cancelled") return;
    let runtime;
    try {
      runtime = this.loadPinnedRuntime(run.packId, run.packVersion, run.packDigest);
    } catch (error) {
      this.fail(
        run,
        "pack-pin-unavailable",
        error instanceof Error ? error.message : "固定的 Domain Pack 不可用",
      );
      return;
    }
    const program = runtime.pipeline.program!;
    const host = new WorkflowRpcHost(run, program, {
      store: this.store,
      environment: process.env,
      now: this.now,
      importMetaUrl: this.options.importMetaUrl,
      liveMetadataReader: this.options.liveMetadataReader,
    });
    const docStore = new DocStore();
    const result = await program.runAsync(run.flowId, run.input, docStore, host);
    const completedAt = this.now().toISOString();
    for (const [index, step] of result.stepLog.entries()) {
      this.store.recordWorkflowStepResult({
        id: `step-${run.id}-${index + 1}`,
        sequence: index + 1,
        runId: run.id,
        tenantId: run.tenantId,
        stepId: step.id,
        stepLabel: step.label,
        status: step.ok ? "completed" : "failed",
        detail: step.detail ?? "",
        ...(step.call ? { call: step.call } : {}),
        input: step.used ?? {},
        output: step.produced ?? {},
        outputFields: Object.keys(step.produced ?? {}),
        createdAt: completedAt,
        completedAt,
      });
    }
    for (const entry of host.rpcLog) {
      if (entry.request.mode === "live") {
        continue;
      }
      const receipt = entry.response.receipt;
      this.store.recordWorkflowEffectReceipt({
        id: receipt.id,
        runId: run.id,
        tenantId: run.tenantId,
        requestId: receipt.requestId,
        ...(entry.request.stepId ? { stepId: entry.request.stepId } : {}),
        ...(entry.request.stepLabel ? { stepLabel: entry.request.stepLabel } : {}),
        outputFields: entry.request.outputFields ?? [],
        port: receipt.call.port,
        version: receipt.call.version,
        effect: receipt.call.effect,
        status: receipt.status,
        input: entry.request.input,
        output: entry.response.output,
        ...(entry.response.error ? { errorCode: entry.response.error.code, errorMessage: entry.response.error.message } : {}),
        createdAt: receipt.startedAt,
        completedAt: receipt.completedAt,
      });
    }
    if (!result.ok) {
      this.fail(run, "workflow-execution-failed", result.message);
      return;
    }
    const requiresApproval = run.approvalRequired && run.output.approvalGranted !== true;
    if (requiresApproval) {
      this.store.updateWorkflowRun({
        tenantId: run.tenantId,
        runId: run.id,
        status: "waiting",
        progress: 76,
        workerId: this.workerId,
        output: result.outputs ?? {},
        event: {
          kind: "approval-required",
          title: "等待人工确认",
          detail: "mock FFI 已准备结果，下一步需要用户处理卡片。",
          tone: "warning",
        },
      });
      return;
    }
    const artifact = mockArtifact(run, result.outputs ?? {});
    this.store.addWorkflowArtifact({
      ...artifact,
      runId: run.id,
      tenantId: run.tenantId,
      redacted: false,
      createdAt: this.now().toISOString(),
    });
    this.store.updateWorkflowRun({
      tenantId: run.tenantId,
      runId: run.id,
      status: "succeeded",
      progress: 100,
      workerId: this.workerId,
      output: result.outputs ?? {},
      event: {
        kind: "succeeded",
        title: "最终产物已生成",
      detail: executionDriverForRun(run) === "none"
        ? "Polaris host executor 已生成 synthetic artifact。"
        : "mock Vault Host 已生成 synthetic artifact。",
        tone: "success",
      },
    });
  }

  private fail(run: WorkflowRunRecord, code: string, message: string): void {
    try {
      const current = this.store.getWorkflowRun(run.tenantId, run.id);
      if (!current || current.status === "cancelled") return;
      this.store.updateWorkflowRun({
        tenantId: run.tenantId,
        runId: run.id,
        status: "failed",
        progress: run.progress,
        workerId: this.workerId,
        errorCode: code,
        errorMessage: message,
        event: {
          kind: "failed",
          title: "工作流执行失败",
          detail: message,
          tone: "warning",
        },
      });
    } catch {
      // The run lease may have expired; the recovery pass will reconcile it.
    }
  }
}
