import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
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
  readPortalProfile,
  listOwnedWorkspaces,
  listPortalCredentials,
  readPortalCredentialPreview,
  readPortalWorkspaceAssetPreview,
  loadWorkspaceDetail,
  loadWorkspaceSummary,
  type PortalCredentialSummary,
  type PortalCredentialPreview,
  type PortalCredentialCatalog,
  type PortalWorkspaceAssetPreview,
  type PortalDriverTarget,
  type PortalWorkspaceDetail,
  type PortalWorkspaceSummary,
} from "../core/portal.js";
import { createUserCommand } from "../cli/commands/create-user.js";
import { deleteUserCommand } from "../cli/commands/delete-user.js";
import {
  bindPortalWorkspaceAgent as bindPortalWorkspaceAgentExecutor,
  deletePortalWorkspace as deletePortalWorkspaceExecutor,
  queueProvisionWorkspace as queueProvisionWorkspaceExecutor,
  refreshPortalWorkspaceStatus as refreshPortalWorkspaceStatusExecutor,
  startPortalWorkspace as startPortalWorkspaceExecutor,
  stopPortalWorkspace as stopPortalWorkspaceExecutor,
  switchPortalWorkspace as switchPortalWorkspaceExecutor,
  switchPortalWorkspaceLiveCredential as switchPortalWorkspaceLiveCredentialExecutor,
  unbindPortalWorkspaceAgent as unbindPortalWorkspaceAgentExecutor,
} from "../executor/client.js";
import { resolveRepoRoot } from "../utils/repo-root.js";
import { deleteClerkUsersByUsername } from "./clerk.js";

const REPO_ROOT = resolveRepoRoot(import.meta.url);
const statusRefreshJobs = new Map<string, Promise<void>>();

function parseJsonFromText<T>(value: string): T {
  const trimmed = value.trim();
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonEnd === -1) {
    throw new Error(
      `No JSON object found in output: ${JSON.stringify(trimmed)}`,
    );
  }
  for (
    let jsonStart = trimmed.lastIndexOf("{", jsonEnd);
    jsonStart !== -1;
    jsonStart = trimmed.lastIndexOf("{", jsonStart - 1)
  ) {
    try {
      return JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as T;
    } catch {
      continue;
    }
  }
  throw new Error(
    `No JSON object found in output: ${JSON.stringify(trimmed)}`,
  );
}

function rootKey(userId: string, workspace: string): string {
  return `${userId}:${workspace}`;
}

async function captureStdout<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string }> {
  const stdoutChunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    stdoutChunks.push(
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString("utf8"),
    );
    const callback = args.find(
      (arg) => typeof arg === "function",
    ) as (() => void) | undefined;
    callback?.();
    return true;
  }) as typeof process.stdout.write;

  try {
    const result = await fn();
    return { result, stdout: stdoutChunks.join("").trim() };
  } finally {
    process.stdout.write = originalWrite;
  }
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

export function listPortalWorkspaces(userId: string): PortalWorkspaceSummary[] {
  return listOwnedWorkspaces(userId).map((workspace) =>
    loadWorkspaceSummary(userId, workspace),
  );
}

export function getPortalWorkspaceDetail(
  userId: string,
  workspace: string,
): PortalWorkspaceDetail {
  void refreshPortalWorkspaceStatus(userId, workspace);
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
  return {
    credential: deleteManagedCredential({
      userProfileId: userId,
      credentialId,
    }),
  };
}

export async function activatePortalCredential(
  userId: string,
  credentialId: string,
): Promise<PortalCredentialSummary> {
  const activated = activateManagedCredential({
    userProfileId: userId,
    credentialId,
  });
  const summary = listPortalCredentials(userId).find((credential) => credential.id === activated.id);
  if (!summary) {
    throw new Error(`Credential '${activated.id}' could not be loaded after activation`);
  }
  return summary;
}

export function upsertPortalCredential(
  userId: string,
  credential: {
    id: string;
    kind: PortalCredentialSummary["kind"];
    label: string;
    purposes: string[];
    status?: string;
    files: Array<{
      key: string;
      sourcePath: string;
      content: string;
      mountPath?: string;
    }>;
  },
): PortalCredentialSummary {
  const credentialsRoot = path.join(
    REPO_ROOT,
    "config",
    "users",
    userId,
    "credentials",
  );
  fs.mkdirSync(credentialsRoot, { recursive: true });
  for (const file of credential.files) {
    const absolute = path.join(
      REPO_ROOT,
      "config",
      "users",
      userId,
      file.sourcePath,
    );
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, file.content, "utf8");
  }
  const document = {
    id: credential.id,
    userId,
    kind: credential.kind,
    label: credential.label,
    purposes: credential.purposes,
    materialRef: {
      type: "file",
      key: credential.id,
      files: credential.files.map((file) => ({
        key: file.key,
        source_path: file.sourcePath,
        ...(file.mountPath ? { mount_path: file.mountPath } : {}),
      })),
    },
    metadata: {
      source: "portal",
    },
    status: credential.status ?? "ready",
  };
  const outputPath = path.join(credentialsRoot, `${credential.id}.yaml`);
  fs.writeFileSync(
    outputPath,
    `${yaml.dump(document, { lineWidth: 120, noRefs: true })}`,
    "utf8",
  );
  return {
    id: credential.id,
    kind: credential.kind,
    label: credential.label,
    purposes: credential.purposes,
    status: credential.status ?? "ready",
    paths: credential.files.map((file) => file.sourcePath),
    active: false,
    liveSwitchSupported: false,
  };
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
): Promise<{ removed: true }> {
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
    "--role",
    input.role ?? "user",
    "--plan",
    input.plan ?? "free",
  ]);
  const created = readPortalProfile(userProfileId);
  if (!created) {
    throw new Error(
      `User profile '${userProfileId}' could not be loaded after creation`,
    );
  }
  return created;
}

export async function deletePortalUser(userProfileId: string): Promise<{
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
  const { stdout } = await captureStdout(async () => {
    await deleteUserCommand([userProfileId]);
  });
  const deleted = parseJsonFromText<{
    userProfile: {
      id: string;
      removed: boolean;
      profilePath: string;
      secretsRoot: string;
    };
    mappings: {
      removedClerkUsernames: string[];
    };
  }>(stdout);
  const clerkPayload = await deleteClerkUsersByUsername(
    deleted.mappings.removedClerkUsernames,
  );
  return {
    ...deleted,
    clerk: {
      removedUserIds: clerkPayload.removedUserIds,
    },
  };
}
