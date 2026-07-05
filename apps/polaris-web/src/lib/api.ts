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

export interface PortalArchivedWorkspaceSummary {
  archiveId: string;
  workspaceName: string;
  archivedAt: string;
  originalWorkspaceRoot: string;
  originalPortalStateRoot?: string;
  workspaceRoot: string;
  portalStateRoot?: string;
}

export interface PortalUserMapping {
  polarisUserId: string;
  role: "admin" | "user";
  plan: "free" | "pro";
}

export interface PortalSession {
  authMode: string;
  authenticated: boolean;
  clerkUserId: string;
  clerkUsername: string | null;
  polarisUserId: string | null;
  role: "admin" | "user" | null;
}

export interface PortalAdminUserSummary extends PortalProfileSummary {
  polarisUserId: string;
  role: "admin" | "user";
  plan: "free" | "pro";
  clerkUsernames: string[];
  clerkUserIds: string[];
  credentialCount: number;
  archivedWorkspaceCount: number;
  mappingPresent: boolean;
  profilePresent: boolean;
  userRootPresent: boolean;
  integrityStatus:
    | "ok"
    | "mapping-only"
    | "profile-only"
    | "profile-root-missing";
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

export interface PortalWorkspaceStatus {
  driver?: {
    backend: string;
    profile?: string;
    baseImage: string;
    runtimeKind: "docker-container" | "kubernetes-pod" | "kubevirt-vm";
    runtimeRef: string;
    rootdiskImage?: string;
  };
  credentials?: {
    ssh?: {
      mode: "managed-key" | "provided-key";
      githubAccount?: string;
      selfCheck: {
        state: "ready" | "warning" | "error" | "not-configured";
        message: string;
      };
    };
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
  health?: {
    backendLiveness?: string;
    workspaceReadiness?: string;
    reason?: string;
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
  liveTarget: string | null;
  reconnectMode: "reconnectable" | "needs-pairing" | "unknown";
  reconnectTarget: string | null;
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

export interface PortalWorkspacePaseoDiagnostic {
  reconnectMode: "reconnectable" | "needs-pairing" | "unknown";
  reconnectTarget: string | null;
  liveTarget: string | null;
  persistedServerId: string | null;
  pairingServerId: string | null;
  pairingUrl: string | null;
  daemonStatusRaw: string | null;
  daemonStatus: {
    serverId: string;
    localDaemon: string;
    connectedDaemon: string;
  } | null;
  daemonObserved: {
    observed: boolean;
    detail: string;
  };
  pairingObserved: {
    observed: boolean;
    detail: string;
    url?: string;
  };
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

export interface PortalCredentialMaterialFile {
  key: string;
  sourcePath: string;
  mountPath?: string;
  content: string;
}

export interface PortalCredentialRecord {
  credential: PortalCredentialSummary;
  files: PortalCredentialMaterialFile[];
}

export interface PortalWorkspaceAssetPreview {
  path: string;
  content: string;
  truncated: boolean;
}

function apiBase(): string {
  return (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_POLARIS_API_BASE?.replace(/\/$/, "") ?? "";
}

let authTokenProvider: (() => Promise<string | null>) | null = null;

export function setApiAuthTokenProvider(
  provider: (() => Promise<string | null>) | null,
): void {
  authTokenProvider = provider;
}

async function apiFetch<T>(pathname: string, init?: RequestInit): Promise<T> {
  const token = authTokenProvider ? await authTokenProvider() : null;
  const response = await fetch(`${apiBase()}${pathname}`, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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

export async function getPortalSession(): Promise<PortalSession> {
  return apiFetch<PortalSession>("/session");
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

export async function deletePortalUser(userId: string): Promise<{
  deleted: true;
  userId: string;
}> {
  return apiFetch(`/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
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

export async function listArchivedWorkspaces(
  userId: string,
): Promise<PortalArchivedWorkspaceSummary[]> {
  const payload = await apiFetch<{ archivedWorkspaces?: PortalArchivedWorkspaceSummary[] }>(
    `/users/${encodeURIComponent(userId)}/workspaces`,
  );
  return payload.archivedWorkspaces ?? [];
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

export async function getCredentialRecord(
  userId: string,
  credentialId: string,
): Promise<PortalCredentialRecord> {
  return apiFetch<PortalCredentialRecord>(
    `/users/${encodeURIComponent(userId)}/credentials/${encodeURIComponent(credentialId)}`,
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

export async function updateCredentialFile(
  userId: string,
  credentialId: string,
  fileKey: string,
  content: string,
): Promise<PortalCredentialRecord> {
  return apiFetch<PortalCredentialRecord>(
    `/users/${encodeURIComponent(userId)}/credentials/${encodeURIComponent(credentialId)}/files/${encodeURIComponent(fileKey)}`,
    {
      method: "PUT",
      body: JSON.stringify({ content }),
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
): Promise<{ queued: true; workspace: string }> {
  return apiFetch<{ queued: true; workspace: string }>(
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
): Promise<{
  archived: true;
  archiveId: string;
  archivedAt: string;
  workspace: string;
}> {
  return apiFetch(
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}`,
    {
      method: "DELETE",
    },
  );
}

export async function deleteArchivedWorkspace(
  userId: string,
  archiveId: string,
): Promise<{ deleted: true; archiveId: string }> {
  return apiFetch(
    `/users/${encodeURIComponent(userId)}/workspaces/archives/${encodeURIComponent(archiveId)}`,
    {
      method: "DELETE",
    },
  );
}

export async function listAdminUsers(): Promise<PortalAdminUserSummary[]> {
  const payload = await apiFetch<{ users: PortalAdminUserSummary[] }>(
    "/admin/users",
  );
  return payload.users;
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

export async function rebuildWorkspace(
  userId: string,
  workspace: string,
): Promise<{ rebuilt: true }> {
  return apiFetch<{ rebuilt: true }>(
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/rebuild`,
    {
      method: "POST",
    },
  );
}

export async function getWorkspacePaseoDiagnostic(
  userId: string,
  workspace: string,
): Promise<PortalWorkspacePaseoDiagnostic> {
  return apiFetch<PortalWorkspacePaseoDiagnostic>(
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/paseo/status`,
  );
}

export async function restartWorkspacePaseoDaemon(
  userId: string,
  workspace: string,
): Promise<{ restarted: true; diagnostic: PortalWorkspacePaseoDiagnostic }> {
  return apiFetch<{ restarted: true; diagnostic: PortalWorkspacePaseoDiagnostic }>(
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/paseo/restart`,
    {
      method: "POST",
    },
  );
}
