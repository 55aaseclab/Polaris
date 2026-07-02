import fs from "node:fs";
import path from "node:path";
import { assertValidWorkspaceProjectName } from "../core/workspace-name.js";
import { polarisUsersRoot } from "../utils/paths.js";

const USER_ROOT = polarisUsersRoot(import.meta.url);
const ARCHIVE_METADATA_FILE = ".polaris-archive.json";

function workspacesRoot(userProfileId: string): string {
  return path.join(USER_ROOT, userProfileId, "workspaces");
}

function archivedWorkspacesRoot(userProfileId: string): string {
  return path.join(USER_ROOT, userProfileId, "archives", "workspaces");
}

function hasWorkspaceSavedSpec(workspaceRoot: string): boolean {
  return [
    "docker.agent.yaml",
    "pod.agent.yaml",
    "kubevirt.agent.yaml",
  ].some((fileName) => fs.existsSync(path.join(workspaceRoot, fileName)));
}

function listArchivedWorkspaceNames(userProfileId: string): string[] {
  const root = archivedWorkspacesRoot(userProfileId);
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const metadataPath = path.join(root, entry.name, ARCHIVE_METADATA_FILE);
      if (fs.existsSync(metadataPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
            workspaceName?: unknown;
          };
          if (typeof parsed.workspaceName === "string" && parsed.workspaceName.trim().length > 0) {
            return parsed.workspaceName.trim();
          }
        } catch {
          // Fall back to the archive directory name below.
        }
      }
      return entry.name.replace(/^[0-9]{8}T[0-9]{6}Z-/, "");
    })
    .filter(Boolean);
}

export function projectOwners(project: string): string[] {
  if (!fs.existsSync(USER_ROOT)) {
    return [];
  }
  return fs
    .readdirSync(USER_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((userProfileId) => {
      const projectRoot = path.join(workspacesRoot(userProfileId), project);
      return hasWorkspaceSavedSpec(projectRoot);
    })
    .sort();
}

export function assertNoProjectNameCollision(project: string): void {
  const owners = projectOwners(project);
  if (owners.length <= 1) {
    return;
  }
  throw new Error(
    `Project name collision for '${project}': owned by multiple users (${owners.join(", ")}). Rename the project or add user-qualified runtime naming first.`,
  );
}

export function assertProjectNameAvailable(project: string): void {
  assertValidWorkspaceProjectName(project);
  const owners = projectOwners(project);
  if (owners.length === 0) {
    return;
  }
  throw new Error(
    `Project name '${project}' is already in use by user ${owners[0]}. Choose a different project name until user-qualified runtime naming is implemented.`,
  );
}

export function assertProjectNameAvailableForUser(
  project: string,
  userProfileId: string,
): void {
  assertValidWorkspaceProjectName(project);
  const archivedNames = listArchivedWorkspaceNames(userProfileId);
  if (archivedNames.includes(project)) {
    throw new Error(
      `Workspace '${project}' is already archived for user ${userProfileId}. Choose a different project name.`,
    );
  }
  const owners = projectOwners(project);
  if (owners.includes(userProfileId)) {
    return;
  }
  return;
}
