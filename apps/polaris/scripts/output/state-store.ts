import fs from "node:fs";
import path from "node:path";
import type { WorkspaceStatus } from "../core/workspace.js";
import { assertNoProjectNameCollision } from "../config/project-ownership.js";
import { resolveRepoRoot } from "../utils/repo-root.js";

const REPO_ROOT = resolveRepoRoot(import.meta.url);
const LEGACY_STATE_DIR = path.join(REPO_ROOT, "config", "state");

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
    return path.join(
      REPO_ROOT,
      "config",
      "users",
      userProfileId.trim(),
      "workspaces",
      project,
    );
  }

  const usersRoot = path.join(REPO_ROOT, "config", "users");
  if (!fs.existsSync(usersRoot)) {
    return null;
  }
  assertNoProjectNameCollision(project);

  const matches = fs
    .readdirSync(usersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(usersRoot, entry.name, "workspaces", project))
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

export function writeWorkspaceStatus(status: WorkspaceStatus, userProfileId?: string): string {
  const outputPath = workspaceStatusPath(status.project, userProfileId);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  if (outputPath !== legacyWorkspaceStatusPath(status.project)) {
    fs.rmSync(legacyWorkspaceStatusPath(status.project), { force: true });
  }
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
