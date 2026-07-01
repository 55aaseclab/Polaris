import fs from "node:fs";
import path from "node:path";
import { assertValidWorkspaceProjectName } from "../core/workspace-name.js";
import { polarisUsersRoot } from "../utils/paths.js";

const USER_ROOT = polarisUsersRoot(import.meta.url);

function hasWorkspaceSavedSpec(workspaceRoot: string): boolean {
  return [
    "docker.agent.yaml",
    "pod.agent.yaml",
    "kubevirt.agent.yaml",
  ].some((fileName) => fs.existsSync(path.join(workspaceRoot, fileName)));
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
      const projectRoot = path.join(USER_ROOT, userProfileId, "workspaces", project);
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
  const owners = projectOwners(project);
  if (owners.includes(userProfileId)) {
    return;
  }
  if (owners.length === 0) {
    return;
  }
  throw new Error(
    `Project name '${project}' is already in use by user ${owners[0]}. Choose a different project name.`,
  );
}
