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

export type ManagedHarness =
  | "ssh"
  | "codex"
  | "claude"
  | "copilot"
  | "opencode"
  | "pi";

export interface PortalProvisionProgress {
  jobId: string;
  workspace: string;
  userId: string;
  status: "queued" | "running" | "completed" | "error" | "cancelled" | "cancelling";
  phase: string;
  step: number;
  totalSteps: number;
  percent: number;
  message: string;
  startedAt: string;
  updatedAt: string;
  done: boolean;
  cancelRequested?: boolean;
  cancellable?: boolean;
  errorCode?: string;
  retryable?: boolean;
  error?: string;
}

export interface PortalWorkspaceStatus {
  state?: string;
  backend: {
    kind?: string;
    profile?: string;
    instanceState?:
      | "missing"
      | "created"
      | "running"
      | "stopped"
      | "degraded"
      | "unsupported";
  };
  driver?: {
    target: string;
    baseImage: string;
    runtimeKind: "docker-container" | "kubernetes-pod" | "kubevirt-vm";
    runtimeRef: string;
    runtimeState:
      | "missing"
      | "created"
      | "running"
      | "stopped"
      | "degraded"
      | "unsupported";
    rootdiskImage?: string;
  };
  paseo?: {
    daemonAddress: string;
    serverId?: string;
    supportedHarnesses: string[];
    liveTarget: string | null;
  };
  credentials?: {
    codex?: {
      state?: "selected" | "not-selected";
      credentialId?: string;
      label?: string;
      source?: "workspace-binding" | "user-active" | "compatibility";
    };
    live?: {
      supportedHarnesses: string[];
      switchableHarnesses: string[];
      selectedHarness?: string;
      selectedCredentialId?: string;
      selectedCredentialLabel?: string;
      source?: "runtime-state" | "workspace-binding" | "user-active" | "compatibility";
      selectedByHarness?: Record<string, {
        credentialId: string;
        label: string;
        source: "runtime-state" | "workspace-binding" | "user-active" | "compatibility";
      }>;
    };
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
      exists?: boolean;
    };
    specs: Array<{
      driver: string;
      file: string;
      path: string;
      exists?: boolean;
    }>;
    generatedManifests: Array<{
      driver: string;
      file: string;
      path: string;
      exists?: boolean;
    }>;
    imageTags: Array<{
      name: string;
      tag: string;
    }>;
    evolutionFiles: Array<{
      name: string;
      path: string;
      scope: "runtime" | "control-plane";
      exists?: boolean;
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

export interface PortalWorkspaceAgentBindingResult {
  enabled: boolean;
  driver: string;
  restarted: boolean;
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
  harness?: string;
  providerName?: string;
  baseUrl?: string;
  active: boolean;
  liveSwitchSupported: boolean;
  presetId?: string;
}

export interface PortalCredentialCatalog {
  harnesses: Array<{
    id: ManagedHarness;
    supportsCreate: boolean;
    supportsLiveSwitch: boolean;
  }>;
  presetsByHarness: Record<
    ManagedHarness,
    Array<{
      id: string;
      label: string;
      providerName: string;
      baseUrl: string;
      model?: string;
    }>
  >;
  presetSourceCommit: string;
}

export interface PortalCredentialPreview {
  path: string;
  content: string;
  truncated: boolean;
}

export interface PortalWorkspaceAssetPreview {
  path: string;
  content: string;
  truncated: boolean;
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
  return apiFetch<PortalProfileSummary[]>("/users");
}

export async function createPortalUser(input: {
  userProfileId: string;
  clerkUsername?: string;
  clerkUserId?: string;
  email?: string;
  name?: string;
  role?: "admin" | "user";
  plan?: "free" | "pro";
}): Promise<PortalProfileDetail> {
  return apiFetch<PortalProfileDetail>("/users", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function resolvePortalUserMapping(
  input: {
    clerkUsername?: string;
    clerkUserId?: string;
  },
): Promise<PortalUserMapping | null> {
  const params = new URLSearchParams();
  if (input.clerkUsername?.trim()) {
    params.set("clerkUsername", input.clerkUsername.trim());
  }
  if (input.clerkUserId?.trim()) {
    params.set("clerkUserId", input.clerkUserId.trim());
  }
  const payload = await apiFetch<{
    clerkUsername: string;
    clerkUserId?: string;
    mapping: PortalUserMapping | null;
  }>(`/user-mapping?${params.toString()}`);
  return payload.mapping;
}

export async function listWorkspaces(userId: string): Promise<PortalWorkspaceSummary[]> {
  const payload = await apiFetch<{ workspaces: PortalWorkspaceSummary[] }>(
    `/users/${encodeURIComponent(userId)}/workspaces`,
  );
  return payload.workspaces;
}

export async function getUserProfile(userId: string): Promise<PortalProfileDetail> {
  return apiFetch<PortalProfileDetail>(`/users/${encodeURIComponent(userId)}/profile`);
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
    `/users/${encodeURIComponent(userId)}/profile`,
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
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}`,
  );
}

export async function refreshWorkspaceStatus(
  userId: string,
  workspace: string,
): Promise<{ refreshed: true }> {
  return apiFetch<{ refreshed: true }>(
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/refresh`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function listCredentials(userId: string): Promise<PortalCredentialSummary[]> {
  const payload = await apiFetch<{ credentials: PortalCredentialSummary[] }>(
    `/users/${encodeURIComponent(userId)}/credentials`,
  );
  return payload.credentials;
}

export async function getCredentialCatalog(
  userId: string,
): Promise<PortalCredentialCatalog> {
  return apiFetch<PortalCredentialCatalog>(
    `/users/${encodeURIComponent(userId)}/credentials/catalog`,
  );
}

export async function getCredentialPreview(
  userId: string,
  credentialPath: string,
): Promise<PortalCredentialPreview> {
  return apiFetch<PortalCredentialPreview>(
    `/users/${encodeURIComponent(userId)}/credentials/preview?path=${encodeURIComponent(credentialPath)}`,
  );
}

export async function getWorkspaceAssetPreview(
  userId: string,
  workspace: string,
  assetPath: string,
): Promise<PortalWorkspaceAssetPreview> {
  return apiFetch<PortalWorkspaceAssetPreview>(
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/preview?path=${encodeURIComponent(assetPath)}`,
  );
}

export async function createCredential(
  userId: string,
  input: {
    harness: ManagedHarness;
    credentialId?: string;
    label?: string;
    providerName?: string;
    baseUrl?: string;
    apiKey?: string;
    presetId?: string;
    model?: string;
    activate?: boolean;
  },
): Promise<PortalCredentialSummary> {
  return apiFetch<PortalCredentialSummary>(
    `/users/${encodeURIComponent(userId)}/credentials`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function deleteCredential(
  userId: string,
  credentialId: string,
): Promise<{
  credential: {
    id: string;
    userId: string;
    removed: boolean;
    registryPath: string;
    removedPaths: string[];
  };
}> {
  return apiFetch(
    `/users/${encodeURIComponent(userId)}/credentials/${encodeURIComponent(credentialId)}`,
    {
      method: "DELETE",
    },
  );
}

export async function activateCredential(
  userId: string,
  credentialId: string,
): Promise<PortalCredentialSummary> {
  return apiFetch(
    `/users/${encodeURIComponent(userId)}/credentials/${encodeURIComponent(credentialId)}/activate`,
    {
      method: "POST",
    },
  );
}

export async function switchWorkspaceLiveCredential(
  userId: string,
  workspace: string,
  input: {
    harness: ManagedHarness;
    credentialId: string;
  },
): Promise<{
  switched: true;
  harness: ManagedHarness;
  credential: PortalCredentialSummary;
}> {
  return apiFetch(
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/paseo/credentials/switch`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function createWorkspace(
  userId: string,
  workspaceName: string,
  options?: {
    defaultDockerOnly?: boolean;
    startAfterCreate?: boolean;
  },
): Promise<PortalProvisionProgress> {
  return apiFetch<PortalProvisionProgress>(
    `/users/${encodeURIComponent(userId)}/workspaces`,
    {
      method: "POST",
      body: JSON.stringify({
        workspaceName,
        defaultDockerOnly: options?.defaultDockerOnly ?? false,
        startAfterCreate: options?.startAfterCreate ?? false,
      }),
    },
  );
}

export async function cancelWorkspaceProvision(
  userId: string,
  workspace: string,
): Promise<PortalProvisionProgress> {
  return apiFetch<PortalProvisionProgress>(
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/provision/cancel`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function switchWorkspaceDriver(
  userId: string,
  workspace: string,
  driver: string,
): Promise<unknown> {
  return apiFetch(
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/switch`,
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
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}`,
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
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/stop`,
    {
      method: "POST",
    },
  );
}

export async function startWorkspace(
  userId: string,
  workspace: string,
): Promise<{ started: true }> {
  return apiFetch<{ started: true }>(
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/start`,
    {
      method: "POST",
    },
  );
}

export async function bindWorkspacePaseoCredential(
  userId: string,
  workspace: string,
  input: {
    credentialId: string;
    driver?: string;
  },
): Promise<PortalWorkspaceAgentBindingResult> {
  return apiFetch<PortalWorkspaceAgentBindingResult>(
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/paseo/bind`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function unbindWorkspacePaseoCredential(
  userId: string,
  workspace: string,
  input?: {
    driver?: string;
  },
): Promise<PortalWorkspaceAgentBindingResult> {
  return apiFetch<PortalWorkspaceAgentBindingResult>(
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/paseo/unbind`,
    {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    },
  );
}
