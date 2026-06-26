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

export interface PortalUserMapping {
  polarisUserId: string;
  role: "admin" | "user";
  plan: "free" | "pro";
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
  paseo?: {
    daemonAddress: string;
    supportedHarnesses: string[];
    liveTarget: string | null;
  };
  daemon?: {
    manager?: { state?: string };
    pairing?: { state?: string; url?: string };
  };
  evolution?: {
    artifactCount: number;
    activeWorkspaceArtifacts: number;
    activeUserArtifacts: number;
    latestTitles: string[];
    latestArtifacts?: Array<{
      title: string;
      kind: string;
      status: string;
      whyExists?: string;
      whyRetrieved?: string[];
      curatorAction?: string;
      curatorReason?: string;
      suppressedBecause?: string;
    }>;
    pendingMemoryChanges?: number;
    lastSessionId?: string;
  };
  details: {
    backendDetail?: string;
    serviceDetail?: string;
    userProfileDetail?: string;
  };
  assets?: {
    dockerfile: {
      file: string;
      path: string;
    };
    specs: Array<{
      driver: string;
      file: string;
      path: string;
    }>;
    generatedManifests: Array<{
      driver: string;
      file: string;
      path: string;
    }>;
    imageTags: Array<{
      name: string;
      tag: string;
    }>;
    evolutionFiles: Array<{
      name: string;
      path: string;
      scope: "runtime" | "control-plane";
    }>;
    persistentVolumes: Array<{
      name: string;
      sourceKind: string;
      sourceRef?: string;
      mountRoot: string;
      durablePaths: string[];
    }>;
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
    const body = await response.text();
    throw new Error(body.trim() || `API request failed (${response.status}): ${pathname}`);
  }
  return response.json() as Promise<T>;
}

export async function listUsers(): Promise<PortalProfileSummary[]> {
  return apiFetch<PortalProfileSummary[]>("/api/users");
}

export async function createPortalUser(input: {
  userProfileId: string;
  clerkUsername: string;
  email?: string;
  name?: string;
  role?: "admin" | "user";
  plan?: "free" | "pro";
}): Promise<PortalProfileDetail> {
  return apiFetch<PortalProfileDetail>("/api/users", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function deletePortalUser(
  userId: string,
): Promise<{
  userProfile: {
    id: string;
    removed: boolean;
    profilePath: string;
    secretsRoot: string;
  };
  mappings: {
    removedClerkUsernames: string[];
  };
  clerk: {
    removedUserIds: string[];
  };
}> {
  return apiFetch(
    `/api/users/${encodeURIComponent(userId)}`,
    {
      method: "DELETE",
    },
  );
}

export async function resolvePortalUserMapping(
  clerkUsername: string,
): Promise<PortalUserMapping | null> {
  const payload = await apiFetch<{
    clerkUsername: string;
    mapping: PortalUserMapping | null;
  }>(`/api/user-mapping?clerkUsername=${encodeURIComponent(clerkUsername)}`);
  return payload.mapping;
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

export async function deleteWorkspace(
  userId: string,
  workspace: string,
): Promise<{ removed: true }> {
  return apiFetch<{ removed: true }>(
    `/api/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}`,
    {
      method: "DELETE",
    },
  );
}

export async function stopWorkspace(
  userId: string,
  workspace: string,
): Promise<{ stopped: true }> {
  return apiFetch<{ stopped: true }>(
    `/api/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/stop`,
    {
      method: "POST",
    },
  );
}
