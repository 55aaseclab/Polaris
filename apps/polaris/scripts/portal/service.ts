import fs from "node:fs";
import path from "node:path";
import {
  activateManagedCredential,
  createManagedHarnessCredential,
  deleteManagedCredential,
} from "../config/credentials.js";
import {
  isManagedHarness,
  type ManagedHarness,
} from "../config/credential-catalog.js";
import {
  credentialCatalog,
  listArchivedWorkspaces,
  listPortalProfiles,
  readPortalProfile,
  listOwnedWorkspaces,
  listPortalCredentials,
  readPortalCredentialPreview,
  readPortalWorkspaceAssetPreview,
  loadWorkspaceDetail,
  loadWorkspaceSummary,
  updatePortalProfile,
  type PortalArchivedWorkspaceSummary,
  type PortalCredentialSummary,
  type PortalCredentialPreview,
  type PortalCredentialCatalog,
  type PortalWorkspaceAssetPreview,
  type PortalDriverTarget,
  type PortalWorkspaceDetail,
  type PortalProfileSummary,
  type PortalWorkspaceSummary,
} from "../core/portal.js";
import type { WorkspaceStatus } from "../core/workspace.js";
import { createUserCommand } from "../cli/commands/create-user.js";
import { deleteUserCommand } from "../cli/commands/delete-user.js";
import {
  listUserAccessSummaries,
  readUserAccessSummary,
  type PortalUserAccessSummary,
} from "./user-map.js";
import { polarisUsersRoot } from "../utils/paths.js";
import { withUserMutationLock } from "../utils/user-mutation-lock.js";
import {
  bindPortalWorkspaceAgent as bindPortalWorkspaceAgentExecutor,
  deletePortalWorkspace as deletePortalWorkspaceExecutor,
  queueProvisionWorkspace as queueProvisionWorkspaceExecutor,
  refreshPortalWorkspaceStatus as refreshPortalWorkspaceStatusExecutor,
  reportPortalWorkspaceStatus as reportPortalWorkspaceStatusExecutor,
  startPortalWorkspace as startPortalWorkspaceExecutor,
  stopPortalWorkspace as stopPortalWorkspaceExecutor,
  switchPortalWorkspace as switchPortalWorkspaceExecutor,
  switchPortalWorkspaceLiveCredential as switchPortalWorkspaceLiveCredentialExecutor,
  unbindPortalWorkspaceAgent as unbindPortalWorkspaceAgentExecutor,
} from "../executor/client.js";

const USER_ROOT = polarisUsersRoot(import.meta.url);
const statusRefreshJobs = new Map<string, Promise<void>>();

function rootKey(userId: string, workspace: string): string {
  return `${userId}:${workspace}`;
}

async function refreshPortalWorkspaceStatus(
  userId: string,
  workspace: string,
): Promise<void> {
  const key = rootKey(userId, workspace);
  const existing = statusRefreshJobs.get(key);
  if (existing) {
    return existing;
  }
  const job = (async () => {
    try {
      await refreshPortalWorkspaceStatusExecutor({ userId, workspace });
    } finally {
      statusRefreshJobs.delete(key);
    }
  })();
  statusRefreshJobs.set(key, job);
  return job;
}

export async function listPortalWorkspaces(userId: string): Promise<PortalWorkspaceSummary[]> {
  const workspaces = listOwnedWorkspaces(userId);
  return workspaces.map((workspace) => ({
    ...loadWorkspaceSummary(userId, workspace),
    status: null,
  }));
}

export function listPortalArchivedWorkspaces(
  userId: string,
): PortalArchivedWorkspaceSummary[] {
  return listArchivedWorkspaces(userId);
}

export function listPortalAdminUsers(): Array<
  PortalProfileSummary &
  Partial<PortalUserAccessSummary> &
  {
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
> {
  const profiles = listPortalProfiles();
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const accessSummaries = listUserAccessSummaries();
  const accessById = new Map(accessSummaries.map((access) => [access.polarisUserId, access]));
  const userIds = new Set<string>([
    ...profiles.map((profile) => profile.id),
    ...accessSummaries.map((access) => access.polarisUserId),
  ]);
  return Array.from(userIds)
    .sort((left, right) => left.localeCompare(right))
    .map((userId) => {
      const profile = profilesById.get(userId) ?? null;
      const access = accessById.get(userId) ?? null;
      const userRootPresent = fs.existsSync(path.join(USER_ROOT, userId));
      const integrityStatus =
        access && profile && userRootPresent
          ? "ok"
          : access && profile
            ? "profile-root-missing"
          : access && !profile
            ? "mapping-only"
          : !access && profile
            ? "profile-only"
            : "mapping-only";
      const baseProfile: PortalProfileSummary = profile ?? {
        id: userId,
        name: "",
        email: "",
        workspaces: [],
      };
      const baseAccess = access ?? {
        polarisUserId: userId,
        role: "user" as const,
        plan: "free" as const,
        clerkUsernames: [],
        clerkUserIds: [],
      };
      return {
        ...baseProfile,
        ...baseAccess,
        credentialCount: listPortalCredentials(userId).length,
        archivedWorkspaceCount: listArchivedWorkspaces(userId).length,
        mappingPresent: Boolean(access),
        profilePresent: Boolean(profile),
        userRootPresent,
        integrityStatus,
      };
    });
}

export async function getPortalWorkspaceDetail(
  userId: string,
  workspace: string,
) : Promise<PortalWorkspaceDetail> {
  const current = loadWorkspaceSummary(userId, workspace);
  if (current.status?.state === "creating") {
    return loadWorkspaceDetail(userId, workspace);
  }
  try {
    await refreshPortalWorkspaceStatus(userId, workspace);
  } catch {
    // Fall back to the last readable detail instead of failing the whole request.
  }
  return loadWorkspaceDetail(userId, workspace);
}

export function listUserPortalCredentials(
  userId: string,
): PortalCredentialSummary[] {
  return listPortalCredentials(userId);
}

export function getPortalCredentialCatalog(): PortalCredentialCatalog {
  return credentialCatalog();
}

export function readUserPortalCredentialPreview(
  userId: string,
  credentialPath: string,
): PortalCredentialPreview {
  return readPortalCredentialPreview(userId, credentialPath);
}

export function readUserPortalWorkspaceAssetPreview(
  userId: string,
  workspace: string,
  assetPath: string,
): PortalWorkspaceAssetPreview {
  return readPortalWorkspaceAssetPreview(userId, workspace, assetPath);
}

export async function createPortalCredential(input: {
  userId: string;
  harness: ManagedHarness;
  label?: string;
  providerName?: string;
  baseUrl?: string;
  apiKey?: string;
  credentialId?: string;
  presetId?: string;
  model?: string;
  activate?: boolean;
}): Promise<PortalCredentialSummary> {
  return withUserMutationLock(import.meta.url, input.userId, async () => {
    const created = createManagedHarnessCredential({
      userProfileId: input.userId,
      harness: input.harness,
      ...(input.credentialId?.trim() ? { credentialId: input.credentialId.trim() } : {}),
      ...(input.label?.trim() ? { label: input.label.trim() } : {}),
      ...(input.providerName?.trim() ? { providerName: input.providerName.trim() } : {}),
      ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
      ...(input.presetId?.trim() ? { presetId: input.presetId.trim() } : {}),
      ...(input.model?.trim() ? { model: input.model.trim() } : {}),
      ...(input.activate ? { activate: true } : {}),
    });
    const summary = listPortalCredentials(input.userId).find(
      (credential) => credential.id === created.id,
    );
    if (!summary) {
      throw new Error(
        `Credential '${created.id}' could not be loaded after creation`,
      );
    }
    return summary;
  });
}

export async function deletePortalCredential(
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
  return withUserMutationLock(import.meta.url, userId, async () => ({
    credential: deleteManagedCredential({
      userProfileId: userId,
      credentialId,
    }),
  }));
}

export async function activatePortalCredential(
  userId: string,
  credentialId: string,
): Promise<PortalCredentialSummary> {
  return withUserMutationLock(import.meta.url, userId, async () => {
    const activated = activateManagedCredential({
      userProfileId: userId,
      credentialId,
    });
    const summary = listPortalCredentials(userId).find((credential) => credential.id === activated.id);
    if (!summary) {
      throw new Error(`Credential '${activated.id}' could not be loaded after activation`);
    }
    return summary;
  });
}

export async function queueProvisionWorkspace(
  userId: string,
  workspace: string,
  options?: {
    defaultDockerOnly?: boolean;
    startAfterCreate?: boolean;
  },
) {
  return queueProvisionWorkspaceExecutor({
    userId,
    workspace,
    defaultDockerOnly: options?.defaultDockerOnly,
    startAfterCreate: options?.startAfterCreate,
  });
}

export async function switchPortalWorkspace(
  userId: string,
  workspace: string,
  target: PortalDriverTarget,
) {
  return switchPortalWorkspaceExecutor({ userId, workspace, target });
}

export async function deletePortalWorkspace(
  userId: string,
  workspace: string,
): Promise<{
  archived: true;
  archiveId: string;
  archivedAt: string;
  workspace: string;
}> {
  return deletePortalWorkspaceExecutor({ userId, workspace });
}

export async function stopPortalWorkspace(
  userId: string,
  workspace: string,
): Promise<{ stopped: true }> {
  return stopPortalWorkspaceExecutor({ userId, workspace });
}

export async function startPortalWorkspace(
  userId: string,
  workspace: string,
): Promise<{ started: true }> {
  return startPortalWorkspaceExecutor({ userId, workspace });
}

export async function refreshPortalWorkspace(
  userId: string,
  workspace: string,
): Promise<{ refreshed: true }> {
  await refreshPortalWorkspaceStatus(userId, workspace);
  return { refreshed: true };
}

export async function reportPortalWorkspaceStatus(input: {
  userId: string;
  workspace: string;
  status: Partial<WorkspaceStatus>;
}): Promise<{ reported: true }> {
  return reportPortalWorkspaceStatusExecutor(input);
}

export async function switchPortalWorkspaceLiveCredential(input: {
  userId: string;
  workspace: string;
  harness: ManagedHarness;
  credentialId: string;
}): Promise<{
  switched: true;
  harness: ManagedHarness;
  credential: PortalCredentialSummary;
}> {
  const summary = listPortalCredentials(input.userId).find(
    (credential) => credential.id === input.credentialId,
  );
  if (!summary) {
    throw new Error(
      `Credential '${input.credentialId}' was not found for user '${input.userId}'`,
    );
  }
  if (!isManagedHarness(input.harness)) {
    throw new Error(`Unsupported harness '${input.harness}'`);
  }
  await switchPortalWorkspaceLiveCredentialExecutor(input);
  return {
    switched: true,
    harness: input.harness,
    credential: summary,
  };
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
  return bindPortalWorkspaceAgentExecutor(input);
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
  return unbindPortalWorkspaceAgentExecutor(input);
}

export async function createPortalUser(input: {
  userProfileId?: string;
  clerkUsername?: string;
  clerkUserId?: string;
  email?: string;
  name?: string;
  role?: "admin" | "user";
  plan?: "free" | "pro";
}): Promise<NonNullable<ReturnType<typeof readPortalProfile>>> {
  const userProfileId =
    input.userProfileId?.trim()
    || input.clerkUsername?.trim()
    || input.clerkUserId?.trim()
    || "";
  if (!userProfileId) {
    throw new Error("userProfileId is required");
  }
  const email = input.email?.trim() || `${userProfileId}@polaris.local`;
  await createUserCommand([
    userProfileId,
    ...(input.name ? ["--name", input.name] : []),
    "--email",
    email,
    ...(input.clerkUsername?.trim() ? ["--clerk", input.clerkUsername.trim()] : []),
    ...(input.clerkUserId?.trim() ? ["--clerk-user-id", input.clerkUserId.trim()] : []),
    ...(input.role ? ["--role", input.role] : []),
    ...(input.plan ? ["--plan", input.plan] : []),
  ]);
  const created = readPortalProfile(userProfileId);
  if (!created) {
    throw new Error(
      `User profile '${userProfileId}' could not be loaded after creation`,
    );
  }
  return created;
}

export async function updatePortalUserProfile(
  userId: string,
  patch: {
    name?: string;
    email?: string;
    githubAccount?: string;
    sshComment?: string;
  },
): Promise<NonNullable<ReturnType<typeof readPortalProfile>>> {
  return withUserMutationLock(import.meta.url, userId, async () =>
    updatePortalProfile(userId, patch),
  );
}

export async function deletePortalUser(userId: string): Promise<{
  deleted: true;
  userId: string;
}> {
  await deleteUserCommand([userId]);
  return {
    deleted: true,
    userId,
  };
}
