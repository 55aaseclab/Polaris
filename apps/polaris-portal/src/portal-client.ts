import { portalHref } from "./portal-path.js";
import {
  type ShellHostSummary,
  type ShellWorkspace,
} from "@polaris/polaris-shell";
import type {
  WorkflowDomainPackProjection,
  WorkflowGraphProjection,
  WorkflowEventsResponse,
  WorkflowMockScenario,
  WorkflowRunProjection,
  WorkflowRunRequest,
  WorkflowRunsResponse,
  WorkflowSetupProjection,
  WorkflowSetupRequest,
  WorkflowSuggestionProjection,
  WorkflowVaultProjection,
} from "@polaris/polaris-shell";
import { localizedError } from "./i18n/messages.js";

export interface PortalCredential {
  id: string;
  label: string;
  kind: string;
  status: string;
}

export interface PortalRequestError extends Error {
  status: number;
  code?: string;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (init?.method && !["GET", "HEAD"].includes(init.method.toUpperCase())) throw new Error("Read-only portal");
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(portalHref(`/api${path}`), { ...init, headers, credentials: "same-origin" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const bodyError = typeof body.error === "object" && body.error !== null ? body.error : null;
    const message = typeof body.error === "string" ? body.error : bodyError?.message;
    const code = typeof body.errorCode === "string" ? body.errorCode : bodyError?.code;
    const error: PortalRequestError = typeof message === "string"
      ? Object.assign(new Error(message), { status: response.status, ...(code ? { code } : {}) })
      : Object.assign(
        localizedError("common.requestFailed", { status: response.status }),
        { status: response.status },
      );
    throw error;
  }
  return body as T;
}

export async function domainPacks(): Promise<{ packs: WorkflowDomainPackProjection[] }> {
  return request<{ packs: WorkflowDomainPackProjection[] }>("/domain-packs");
}

export type PortalToolFinding = {
  toolId: string;
  type: "env" | "command" | "python" | "file" | "lock" | "setup";
  key: string;
  kind: "required" | "recommended";
  status?: "ok" | "missing";
  reason: string;
  next?: string;
};

export type PortalToolStatus = {
  id: string;
  entrypoint: string;
  commands: string[];
  capabilities: string[];
  lockPath: string;
  checkSetupPath: string;
  readiness: "ready" | "warning" | "blocked";
  prerequisites: {
    env: Array<{ key: string; kind: "required" | "recommended"; reason: string }>;
    commands: Array<{ name: string; kind: "required" | "recommended"; reason: string }>;
    files: Array<{ path: string; kind: "required" | "recommended"; reason: string }>;
    python?: { minimum_version: string; requirements: string[] };
  };
  checkSetup: {
    ok: boolean;
    lines: string[];
    checked?: PortalToolFinding[];
  };
  missingRequired: PortalToolFinding[];
  missingRecommended: PortalToolFinding[];
};

export type PortalToolStatusReport = {
  ok: boolean;
  ready: number;
  warning: number;
  blocked: number;
  tools: PortalToolStatus[];
};

export async function portalTools(): Promise<PortalToolStatusReport> {
  return request<PortalToolStatusReport>("/tools");
}

export async function workflowGraph(
  packId: string,
  flowId: string,
): Promise<{ graph: WorkflowGraphProjection }> {
  return request<{ graph: WorkflowGraphProjection }>(
    `/domain-packs/${encodeURIComponent(packId)}/${encodeURIComponent(flowId)}/graph`,
  );
}

export async function workflowVaults(): Promise<{ vaults: WorkflowVaultProjection[] }> {
  return request<{ vaults: WorkflowVaultProjection[] }>("/workflow-vaults");
}

export async function workflowRuns(): Promise<WorkflowRunsResponse> {
  return request<WorkflowRunsResponse>("/workflow-runs");
}

export async function workflowSetup(): Promise<WorkflowSetupProjection> {
  return request<WorkflowSetupProjection>("/workflow-setup");
}

export async function saveWorkflowSetup(
  input: WorkflowSetupRequest,
): Promise<{ setup: WorkflowSetupProjection }> {
  return request<{ setup: WorkflowSetupProjection }>("/workflow-setup", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function workflowSuggestions(): Promise<{ suggestions: WorkflowSuggestionProjection[] }> {
  return request<{ suggestions: WorkflowSuggestionProjection[] }>("/workflow-suggestions");
}

export async function createWorkflowSuggestion(
  runId: string,
): Promise<{ suggestion: WorkflowSuggestionProjection }> {
  return request<{ suggestion: WorkflowSuggestionProjection }>("/workflow-suggestions", {
    method: "POST",
    body: JSON.stringify({ runId }),
  });
}

export async function createWorkflowRun(
  input: WorkflowRunRequest,
): Promise<{ run: WorkflowRunProjection }> {
  return request<{ run: WorkflowRunProjection }>("/workflow-runs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function workflowRunAction(
  runId: string,
  action: "approve" | "cancel" | "retry",
  scenario?: WorkflowMockScenario,
): Promise<{ run: WorkflowRunProjection }> {
  return request<{ run: WorkflowRunProjection }>(
    `/workflow-runs/${encodeURIComponent(runId)}/${action}`,
    {
      method: "POST",
      ...(scenario ? { body: JSON.stringify({ scenario }) } : {}),
    },
  );
}

export async function deleteWorkflowRun(runId: string): Promise<void> {
  await request<void>(`/workflow-runs/${encodeURIComponent(runId)}`, {
    method: "DELETE",
  });
}

export async function workflowRunEvents(
  runId: string,
  after = 0,
): Promise<WorkflowEventsResponse> {
  return request<WorkflowEventsResponse>(
    `/workflow-runs/${encodeURIComponent(runId)}/events?after=${after}`,
  );
}

export function streamUrl(): string {
  return portalHref("/api/workspace/vaults/live");
}

export type { ShellHostSummary, ShellWorkspace };
