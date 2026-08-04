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
  clearVaultProvisionProgress,
  listPortalProfiles,
  listPortalVaultStaticSummaries,
  readPortalProfile,
  listOwnedVaults,
  listPortalCredentials,
  readPortalProfileAuthCredentialRecord,
  writeVaultProvisionProgress,
  readPortalVaultAssetPreview,
  loadVaultDetailStatic,
  loadVaultDetail,
  loadVaultSummary,
  updatePortalProfile,
  updatePortalVaultAgentBinding,
  vaultRefFromTarget,
  type PortalCredentialSummary,
  type PortalCredentialCatalog,
  type PortalCredentialRecord,
  type PortalSkillSummary,
  type PortalVaultAssetPreview,
  type PortalVaultAgentBindingResult,
  type PortalDriverTarget,
  type PortalVaultDetail,
  type PortalVaultDetailStatic,
  type PortalProfileSummary,
  type PortalVaultStaticSummary,
  type PortalVaultSummary,
} from "../core/portal.js";
import type { VaultStatus } from "../core/vault.js";
import type { DurableJob } from "./control-store.js";
import { createUserCommand } from "../cli/commands/create-user.js";
import { deleteUserCommand } from "../cli/commands/delete-user.js";
import {
  listUserAccessSummaries,
  readUserAccessSummary,
  updateUserAccessEntry,
  type PortalUserAccessSummary,
} from "./user-map.js";
import { polarisUsersRoot } from "../utils/paths.js";
import { withUserMutationLock } from "../utils/user-mutation-lock.js";
import {
  deletePortalVault as deletePortalVaultExecutor,
  getWanghaiBackupJob as getWanghaiBackupJobExecutor,
  getPortalVaultPaseoDiagnostic as getPortalVaultPaseoDiagnosticExecutor,
  permanentlyDeletePortalVault as permanentlyDeletePortalVaultExecutor,
  queueProvisionVault as queueProvisionVaultExecutor,
  queueWanghaiBackup as queueWanghaiBackupExecutor,
  requestWanghaiBackupCancellation as requestWanghaiBackupCancellationExecutor,
  requestProvisionCancellation as requestProvisionCancellationExecutor,
  refreshPortalVaultStatus as refreshPortalVaultStatusExecutor,
  rebuildPortalVault as rebuildPortalVaultExecutor,
  restartPortalVaultPaseoDaemon as restartPortalVaultPaseoDaemonExecutor,
  updatePortalVaultSelectedDriver as updatePortalVaultSelectedDriverExecutor,
  skillInstallVault as installPortalVaultSkillExecutor,
  listVaultSkills as listPortalVaultSkillsExecutor,
  startPortalVault as startPortalVaultExecutor,
  stopPortalVault as stopPortalVaultExecutor,
  switchPortalVault as switchPortalVaultExecutor,
  switchPortalVaultLiveCredential as switchPortalVaultLiveCredentialExecutor,
  skillSyncVault as syncPortalVaultSkillsExecutor,
  skillUninstallVault as uninstallPortalVaultSkillExecutor,
} from "../runtime/operations.js";

const USER_ROOT = polarisUsersRoot(import.meta.url);
const statusRefreshJobs = new Map<string, Promise<void>>();

export interface PortalWanghaiBackupJob {
  id: string;
  status: DurableJob["status"];
  attempts: number;
  maxAttempts: number;
  cancelRequested: boolean;
  errorCode?: string;
  errorMessage?: string;
  result?: {
    archiveName: string;
    checksumVerified: boolean;
    retentionCount: number;
  };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

function portalWanghaiBackupJob(job: DurableJob): PortalWanghaiBackupJob {
  const result = job.result;
  const archiveName = typeof result?.archiveName === "string" ? result.archiveName : "";
  const checksumVerified = result?.checksumVerified === true;
  const retentionCount = Number(result?.retentionCount);
  return {
    id: job.id,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    cancelRequested: job.cancelRequested,
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    ...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
    ...(archiveName && checksumVerified && Number.isSafeInteger(retentionCount)
      && retentionCount > 0
      ? {
          result: {
            archiveName,
            checksumVerified,
            retentionCount,
          },
        }
      : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
  };
}

function rootKey(userId: string, vault: string): string {
  return `${userId}:${vault}`;
}

async function refreshPortalVaultStatus(
  userId: string,
  vault: string,
): Promise<void> {
  const key = rootKey(userId, vault);
  const existing = statusRefreshJobs.get(key);
  if (existing) {
    return existing;
  }
  const job = (async () => {
    try {
      await refreshPortalVaultStatusExecutor(userId, vault);
    } finally {
      statusRefreshJobs.delete(key);
    }
  })();
  statusRefreshJobs.set(key, job);
  return job;
}

export async function listPortalVaults(userId: string): Promise<PortalVaultSummary[]> {
  const vaults = listOwnedVaults(userId);
  return vaults.map((vault) => loadVaultSummary(userId, vault));
}

export async function listPortalVaultStaticState(
  userId: string,
): Promise<PortalVaultStaticSummary[]> {
  return listPortalVaultStaticSummaries(userId);
}

export function listPortalAdminUsers(): Array<
  PortalProfileSummary &
  Partial<PortalUserAccessSummary> &
  {
    credentialCount: number;
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
        vaults: listOwnedVaults(userId),
      };
      const baseAccess = access ?? {
        polarisUserId: userId,
        role: "user" as const,
        plan: "free" as const,
        line: "coding" as const,
        authingUsernames: [],
        authingUserIds: [],
      };
      return {
        ...baseProfile,
        ...baseAccess,
        credentialCount: listPortalCredentials(userId).length,
        mappingPresent: Boolean(access),
        profilePresent: Boolean(profile),
        userRootPresent,
        integrityStatus,
      };
    });
}

export async function getPortalVaultDetail(
  userId: string,
  vault: string,
) : Promise<PortalVaultDetail> {
  return loadVaultDetail(userId, vault);
}

export async function getPortalVaultDetailStatic(
  userId: string,
  vault: string,
): Promise<PortalVaultDetailStatic> {
  return loadVaultDetailStatic(userId, vault);
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
  try {
    const record = readManagedCredentialRecord({
      userProfileId: userId,
      credentialId,
    });
    return {
      credential: record.summary,
      files: record.files,
    };
  } catch (error) {
    const profileRecord = readPortalProfileAuthCredentialRecord(userId, credentialId);
    if (profileRecord) {
      return profileRecord;
    }
    throw error;
  }
}

export function readUserPortalVaultAssetPreview(
  userId: string,
  vault: string,
  assetPath: string,
): PortalVaultAssetPreview {
  return readPortalVaultAssetPreview(userId, vault, assetPath);
}

export function readUserPortalCredentialPreview(
  userId: string,
  assetPath: string,
): PortalVaultAssetPreview {
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

export async function listPortalVaultSkills(input: {
  userId: string;
  vault: string;
  harness: SkillHarness;
}): Promise<{
  vault: string;
  userId: string;
  installed: Array<{ harness: SkillHarness; skills: string[] }>;
}> {
  return listPortalVaultSkillsExecutor({
    vaultRef: input.vault,
    userProfileId: input.userId,
    harness: input.harness,
  });
}

export async function installPortalVaultSkill(input: {
  userId: string;
  vault: string;
  harness: SkillHarness;
  skillId: string;
}): Promise<{
  installed: true;
  vault: string;
  userId: string;
  harness: SkillHarness;
  skillId: string;
  packageName: string;
}> {
  return installPortalVaultSkillExecutor({
    vaultRef: input.vault,
    userProfileId: input.userId,
    harness: input.harness,
    skillId: input.skillId,
  });
}

export async function uninstallPortalVaultSkill(input: {
  userId: string;
  vault: string;
  harness: SkillHarness;
  skillId: string;
}): Promise<{
  uninstalled: true;
  vault: string;
  userId: string;
  harness: SkillHarness;
  skillId: string;
  removed: boolean;
}> {
  return uninstallPortalVaultSkillExecutor({
    vaultRef: input.vault,
    userProfileId: input.userId,
    harness: input.harness,
    skillId: input.skillId,
  });
}

export async function syncPortalVaultSkills(input: {
  userId: string;
  vault: string;
  harness: SkillHarness;
}): Promise<{
  synced: true;
  vault: string;
  userId: string;
  harness: SkillHarness;
  installed: string[];
  removed: string[];
}> {
  return syncPortalVaultSkillsExecutor({
    vaultRef: input.vault,
    userProfileId: input.userId,
    harness: input.harness,
  });
}

export async function bindPortalVaultAgent(input: {
  userId: string;
  vault: string;
  driver: PortalDriverTarget;
  credentialId: string;
}): Promise<PortalVaultAgentBindingResult> {
  const updated = updatePortalVaultAgentBinding({
    userId: input.userId,
    vault: input.vault,
    target: input.driver,
    credentialId: input.credentialId,
    enabled: true,
  });
  await refreshPortalVaultStatus(input.userId, input.vault);
  return {
    enabled: true,
    driver: vaultRefFromTarget(input.vault, input.driver),
    restarted: true,
    credentialBindings: updated.credentialBindings,
  };
}

export async function unbindPortalVaultAgent(input: {
  userId: string;
  vault: string;
  driver: PortalDriverTarget;
}): Promise<PortalVaultAgentBindingResult> {
  const updated = updatePortalVaultAgentBinding({
    userId: input.userId,
    vault: input.vault,
    target: input.driver,
    enabled: false,
  });
  await refreshPortalVaultStatus(input.userId, input.vault);
  return {
    enabled: false,
    driver: vaultRefFromTarget(input.vault, input.driver),
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

export async function queueProvisionVault(
  userId: string,
  vault: string,
  options?: {
    defaultDockerOnly?: boolean;
    startAfterCreate?: boolean;
    line?: "coding" | "vertical";
  },
) {
  return queueProvisionVaultExecutor(userId, vault, {
    defaultDockerOnly: options?.defaultDockerOnly,
    startAfterCreate: options?.startAfterCreate,
    line: options?.line,
  });
}

export async function queuePortalWanghaiBackup(input: {
  actorId: string;
  userId: string;
  vault: string;
  idempotencyKey: string;
}): Promise<PortalWanghaiBackupJob> {
  return portalWanghaiBackupJob(await queueWanghaiBackupExecutor({
    actorId: input.actorId,
    tenantId: input.userId,
    vaultId: input.vault,
    idempotencyKey: input.idempotencyKey,
  }));
}

export function getPortalWanghaiBackupJob(input: {
  userId: string;
  vault: string;
  jobId: string;
}): PortalWanghaiBackupJob | null {
  const job = getWanghaiBackupJobExecutor({
    tenantId: input.userId,
    vaultId: input.vault,
    jobId: input.jobId,
  });
  return job ? portalWanghaiBackupJob(job) : null;
}

export function cancelPortalWanghaiBackup(input: {
  actorId: string;
  userId: string;
  vault: string;
  jobId: string;
}): boolean {
  return requestWanghaiBackupCancellationExecutor({
    actorId: input.actorId,
    tenantId: input.userId,
    vaultId: input.vault,
    jobId: input.jobId,
  });
}

export async function cancelPortalVaultProvision(
  userId: string,
  vault: string,
): Promise<{ cancelled: true; vault: string }> {
  if (!requestProvisionCancellationExecutor(userId, vault)) {
    throw new Error(`Vault '${vault}' does not have a pending provision job`);
  }
  writeVaultProvisionProgress(userId, vault, {
    userId,
    vault,
    phase: "cancelled",
    status: "cancelled",
    message: "vault provision cancelled",
    errorCode: "vault-provision-cancelled",
    retryable: true,
    done: true,
    updatedAt: new Date().toISOString(),
  });
  return {
    cancelled: true,
    vault,
  };
}

export async function switchPortalVault(
  userId: string,
  vault: string,
  target: PortalDriverTarget,
) {
  return switchPortalVaultExecutor(userId, vault, target);
}

export async function deletePortalVault(
  userId: string,
  vault: string,
): Promise<{ deleted: true; vault: string }> {
  return deletePortalVaultExecutor(userId, vault);
}

export async function permanentlyDeletePortalVault(
  userId: string,
  vault: string,
): Promise<{ deleted: true; vault: string }> {
  return permanentlyDeletePortalVaultExecutor(userId, vault);
}


export async function stopPortalVault(
  userId: string,
  vault: string,
): Promise<{ stopped: true }> {
  return stopPortalVaultExecutor(userId, vault);
}

export async function startPortalVault(
  userId: string,
  vault: string,
): Promise<{ started: true }> {
  return startPortalVaultExecutor(userId, vault);
}

export async function rebuildPortalVault(
  userId: string,
  vault: string,
): Promise<{ rebuilt: true }> {
  return rebuildPortalVaultExecutor(userId, vault);
}

export async function updatePortalVaultSelectedDriver(input: {
  userId: string;
  vault: string;
  target: PortalDriverTarget;
}): Promise<{ updated: true }> {
  return updatePortalVaultSelectedDriverExecutor(input);
}

export async function refreshPortalVault(
  userId: string,
  vault: string,
): Promise<{ refreshed: true }> {
  await refreshPortalVaultStatus(userId, vault);
  return { refreshed: true };
}

export async function switchPortalVaultLiveCredential(input: {
  userId: string;
  vault: string;
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
  await switchPortalVaultLiveCredentialExecutor(input);
  return {
    switched: true,
    harness: input.harness,
    credential: summary,
  };
}

export async function getPortalVaultPaseoDiagnostic(input: {
  userId: string;
  vault: string;
}) {
  return getPortalVaultPaseoDiagnosticExecutor(input);
}

export async function restartPortalVaultPaseoDaemon(input: {
  userId: string;
  vault: string;
}) {
  return restartPortalVaultPaseoDaemonExecutor(input);
}

export async function createPortalUser(input: {
  userProfileId?: string;
  authingUsername?: string;
  authingUserId?: string;
  email?: string;
  name?: string;
  referralCode?: string;
  role?: "admin" | "user";
  plan?: "free" | "pro";
  line?: "coding" | "vertical" | "both";
}): Promise<NonNullable<ReturnType<typeof readPortalProfile>>> {
  const userProfileId =
    input.userProfileId?.trim()
    || input.authingUsername?.trim()
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
    ...(input.authingUsername?.trim() ? ["--authing", input.authingUsername.trim()] : []),
    ...(input.authingUserId?.trim() ? ["--authing-user-id", input.authingUserId.trim()] : []),
    ...(input.referralCode?.trim() ? ["--referred-by-code", input.referralCode.trim()] : []),
    ...(input.role ? ["--role", input.role] : []),
    ...(input.plan ? ["--plan", input.plan] : []),
    ...(input.line ? ["--line", input.line] : []),
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

export async function updatePortalUserAccess(
  userId: string,
  patch: {
    role?: "admin" | "user";
    plan?: "free" | "pro";
    line?: "coding" | "vertical" | "both";
  },
): Promise<PortalUserAccessSummary> {
  if (!patch.role && !patch.plan && !patch.line) {
    throw new Error("At least one access field is required");
  }
  return updateUserAccessEntry(userId, patch);
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
