import type { SwitchResult } from "../cli/commands/switch.js";
import type { ManagedHarness } from "../config/credential-catalog.js";
import type {
  PortalDriverTarget,
  PortalProvisionProgress,
  PortalWorkspaceDetail,
} from "../core/portal.js";
import type { WorkspaceStatus } from "../core/workspace.js";
import {
  healthCheckPortalWorkspaceExecutor,
} from "./operations.js";

function executorBaseUrl(): string | null {
  const raw = process.env.POLARIS_EXECUTOR_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

function executorHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const secret = process.env.POLARIS_EXECUTOR_SHARED_SECRET?.trim();
  if (secret) {
    headers["x-polaris-executor-secret"] = secret;
  }
  return headers;
}

function describeExecutorEndpointFailure(
  baseUrl: string,
  pathname: string,
  response: Response,
  responseBody: string,
): string {
  if (response.status === 404) {
    return [
      `Polaris executor endpoint '${baseUrl}${pathname}' returned 404.`,
      "The configured POLARIS_EXECUTOR_BASE_URL does not appear to be a Polaris executor.",
      `Response body: ${responseBody}`,
    ].join(" ");
  }
  if (response.status === 403) {
    return [
      `Polaris executor endpoint '${baseUrl}${pathname}' rejected the request with 403.`,
      "Check POLARIS_EXECUTOR_SHARED_SECRET on both the portal and executor processes.",
      `Response body: ${responseBody}`,
    ].join(" ");
  }
  return `Polaris executor request failed (${response.status} ${response.statusText}) for ${pathname}: ${responseBody}`;
}

async function executorRequest<T>(
  pathname: string,
  init: RequestInit,
): Promise<T> {
  const baseUrl = executorBaseUrl();
  if (!baseUrl) {
    throw new Error(
      `POLARIS_EXECUTOR_BASE_URL is required for executor request ${pathname}`,
    );
  }
  let response: Response;
  try {
    await healthCheckPortalWorkspaceExecutor(baseUrl, executorHeaders());
    response = await fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        ...executorHeaders(),
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : error instanceof Error
        ? error.message
        : String(error);
    throw new Error(
      `Polaris executor request failed for ${baseUrl}${pathname}: ${cause}`,
    );
  }
  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      describeExecutorEndpointFailure(baseUrl, pathname, response, responseBody),
    );
  }
  return (await response.json()) as T;
}

export async function queueProvisionWorkspace(input: {
  userId: string;
  workspace: string;
  defaultDockerOnly?: boolean;
  startAfterCreate?: boolean;
}): Promise<PortalProvisionProgress> {
  return executorRequest(
    "/workspaces/provision",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function refreshPortalWorkspaceStatus(input: {
  userId: string;
  workspace: string;
}): Promise<{ refreshed: true }> {
  return executorRequest(
    "/workspaces/status/refresh",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function cancelProvisionWorkspace(input: {
  userId: string;
  workspace: string;
}): Promise<PortalProvisionProgress> {
  return executorRequest(
    "/workspaces/provision/cancel",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function reportPortalWorkspaceStatus(input: {
  userId: string;
  workspace: string;
  status: Partial<WorkspaceStatus>;
}): Promise<{ reported: true }> {
  return executorRequest(
    "/workspaces/status/report",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function switchPortalWorkspace(input: {
  userId: string;
  workspace: string;
  target: PortalDriverTarget;
}): Promise<SwitchResult> {
  return executorRequest(
    "/workspaces/switch",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function deletePortalWorkspace(input: {
  userId: string;
  workspace: string;
}): Promise<{
  archived: true;
  archiveId: string;
  archivedAt: string;
  workspace: string;
}> {
  return executorRequest(
    "/workspaces",
    {
      method: "DELETE",
      body: JSON.stringify(input),
    },
  );
}

export async function stopPortalWorkspace(input: {
  userId: string;
  workspace: string;
}): Promise<{ stopped: true }> {
  return executorRequest(
    "/workspaces/stop",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function startPortalWorkspace(input: {
  userId: string;
  workspace: string;
}): Promise<{ started: true }> {
  return executorRequest(
    "/workspaces/start",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function switchPortalWorkspaceLiveCredential(input: {
  userId: string;
  workspace: string;
  harness: ManagedHarness;
  credentialId: string;
}): Promise<{
  switched: true;
  driver: string;
  credentialId: string;
}> {
  return executorRequest(
    "/workspaces/credentials/live/switch",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function bindPortalWorkspaceAgent(input: {
  userId: string;
  workspace: string;
  credentialId: string;
  driver?: PortalDriverTarget;
}): Promise<{
  enabled: true;
  driver: string;
  credentialBindings: PortalWorkspaceDetail["credentialBindings"];
  restarted: boolean;
}> {
  return executorRequest(
    "/workspaces/paseo/bind",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function unbindPortalWorkspaceAgent(input: {
  userId: string;
  workspace: string;
  driver?: PortalDriverTarget;
}): Promise<{
  enabled: false;
  driver: string;
  credentialBindings: PortalWorkspaceDetail["credentialBindings"];
  restarted: boolean;
}> {
  return executorRequest(
    "/workspaces/paseo/unbind",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}
