import fs from "node:fs";
import path from "node:path";
import {
  WORKSPACE_STATUS_SCHEMA_VERSION,
  type WorkspaceStatus,
} from "../core/workspace.js";
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
    return normalizeWorkspaceStatus(
      JSON.parse(fs.readFileSync(filePath, "utf8")) as WorkspaceStatus,
    );
  } catch {
    return null;
  }
}

export function normalizeWorkspaceStatus(status: WorkspaceStatus): WorkspaceStatus {
  const next = {
    ...status,
    schemaVersion: WORKSPACE_STATUS_SCHEMA_VERSION,
    details: status.details ?? {},
  } as WorkspaceStatus & Record<string, unknown>;
  delete (next as Record<string, unknown>).daemon;
  delete (next as Record<string, unknown>).ssh;
  delete (next as Record<string, unknown>).drift;
  return next;
}

export function writeWorkspaceStatus(status: WorkspaceStatus, userProfileId?: string): string {
  const outputPath = workspaceStatusPath(status.project, userProfileId);
  const next = normalizeWorkspaceStatus(status);
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
