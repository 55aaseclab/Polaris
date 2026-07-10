import fs from "node:fs";
import path from "node:path";
import {
  activateManagedCredential,
  createManagedHarnessCredential,
  deleteManagedCredential,
  readManagedCredentialRecord,
  writeManagedCredentialMaterialFile,
} from "../config/credentials.js";
import {
  addUserSkill,
  createSkillsCliDescriptor,
  listUserSkills,
  removeUserSkill,
  type SkillHarness,
} from "../config/skills.js";
import {
  isManagedHarness,
  type ManagedHarness,
} from "../config/credential-catalog.js";
import {
  credentialCatalog,
  clearWorkspaceProvisionProgress,
  listArchivedWorkspaces,
  listPortalProfiles,
  listPortalWorkspaceStaticSummaries,
  readPortalProfile,
  listOwnedWorkspaces,
  listPortalCredentials,
  writeWorkspaceProvisionProgress,
  readPortalWorkspaceAssetPreview,
  loadWorkspaceDetailStatic,
  loadWorkspaceDetail,
  loadWorkspaceSummary,
  updatePortalProfile,
  updatePortalWorkspaceAgentBinding,
  workspaceRefFromTarget,
  type PortalArchivedWorkspaceSummary,
  type PortalCredentialSummary,
  type PortalCredentialCatalog,
  type PortalCredentialRecord,
  type PortalSkillSummary,
  type PortalWorkspaceAssetPreview,
  type PortalWorkspaceAgentBindingResult,
  type PortalDriverTarget,
  type PortalWorkspaceDetail,
  type PortalWorkspaceDetailStatic,
  type PortalProfileSummary,
  type PortalWorkspaceStaticSummary,
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
  deletePortalWorkspace as deletePortalWorkspaceExecutor,
  getPortalWorkspacePaseoDiagnostic as getPortalWorkspacePaseoDiagnosticExecutor,
  permanentlyDeletePortalArchivedWorkspace as permanentlyDeletePortalArchivedWorkspaceExecutor,
  permanentlyDeletePortalWorkspace as permanentlyDeletePortalWorkspaceExecutor,
  queueProvisionWorkspace as queueProvisionWorkspaceExecutor,
  refreshPortalWorkspaceStatus as refreshPortalWorkspaceStatusExecutor,
  rebuildPortalWorkspace as rebuildPortalWorkspaceExecutor,
  restartPortalWorkspacePaseoDaemon as restartPortalWorkspacePaseoDaemonExecutor,
  updatePortalWorkspaceSelectedDriver as updatePortalWorkspaceSelectedDriverExecutor,
  installPortalWorkspaceSkill as installPortalWorkspaceSkillExecutor,
  listPortalWorkspaceSkills as listPortalWorkspaceSkillsExecutor,
  startPortalWorkspace as startPortalWorkspaceExecutor,
  stopPortalWorkspace as stopPortalWorkspaceExecutor,
  switchPortalWorkspace as switchPortalWorkspaceExecutor,
  switchPortalWorkspaceLiveCredential as switchPortalWorkspaceLiveCredentialExecutor,
  syncPortalWorkspaceSkills as syncPortalWorkspaceSkillsExecutor,
  uninstallPortalWorkspaceSkill as uninstallPortalWorkspaceSkillExecutor,
} from "../executor/client.js";
import {
  getPortalAiAccess as getPortalAiAccessView,
  performPortalAiAccessAction as performPortalAiAccessActionView,
  type PortalAiAccessActionKind,
  type PortalAiAccessView,
} from "./ai-access.js";

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
  return workspaces.map((workspace) => loadWorkspaceSummary(userId, workspace));
}

export async function listPortalWorkspaceStaticState(
  userId: string,
): Promise<PortalWorkspaceStaticSummary[]> {
  return listPortalWorkspaceStaticSummaries(userId);
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
        workspaces: listOwnedWorkspaces(userId),
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
  return loadWorkspaceDetail(userId, workspace);
}

export async function getPortalWorkspaceDetailStatic(
  userId: string,
  workspace: string,
): Promise<PortalWorkspaceDetailStatic> {
  return loadWorkspaceDetailStatic(userId, workspace);
}

export function listUserPortalCredentials(
  userId: string,
): PortalCredentialSummary[] {
  return listPortalCredentials(userId);
}

export function listUserPortalSkills(
  userId: string,
): PortalSkillSummary[] {
  return listUserSkills(userId);
}

export function getPortalCredentialCatalog(): PortalCredentialCatalog {
  return credentialCatalog();
}

export function readUserPortalCredentialRecord(
  userId: string,
  credentialId: string,
): PortalCredentialRecord {
  const record = readManagedCredentialRecord({
    userProfileId: userId,
    credentialId,
  });
  return {
    credential: record.summary,
    files: record.files,
  };
}

export function readUserPortalWorkspaceAssetPreview(
  userId: string,
  workspace: string,
  assetPath: string,
): PortalWorkspaceAssetPreview {
  return readPortalWorkspaceAssetPreview(userId, workspace, assetPath);
}

export function readUserPortalCredentialPreview(
  userId: string,
  assetPath: string,
): PortalWorkspaceAssetPreview {
  const normalized = assetPath.replace(/\\/g, "/").trim();
  if (!normalized.startsWith("credentials/")) {
    throw new Error("credential preview path must stay under credentials/");
  }
  return {
    path: normalized,
    content: "[credential preview hidden]",
    truncated: false,
  };
}

export async function getPortalAiAccess(
  userId: string,
): Promise<PortalAiAccessView> {
  return withUserMutationLock(import.meta.url, userId, async () =>
    getPortalAiAccessView(userId),
  );
}

export async function performPortalAiAccessAction(input: {
  userId: string;
  action: PortalAiAccessActionKind;
}): Promise<PortalAiAccessView> {
  return withUserMutationLock(import.meta.url, input.userId, async () =>
    performPortalAiAccessActionView(input.userId, input.action),
  );
}

export async function createPortalSkill(input: {
  userId: string;
  harness: SkillHarness;
  source: string;
  skillId?: string;
  skillName: string;
}): Promise<PortalSkillSummary> {
  const descriptor = createSkillsCliDescriptor({
    source: input.source,
    harness: input.harness,
    selectedSkillName: input.skillName,
  });
  return withUserMutationLock(import.meta.url, input.userId, async () =>
    addUserSkill({
      userProfileId: input.userId,
      skillId: input.skillId?.trim() || descriptor.suggestedSkillId,
      harness: input.harness,
      packageName: descriptor.packageName,
      args: descriptor.args,
      source: descriptor.source,
      selectedSkillName: descriptor.selectedSkillName,
    })
  );
}

export async function deletePortalSkill(
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
  return withUserMutationLock(import.meta.url, userId, async () => ({
    skill: removeUserSkill({
      userProfileId: userId,
      skillId,
    }),
  }));
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

export async function listPortalWorkspaceSkills(input: {
  userId: string;
  workspace: string;
  harness: SkillHarness;
}): Promise<{
  workspace: string;
  userId: string;
  installed: Array<{ harness: SkillHarness; skills: string[] }>;
}> {
  return listPortalWorkspaceSkillsExecutor(input);
}

export async function installPortalWorkspaceSkill(input: {
  userId: string;
  workspace: string;
  harness: SkillHarness;
  skillId: string;
}): Promise<{
  installed: true;
  workspace: string;
  userId: string;
  harness: SkillHarness;
  skillId: string;
  packageName: string;
}> {
  return installPortalWorkspaceSkillExecutor(input);
}

export async function uninstallPortalWorkspaceSkill(input: {
  userId: string;
  workspace: string;
  harness: SkillHarness;
  skillId: string;
}): Promise<{
  uninstalled: true;
  workspace: string;
  userId: string;
  harness: SkillHarness;
  skillId: string;
  removed: boolean;
}> {
  return uninstallPortalWorkspaceSkillExecutor(input);
}

export async function syncPortalWorkspaceSkills(input: {
  userId: string;
  workspace: string;
  harness: SkillHarness;
}): Promise<{
  synced: true;
  workspace: string;
  userId: string;
  harness: SkillHarness;
  installed: string[];
  removed: string[];
}> {
  return syncPortalWorkspaceSkillsExecutor(input);
}

export async function bindPortalWorkspaceAgent(input: {
  userId: string;
  workspace: string;
  driver: PortalDriverTarget;
  credentialId: string;
}): Promise<PortalWorkspaceAgentBindingResult> {
  const updated = updatePortalWorkspaceAgentBinding({
    userId: input.userId,
    workspace: input.workspace,
    target: input.driver,
    credentialId: input.credentialId,
    enabled: true,
  });
  await refreshPortalWorkspaceStatus(input.userId, input.workspace);
  return {
    enabled: true,
    driver: workspaceRefFromTarget(input.workspace, input.driver),
    restarted: true,
    credentialBindings: updated.credentialBindings,
  };
}

export async function unbindPortalWorkspaceAgent(input: {
  userId: string;
  workspace: string;
  driver: PortalDriverTarget;
}): Promise<PortalWorkspaceAgentBindingResult> {
  const updated = updatePortalWorkspaceAgentBinding({
    userId: input.userId,
    workspace: input.workspace,
    target: input.driver,
    enabled: false,
  });
  await refreshPortalWorkspaceStatus(input.userId, input.workspace);
  return {
    enabled: false,
    driver: workspaceRefFromTarget(input.workspace, input.driver),
    restarted: true,
    credentialBindings: updated.credentialBindings,
  };
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

export async function writePortalCredentialFile(input: {
  userId: string;
  credentialId: string;
  fileKey: string;
  content: string;
}): Promise<PortalCredentialRecord> {
  return withUserMutationLock(import.meta.url, input.userId, async () => {
    writeManagedCredentialMaterialFile({
      userProfileId: input.userId,
      credentialId: input.credentialId,
      fileKey: input.fileKey,
      content: input.content,
    });
    return readUserPortalCredentialRecord(input.userId, input.credentialId);
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

export async function cancelPortalWorkspaceProvision(
  userId: string,
  workspace: string,
): Promise<{ cancelled: true; workspace: string }> {
  writeWorkspaceProvisionProgress(userId, workspace, {
    userId,
    workspace,
    phase: "cancelled",
    status: "cancelled",
    message: "workspace provision cancelled",
    errorCode: "workspace-provision-cancelled",
    retryable: true,
    done: true,
    updatedAt: new Date().toISOString(),
  });
  return {
    cancelled: true,
    workspace,
  };
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

export async function permanentlyDeletePortalWorkspace(
  userId: string,
  workspace: string,
): Promise<{ deleted: true; workspace: string }> {
  return permanentlyDeletePortalWorkspaceExecutor({ userId, workspace });
}

export async function permanentlyDeletePortalArchivedWorkspace(
  userId: string,
  archiveId: string,
): Promise<{ deleted: true; archiveId: string }> {
  return permanentlyDeletePortalArchivedWorkspaceExecutor({ userId, archiveId });
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

export async function rebuildPortalWorkspace(
  userId: string,
  workspace: string,
): Promise<{ rebuilt: true }> {
  return rebuildPortalWorkspaceExecutor({ userId, workspace });
}

export async function updatePortalWorkspaceSelectedDriver(input: {
  userId: string;
  workspace: string;
  target: PortalDriverTarget;
}): Promise<{ updated: true }> {
  return updatePortalWorkspaceSelectedDriverExecutor(input);
}

export async function refreshPortalWorkspace(
  userId: string,
  workspace: string,
): Promise<{ refreshed: true }> {
  await refreshPortalWorkspaceStatus(userId, workspace);
  return { refreshed: true };
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

export async function getPortalWorkspacePaseoDiagnostic(input: {
  userId: string;
  workspace: string;
}) {
  return getPortalWorkspacePaseoDiagnosticExecutor(input);
}

export async function restartPortalWorkspacePaseoDaemon(input: {
  userId: string;
  workspace: string;
}) {
  return restartPortalWorkspacePaseoDaemonExecutor(input);
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
