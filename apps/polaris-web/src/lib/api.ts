import { captureTelemetryError, trackTelemetryEvent } from "./telemetry";

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
  referredByCode?: string;
  aiAccessReferralAppliedAt?: string;
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
  authingUserId: string;
  authingUsername: string | null;
  polarisUserId: string | null;
  role: "admin" | "user" | null;
}

export interface PortalAdminUserSummary extends PortalProfileSummary {
  polarisUserId: string;
  role: "admin" | "user";
  plan: "free" | "pro";
  authingUsernames: string[];
  authingUserIds: string[];
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
  schemaVersion: number;
  driver?: {
    selected: {
      backend: "docker" | "pod" | "kubevirt-vm";
      profile?: string;
    } | null;
    status:
      | "absent"
      | "creating"
      | "starting"
      | "running"
      | "stopping"
      | "stopped"
      | "rebuilding"
      | "archiving"
      | "deleting"
      | "failed"
      | "unknown";
    reason?: string;
    baseImage?: string;
    runtimeKind?: "docker-container" | "kubernetes-pod" | "kubevirt-vm";
    runtimeRef?: string;
    rootdiskImage?: string;
  };
  paseo: {
    daemon: "absent" | "pending" | "ready" | "unknown";
    web: "unavailable" | "pairing-required" | "connectable";
    reconnectMode: "reconnectable" | "needs-pairing" | "unknown";
    liveTarget: string | null;
    reconnectTarget: string | null;
    reason?: string;
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
  skills?: {
    installedByHarness?: Record<string, string[]>;
    source?: string;
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

export interface PortalWorkspaceStaticSummary {
  name: string;
  availableDrivers: Array<PortalDriverTarget & { available: boolean }>;
}

export interface PortalWorkspaceLiveStatus {
  schemaVersion?: number;
  driver?: PortalWorkspaceStatus["driver"];
  paseo: PortalWorkspaceStatus["paseo"];
  credentials?: Pick<NonNullable<PortalWorkspaceStatus["credentials"]>, "live">;
  evolution?: PortalWorkspaceStatus["evolution"];
}

export interface PortalWorkspaceLiveSummary {
  name: string;
  status: PortalWorkspaceLiveStatus | null;
}

export interface PortalWorkspaceSummary {
  name: string;
  drivers: PortalDriverTarget[];
  status: PortalWorkspaceStatus | PortalWorkspaceLiveStatus | null;
}

export interface PortalWorkspaceDetailStatic {
  name: string;
  availableDrivers: Array<PortalDriverTarget & { available: boolean }>;
  credentialBindings: Array<{
    purpose: string;
    credentialId: string;
    required: boolean;
  }>;
  assets?: PortalWorkspaceStatus["assets"];
  attachments?: Record<string, {
    state: "ok" | "missing" | "drifted" | "unknown";
    detail?: string;
    url?: string;
  }>;
  workspaceAssembly?: Record<string, {
    state: "ok" | "missing" | "drifted" | "unknown";
    detail?: string;
    url?: string;
  }>;
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

export type PortalWorkspaceStreamEvent =
  | {
    type: "snapshot";
    staticWorkspaces: PortalWorkspaceStaticSummary[];
    liveWorkspaces: PortalWorkspaceLiveSummary[];
  }
  | {
    type: "static-upsert";
    workspace: PortalWorkspaceStaticSummary;
  }
  | {
    type: "static-remove";
    workspace: string;
  }
  | {
    type: "live-upsert";
    workspace: PortalWorkspaceLiveSummary;
  }
  | {
    type: "live-remove";
    workspace: string;
  }
  | {
    type: "heartbeat";
    ts: number;
  };

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

export interface PortalSkillSummary {
  id: string;
  userId: string;
  harness: "codex" | "claude";
  packageName: string;
  args: string[];
  command: string[];
  label: string;
  source?: string;
  selectedSkillName: string;
  registryPath: string;
  createdAt?: string;
}

export interface PortalWorkspaceAssetPreview {
  path: string;
  content: string;
  truncated: boolean;
}

export type PortalAiAccessState =
  | "not_provisioned"
  | "funding_needed"
  | "ready"
  | "error";

export type PortalAiAccessActionKind =
  | "provision_access"
  | "top_up"
  | "refresh_status"
  | "retry";

export interface PortalAiAccessAction {
  kind: PortalAiAccessActionKind;
  enabled: boolean;
  reason?: string;
}

export interface PortalAiAccessTopUpMethod {
  id: string;
  label: string;
  kind: "epay" | "waffo" | "waffo-pancake" | "creem";
  minAmount: number;
  fixedAmount: number | null;
}

export interface PortalAiAccessTopUpInfo {
  currencySymbol: string;
  amountOptions: number[];
  methods: PortalAiAccessTopUpMethod[];
}

export interface PortalAiAccessTopUpSession {
  redirectUrl: string;
}

export interface PortalAiAccessView {
  state: PortalAiAccessState;
  summary: {
    accessState: PortalAiAccessState;
    billingMode: "payg" | "monthly" | "hybrid" | "unknown";
    availableBalance: number | null;
    balanceUnit: string | null;
    referralState: "unavailable" | "enabled" | "disabled" | "error";
  };
  mainAction: {
    headline: string;
    description: string;
    primaryAction: PortalAiAccessAction;
    secondaryAction?: PortalAiAccessAction;
    stateReason?: string;
  };
  accessStatus: {
    provisioningStatus: "not-provisioned" | "provisioned";
    accountLinked: boolean;
    runtimeReady: boolean;
    lastSyncAt: string | null;
    statusMessage: string | null;
  };
  billing: {
    billingMode: "payg" | "monthly" | "hybrid" | "unknown";
    subscriptionStatus: "none" | "active" | "paused" | "expired" | "unknown";
    subscriptionName: string | null;
    balanceAmount: number | null;
    balanceUnit: string | null;
    lastTopupAt: string | null;
  };
  referral: {
    referralEnabled: boolean;
    inviteCode: string | null;
    inviteLink: string | null;
    rebateSummary: string | null;
  };
  advanced: {
    providerBackend: string;
    providerAccountId: string | null;
    providerTokenPresent: boolean;
    credentialSyncStatus: "idle" | "ready" | "error";
    defaultCredentialId: string | null;
    lastInternalSyncAt: string | null;
    lastErrorMessage: string | null;
  };
  capabilities: {
    provisionAccess: boolean;
    topUp: boolean;
    referral: boolean;
    subscription: boolean;
  };
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
  const method = String(init?.method || "GET").toUpperCase();
  const startedAt = Date.now();
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
    const error = new Error(body.trim() || `API request failed (${response.status}): ${pathname}`);
    captureTelemetryError(error, {
      event: "api_request_failed",
      category: "error",
      error_domain: "portal_api",
      error_stage: pathname,
      method,
      pathname,
      http_status: response.status,
      duration_ms: Date.now() - startedAt,
    });
    throw error;
  }
  trackTelemetryEvent("api_request_completed", {
    category: "runtime",
    method,
    pathname,
    http_status: response.status,
    duration_ms: Date.now() - startedAt,
  });
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
  authingUsername?: string;
  authingUserId?: string;
  email?: string;
  name?: string;
  referralCode?: string;
  role?: "admin" | "user";
  plan?: "free" | "pro";
}): Promise<PortalProfileDetail> {
  trackTelemetryEvent("feature_used", {
    category: "product",
    feature_name: "portal_user_create",
  });
  try {
    const result = await apiFetch<PortalProfileDetail>("/users", {
      method: "POST",
      body: JSON.stringify(input),
    });
    trackTelemetryEvent("feature_used", {
      category: "product",
      feature_name: "portal_user_created",
    });
    return result;
  } catch (error) {
    captureTelemetryError(error, {
      event: "portal_user_create_failed",
      category: "error",
      feature_name: "portal_user_create",
    });
    throw error;
  }
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
    authingUsername?: string;
    authingUserId?: string;
  },
): Promise<PortalUserMapping | null> {
  const params = new URLSearchParams();
  if (input.authingUsername?.trim()) {
    params.set("authingUsername", input.authingUsername.trim());
  }
  if (input.authingUserId?.trim()) {
    params.set("authingUserId", input.authingUserId.trim());
  }
  const payload = await apiFetch<{
    authingUsername: string;
    authingUserId?: string;
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

export async function listWorkspaceStaticSummaries(
  userId: string,
): Promise<PortalWorkspaceStaticSummary[]> {
  const payload = await apiFetch<{ workspaces: PortalWorkspaceStaticSummary[] }>(
    `/users/${encodeURIComponent(userId)}/workspaces/static`,
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

export async function getWorkspaceDetailStatic(
  userId: string,
  workspace: string,
): Promise<PortalWorkspaceDetailStatic> {
  return apiFetch<PortalWorkspaceDetailStatic>(
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/detail`,
  );
}

export async function subscribeWorkspaceLiveStream(
  userId: string,
  handlers: {
    onEvent: (event: PortalWorkspaceStreamEvent) => void;
    onOpen?: () => void;
    onError?: (error: string) => void;
    signal?: AbortSignal;
  },
): Promise<() => void> {
  const token = authTokenProvider ? await authTokenProvider() : null;
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
  };
  if (handlers.signal) {
    if (handlers.signal.aborted) {
      abort();
    } else {
      handlers.signal.addEventListener("abort", abort, { once: true });
    }
  }
  const response = await fetch(`${apiBase()}/users/${encodeURIComponent(userId)}/workspaces/live`, {
    method: "GET",
    credentials: "include",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: controller.signal,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body.trim() || `API request failed (${response.status}): workspace live stream`);
  }
  handlers.onOpen?.();
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  if (!reader) {
    return () => {
      controller.abort();
    };
  }
  let buffer = "";
  void (async () => {
    let endedUnexpectedly = false;
    try {
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          endedUnexpectedly = !controller.signal.aborted;
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const lines = frame.split("\n");
          const dataLines = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice("data:".length).trim());
          if (dataLines.length === 0) {
            continue;
          }
          const payload = JSON.parse(dataLines.join("\n")) as PortalWorkspaceStreamEvent;
          handlers.onEvent(payload);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        handlers.onError?.(error instanceof Error ? error.message : String(error));
      }
    } finally {
      reader.releaseLock();
      if (endedUnexpectedly && !controller.signal.aborted) {
        handlers.onError?.("Workspace live stream closed");
      }
    }
  })();
  return () => {
    controller.abort();
  };
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

export async function listSkills(userId: string): Promise<PortalSkillSummary[]> {
  const payload = await apiFetch<{ skills: PortalSkillSummary[] }>(
    `/users/${encodeURIComponent(userId)}/skills`,
  );
  return payload.skills;
}

export async function createSkill(
  userId: string,
  input: {
    harness: "codex" | "claude";
    source: string;
    skillId?: string;
    skillName: string;
  },
): Promise<PortalSkillSummary> {
  return apiFetch<PortalSkillSummary>(
    `/users/${encodeURIComponent(userId)}/skills`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function deleteSkill(
  userId: string,
  skillId: string,
): Promise<{
  skill: {
    id: string;
    userId: string;
    removed: boolean;
    registryPath: string;
  };
}> {
  return apiFetch(
    `/users/${encodeURIComponent(userId)}/skills/${encodeURIComponent(skillId)}`,
    {
      method: "DELETE",
    },
  );
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
  trackTelemetryEvent("credential_added", {
    category: "product",
    harness: input.harness,
  });
  try {
    return await apiFetch<PortalCredentialSummary>(
      `/users/${encodeURIComponent(userId)}/credentials`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  } catch (error) {
    captureTelemetryError(error, {
      event: "credential_add_failed",
      category: "error",
      harness: input.harness,
    });
    throw error;
  }
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

export async function getAiAccess(userId: string): Promise<PortalAiAccessView> {
  trackTelemetryEvent("ai_access_opened", {
    category: "product",
  });
  try {
    return await apiFetch<PortalAiAccessView>(
      `/users/${encodeURIComponent(userId)}/ai-access`,
    );
  } catch (error) {
    captureTelemetryError(error, {
      event: "ai_access_failed",
      category: "error",
      error_stage: "read",
    });
    throw error;
  }
}

export async function performAiAccessAction(
  userId: string,
  action: PortalAiAccessActionKind,
): Promise<PortalAiAccessView> {
  trackTelemetryEvent("feature_used", {
    category: "product",
    feature_name: `ai_access:${action}`,
  });
  try {
    return await apiFetch<PortalAiAccessView>(
      `/users/${encodeURIComponent(userId)}/ai-access/actions/${encodeURIComponent(action)}`,
      {
        method: "POST",
      },
    );
  } catch (error) {
    captureTelemetryError(error, {
      event: "ai_access_failed",
      category: "error",
      error_stage: action,
    });
    throw error;
  }
}

export async function getAiAccessTopUpInfo(
  userId: string,
): Promise<PortalAiAccessTopUpInfo> {
  return apiFetch<PortalAiAccessTopUpInfo>(
    `/users/${encodeURIComponent(userId)}/ai-access/topup-info`,
  );
}

export async function createAiAccessTopUpSession(
  userId: string,
  input: {
    methodId: string;
    amount: number;
  },
): Promise<PortalAiAccessTopUpSession> {
  trackTelemetryEvent("feature_used", {
    category: "product",
    feature_name: "ai_access_top_up",
    amount: input.amount,
  });
  try {
    return await apiFetch<PortalAiAccessTopUpSession>(
      `/users/${encodeURIComponent(userId)}/ai-access/topup-session`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  } catch (error) {
    captureTelemetryError(error, {
      event: "ai_access_failed",
      category: "error",
      error_stage: "top_up",
    });
    throw error;
  }
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
  trackTelemetryEvent("workspace_created", {
    category: "product",
    workspace_backend: options?.defaultDockerOnly ? "docker" : "mixed",
  });
  try {
    return await apiFetch<{ queued: true; workspace: string }>(
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
  } catch (error) {
    captureTelemetryError(error, {
      event: "workspace_create_failed",
      category: "error",
      workspace_backend: options?.defaultDockerOnly ? "docker" : "mixed",
    });
    throw error;
  }
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

export async function updateWorkspaceSelectedDriver(
  userId: string,
  workspace: string,
  driver: string,
): Promise<{ updated: true }> {
  return apiFetch<{ updated: true }>(
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/driver`,
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
  try {
    const result = await apiFetch<{ stopped: true }>(
      `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/stop`,
      {
        method: "POST",
      },
    );
    trackTelemetryEvent("workspace_stopped", {
      category: "product",
      workspace_name: workspace,
    });
    return result;
  } catch (error) {
    captureTelemetryError(error, {
      event: "feature_used",
      category: "error",
      feature_name: "workspace_stop_failed",
      workspace_name: workspace,
    });
    throw error;
  }
}

export async function startWorkspace(
  userId: string,
  workspace: string,
): Promise<{ started: true }> {
  try {
    const result = await apiFetch<{ started: true }>(
      `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/start`,
      {
        method: "POST",
      },
    );
    trackTelemetryEvent("workspace_started", {
      category: "product",
      workspace_name: workspace,
    });
    return result;
  } catch (error) {
    captureTelemetryError(error, {
      event: "workspace_start_failed",
      category: "error",
      workspace_name: workspace,
    });
    throw error;
  }
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

export async function listWorkspaceSkills(
  userId: string,
  workspace: string,
  harness: "codex" | "claude" = "codex",
): Promise<{
  workspace: string;
  userId: string;
  installed: Array<{ harness: "codex" | "claude"; skills: string[] }>;
}> {
  return apiFetch(
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/skills/list`,
    {
      method: "POST",
      body: JSON.stringify({ harness }),
    },
  );
}

export async function installWorkspaceSkill(
  userId: string,
  workspace: string,
  skillId: string,
  harness: "codex" | "claude" = "codex",
): Promise<{
  installed: true;
  workspace: string;
  userId: string;
  harness: "codex" | "claude";
  skillId: string;
  packageName: string;
}> {
  return apiFetch(
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/skills/install`,
    {
      method: "POST",
      body: JSON.stringify({ harness, skillId }),
    },
  );
}

export async function uninstallWorkspaceSkill(
  userId: string,
  workspace: string,
  skillId: string,
  harness: "codex" | "claude" = "codex",
): Promise<{
  uninstalled: true;
  workspace: string;
  userId: string;
  harness: "codex" | "claude";
  skillId: string;
  removed: boolean;
}> {
  return apiFetch(
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/skills/uninstall`,
    {
      method: "POST",
      body: JSON.stringify({ harness, skillId }),
    },
  );
}

export async function syncWorkspaceSkills(
  userId: string,
  workspace: string,
  harness: "codex" | "claude" = "codex",
): Promise<{
  synced: true;
  workspace: string;
  userId: string;
  harness: "codex" | "claude";
  installed: string[];
  removed: string[];
}> {
  return apiFetch(
    `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/skills/sync`,
    {
      method: "POST",
      body: JSON.stringify({ harness }),
    },
  );
}
