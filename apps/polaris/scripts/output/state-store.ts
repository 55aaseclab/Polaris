import fs from "node:fs";
import path from "node:path";
import type { WorkspaceStatus } from "../core/workspace.js";
import { assertNoProjectNameCollision } from "../config/project-ownership.js";
import { polarisStateRoot, polarisUsersRoot } from "../utils/paths.js";

const LEGACY_STATE_DIR = polarisStateRoot(import.meta.url);
const USER_ROOT = polarisUsersRoot(import.meta.url);

export interface WorkspaceDriverSelection {
  backend: "docker" | "pod" | "kubevirt-vm";
  profile?: string;
}

export interface WorkspaceLiveCredentialSelectionState {
  harness: string;
  credentialId: string;
  updatedAt: string;
}

function projectRoot(project: string, userProfileId?: string): string | null {
  if (userProfileId?.trim()) {
    const candidate = path.join(
      USER_ROOT,
      userProfileId.trim(),
      "workspaces",
      project,
    );
    return fs.existsSync(candidate) ? candidate : null;
  }

  if (!fs.existsSync(USER_ROOT)) {
    return null;
  }
  assertNoProjectNameCollision(project);

  const matches = fs
    .readdirSync(USER_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(USER_ROOT, entry.name, "workspaces", project))
    .filter((candidate) => fs.existsSync(candidate))
    .sort();

  return matches[0] ?? null;
}

export function workspaceStateDir(project: string, userProfileId?: string): string {
  const root = projectRoot(project, userProfileId);
  return root ? path.join(root, "state") : LEGACY_STATE_DIR;
}

export function workspaceStatusPath(project: string, userProfileId?: string): string {
  const stateDir = workspaceStateDir(project, userProfileId);
  if (stateDir === LEGACY_STATE_DIR) {
    return path.join(stateDir, `${project}.status.json`);
  }
  return path.join(stateDir, "status.json");
}

export function workspaceSelectionPath(project: string, userProfileId?: string): string {
  const stateDir = workspaceStateDir(project, userProfileId);
  if (stateDir === LEGACY_STATE_DIR) {
    return path.join(stateDir, `${project}.selection.json`);
  }
  return path.join(stateDir, "selection.json");
}

export function workspaceLiveCredentialsPath(
  project: string,
  userProfileId?: string,
): string {
  const stateDir = workspaceStateDir(project, userProfileId);
  if (stateDir === LEGACY_STATE_DIR) {
    return path.join(stateDir, `${project}.live-credentials.json`);
  }
  return path.join(stateDir, "live-credentials.json");
}

function legacyWorkspaceStatusPath(project: string): string {
  return path.join(LEGACY_STATE_DIR, `${project}.status.json`);
}

function legacyWorkspaceSelectionPath(project: string): string {
  return path.join(LEGACY_STATE_DIR, `${project}.selection.json`);
}

function legacyWorkspaceLiveCredentialsPath(project: string): string {
  return path.join(LEGACY_STATE_DIR, `${project}.live-credentials.json`);
}

export function workspaceEvolutionStateDir(project: string, userProfileId?: string): string {
  return path.join(workspaceStateDir(project, userProfileId), "evolution");
}

export function workspacePaseoStateDir(project: string, userProfileId?: string): string {
  return path.join(workspaceStateDir(project, userProfileId), "paseo");
}

function readWorkspaceStatusFile(filePath: string): WorkspaceStatus | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as WorkspaceStatus;
  } catch {
    return null;
  }
}

function mergeWorkspaceStatus(
  current: WorkspaceStatus | null,
  incoming: WorkspaceStatus,
): WorkspaceStatus {
  if (!current) {
    return incoming;
  }
  const driver = current.driver || incoming.driver
    ? {
        ...(current.driver ?? {}),
        ...(incoming.driver ?? {}),
      }
    : undefined;
  const codexCredentials = current.credentials?.codex || incoming.credentials?.codex
    ? {
        ...(current.credentials?.codex ?? {}),
        ...(incoming.credentials?.codex ?? {}),
      }
    : undefined;
  const sshCredentials = current.credentials?.ssh || incoming.credentials?.ssh
    ? {
        ...(current.credentials?.ssh ?? {}),
        ...(incoming.credentials?.ssh ?? {}),
        selfCheck: {
          ...(current.credentials?.ssh?.selfCheck ?? { state: "not-configured", message: "" }),
          ...(incoming.credentials?.ssh?.selfCheck ?? {}),
        },
      }
    : undefined;
  const liveCredentials = current.credentials?.live || incoming.credentials?.live
    ? {
        ...(current.credentials?.live ?? {}),
        ...(incoming.credentials?.live ?? {}),
        selectedByHarness: {
          ...(current.credentials?.live?.selectedByHarness ?? {}),
          ...(incoming.credentials?.live?.selectedByHarness ?? {}),
        },
      }
    : undefined;
  const credentials = codexCredentials || sshCredentials || liveCredentials
    ? {
        ...(current.credentials ?? {}),
        ...(incoming.credentials ?? {}),
        ...(sshCredentials ? { ssh: sshCredentials } : {}),
        ...(codexCredentials ? { codex: codexCredentials } : {}),
        ...(liveCredentials ? { live: liveCredentials } : {}),
      }
    : undefined;
  const evolution = current.evolution || incoming.evolution
    ? {
        ...(current.evolution ?? {}),
        ...(incoming.evolution ?? {}),
        latestArtifacts: incoming.evolution?.latestArtifacts ?? current.evolution?.latestArtifacts,
        latestTitles: incoming.evolution?.latestTitles ?? current.evolution?.latestTitles ?? [],
      }
    : undefined;
  const merged: WorkspaceStatus = {
    ...current,
    ...incoming,
    project: incoming.project,
    lifecycleAction: incoming.lifecycleAction ?? current.lifecycleAction,
    health: {
      backendLiveness: incoming.health.backendLiveness ?? current.health.backendLiveness,
      workspaceReadiness: incoming.health.workspaceReadiness ?? current.health.workspaceReadiness,
      reason: Object.prototype.hasOwnProperty.call(incoming.health, "reason")
        ? incoming.health.reason
        : current.health.reason,
    },
    details: {
      ...current.details,
      ...incoming.details,
    },
    assets: incoming.assets ?? current.assets,
    attachments: incoming.attachments ?? current.attachments,
    runtimeAssembly: incoming.runtimeAssembly ?? current.runtimeAssembly,
  };
  if (driver?.backend && driver.baseImage && driver.runtimeKind && driver.runtimeRef) {
    merged.driver = driver as NonNullable<WorkspaceStatus["driver"]>;
  }
  if (sshCredentials?.mode || codexCredentials?.state || liveCredentials) {
    merged.credentials = credentials as NonNullable<WorkspaceStatus["credentials"]>;
  }
  if (
    typeof evolution?.artifactCount === "number"
    && typeof evolution.activeWorkspaceArtifacts === "number"
    && typeof evolution.activeUserArtifacts === "number"
    && Array.isArray(evolution.latestTitles)
  ) {
    merged.evolution = evolution as NonNullable<WorkspaceStatus["evolution"]>;
  }
  delete ((merged as unknown) as Record<string, unknown>).paseo;
  delete ((merged as unknown) as Record<string, unknown>).daemon;
  delete ((merged as unknown) as Record<string, unknown>).ssh;
  delete ((merged as unknown) as Record<string, unknown>).drift;
  return merged;
}

export function writeWorkspaceStatus(status: WorkspaceStatus, userProfileId?: string): string {
  const outputPath = workspaceStatusPath(status.project, userProfileId);
  const current = readWorkspaceStatusFile(outputPath);
  const next = mergeWorkspaceStatus(current, status);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  if (outputPath !== legacyWorkspaceStatusPath(status.project)) {
    fs.rmSync(legacyWorkspaceStatusPath(status.project), { force: true });
  }
  return outputPath;
}

export function writeWorkspacePaseoServerId(
  project: string,
  serverId: string,
  userProfileId?: string,
): string {
  const outputPath = path.join(
    workspacePaseoStateDir(project, userProfileId),
    "server-id",
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${serverId.trim()}\n`, "utf8");
  return outputPath;
}

export function writeWorkspacePaseoPairing(
  project: string,
  pairing: Record<string, unknown> & { url: string },
  userProfileId?: string,
): string {
  const outputPath = path.join(
    workspacePaseoStateDir(project, userProfileId),
    "pairing.json",
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(pairing, null, 2)}\n`, "utf8");
  return outputPath;
}

export function readWorkspaceDriverSelection(project: string, userProfileId?: string): WorkspaceDriverSelection | null {
  const candidates = [
    workspaceSelectionPath(project, userProfileId),
    legacyWorkspaceSelectionPath(project),
  ].filter((candidate, index, entries) => entries.indexOf(candidate) === index);

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as WorkspaceDriverSelection;
    if (parsed.backend !== "docker" && parsed.backend !== "pod" && parsed.backend !== "kubevirt-vm") {
      return null;
    }
    if (parsed.profile !== undefined && typeof parsed.profile !== "string") {
      return null;
    }
    return parsed;
  }
  return null;
}

export function writeWorkspaceDriverSelection(
  project: string,
  selection: WorkspaceDriverSelection,
  userProfileId?: string,
): string {
  const outputPath = workspaceSelectionPath(project, userProfileId);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(selection, null, 2)}\n`, "utf8");
  if (outputPath !== legacyWorkspaceSelectionPath(project)) {
    fs.rmSync(legacyWorkspaceSelectionPath(project), { force: true });
  }
  return outputPath;
}

export function readWorkspaceLiveCredentialSelections(
  project: string,
  userProfileId?: string,
): Record<string, WorkspaceLiveCredentialSelectionState> {
  const candidates = [
    workspaceLiveCredentialsPath(project, userProfileId),
    legacyWorkspaceLiveCredentialsPath(project),
  ].filter((candidate, index, entries) => entries.indexOf(candidate) === index);

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(
        fs.readFileSync(filePath, "utf8"),
      ) as Record<string, WorkspaceLiveCredentialSelectionState>;
      return Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => {
          return Boolean(
            value &&
            typeof value.harness === "string" &&
            typeof value.credentialId === "string" &&
            typeof value.updatedAt === "string",
          );
        }),
      );
    } catch {
      return {};
    }
  }
  return {};
}

export function writeWorkspaceLiveCredentialSelection(
  project: string,
  harness: string,
  credentialId: string,
  userProfileId?: string,
): string {
  const outputPath = workspaceLiveCredentialsPath(project, userProfileId);
  const current = readWorkspaceLiveCredentialSelections(project, userProfileId);
  current[harness] = {
    harness,
    credentialId,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  if (outputPath !== legacyWorkspaceLiveCredentialsPath(project)) {
    fs.rmSync(legacyWorkspaceLiveCredentialsPath(project), { force: true });
  }
  return outputPath;
}

export function clearWorkspaceLiveCredentialSelection(
  project: string,
  harness: string,
  userProfileId?: string,
): void {
  const outputPath = workspaceLiveCredentialsPath(project, userProfileId);
  const current = readWorkspaceLiveCredentialSelections(project, userProfileId);
  delete current[harness];
  if (Object.keys(current).length === 0) {
    fs.rmSync(outputPath, { force: true });
    if (outputPath !== legacyWorkspaceLiveCredentialsPath(project)) {
      fs.rmSync(legacyWorkspaceLiveCredentialsPath(project), { force: true });
    }
    return;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}
