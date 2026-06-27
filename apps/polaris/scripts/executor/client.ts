import type { SwitchResult } from "../cli/commands/switch.js";
import type {
  PortalDriverTarget,
  PortalProvisionProgress,
  PortalWorkspaceDetail,
} from "../core/portal.js";
import {
  bindPortalWorkspaceAgent as bindPortalWorkspaceAgentLocal,
  deletePortalWorkspace as deletePortalWorkspaceLocal,
  queueProvisionWorkspace as queueProvisionWorkspaceLocal,
  refreshPortalWorkspaceStatus as refreshPortalWorkspaceStatusLocal,
  stopPortalWorkspace as stopPortalWorkspaceLocal,
  switchPortalWorkspace as switchPortalWorkspaceLocal,
  unbindPortalWorkspaceAgent as unbindPortalWorkspaceAgentLocal,
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

async function executorRequest<T>(
  pathname: string,
  init: RequestInit,
  fallback: () => T | Promise<T>,
): Promise<T> {
  const baseUrl = executorBaseUrl();
  if (!baseUrl) {
    return await fallback();
  }
  let response: Response;
  try {
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
    throw new Error(
      `Polaris executor request failed (${response.status} ${response.statusText}) for ${pathname}: ${await response.text()}`,
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
    () =>
      queueProvisionWorkspaceLocal(input.userId, input.workspace, {
        defaultDockerOnly: input.defaultDockerOnly,
        startAfterCreate: input.startAfterCreate,
      }),
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
    async () => {
      await refreshPortalWorkspaceStatusLocal(input.userId, input.workspace);
      return { refreshed: true };
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
    () =>
      switchPortalWorkspaceLocal(input.userId, input.workspace, input.target),
  );
}

export async function deletePortalWorkspace(input: {
  userId: string;
  workspace: string;
}): Promise<{ removed: true }> {
  return executorRequest(
    "/workspaces",
    {
      method: "DELETE",
      body: JSON.stringify(input),
    },
    () => deletePortalWorkspaceLocal(input.userId, input.workspace),
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
    () => stopPortalWorkspaceLocal(input.userId, input.workspace),
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
    () => bindPortalWorkspaceAgentLocal(input),
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
    () => unbindPortalWorkspaceAgentLocal(input),
  );
}
