export interface PortalProfileSummary {
  id: string;
  name: string;
  email: string;
  workspaces: string[];
}

export interface PortalProfileDetail extends PortalProfileSummary {
  githubAccount?: string;
  sshMode?: string;
  sshComment?: string;
}

export interface PortalDriverTarget {
  backend: "docker" | "pod" | "kubevirt-vm";
  profile?: string;
}

export interface PortalProvisionProgress {
  workspace: string;
  userId: string;
  phase: string;
  step: number;
  totalSteps: number;
  percent: number;
  message: string;
  updatedAt: string;
  done: boolean;
  error?: string;
}

export interface PortalWorkspaceStatus {
  state?: string;
  backend: {
    kind?: string;
    profile?: string;
  };
  daemon?: {
    manager?: { state?: string };
    pairing?: { state?: string; url?: string };
  };
  details: {
    backendDetail?: string;
    serviceDetail?: string;
    userProfileDetail?: string;
  };
}

export interface PortalWorkspaceSummary {
  name: string;
  drivers: PortalDriverTarget[];
  selectedDriver: PortalDriverTarget | null;
  status: PortalWorkspaceStatus | null;
  progress: PortalProvisionProgress | null;
  liveTarget: string | null;
}

export interface PortalWorkspaceDetail extends PortalWorkspaceSummary {
  resolvedWorkspace: PortalWorkspaceStatus | null;
  availableDrivers: Array<PortalDriverTarget & { available: boolean }>;
  credentialBindings: Array<{
    purpose: string;
    credentialId: string;
    required: boolean;
  }>;
}

export interface PortalCredentialSummary {
  id: string;
  kind: string;
  label: string;
  purposes: string[];
  status: string;
  paths: string[];
}

function apiBase(): string {
  return (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_POLARIS_API_BASE?.replace(/\/$/, "") ?? "";
}

async function apiFetch<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase()}${pathname}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`API request failed (${response.status}): ${pathname}`);
  }
  return response.json() as Promise<T>;
}

export async function listUsers(): Promise<PortalProfileSummary[]> {
  return apiFetch<PortalProfileSummary[]>("/api/users");
}

export async function getDefaultUserId(): Promise<string | null> {
  const payload = await apiFetch<{ defaultUserId: string | null }>("/api/default-user");
  return payload.defaultUserId;
}

export async function listWorkspaces(userId: string): Promise<PortalWorkspaceSummary[]> {
  const payload = await apiFetch<{ workspaces: PortalWorkspaceSummary[] }>(
    `/api/users/${encodeURIComponent(userId)}/workspaces`,
  );
  return payload.workspaces;
}

export async function getUserProfile(userId: string): Promise<PortalProfileDetail> {
  return apiFetch<PortalProfileDetail>(`/api/users/${encodeURIComponent(userId)}/profile`);
}

export async function updateUserProfile(
  userId: string,
  patch: {
    name: string;
    email: string;
    githubAccount: string;
    sshComment: string;
  },
): Promise<PortalProfileDetail> {
  return apiFetch<PortalProfileDetail>(
    `/api/users/${encodeURIComponent(userId)}/profile`,
    {
      method: "POST",
      body: JSON.stringify(patch),
    },
  );
}

export async function getWorkspaceDetail(
  userId: string,
  workspace: string,
): Promise<PortalWorkspaceDetail> {
  return apiFetch<PortalWorkspaceDetail>(
    `/api/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}`,
  );
}

export async function listCredentials(userId: string): Promise<PortalCredentialSummary[]> {
  const payload = await apiFetch<{ credentials: PortalCredentialSummary[] }>(
    `/api/users/${encodeURIComponent(userId)}/credentials`,
  );
  return payload.credentials;
}

export async function createWorkspace(
  userId: string,
  workspaceName: string,
): Promise<PortalProvisionProgress> {
  return apiFetch<PortalProvisionProgress>(
    `/api/users/${encodeURIComponent(userId)}/workspaces`,
    {
      method: "POST",
      body: JSON.stringify({ workspaceName }),
    },
  );
}

export async function switchWorkspaceDriver(
  userId: string,
  workspace: string,
  driver: string,
): Promise<unknown> {
  return apiFetch(
    `/api/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/switch`,
    {
      method: "POST",
      body: JSON.stringify({ driver }),
    },
  );
}
