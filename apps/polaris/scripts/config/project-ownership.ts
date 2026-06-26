import fs from "node:fs";
import path from "node:path";
import { resolveRepoRoot } from "../utils/repo-root.js";

const REPO_ROOT = resolveRepoRoot(import.meta.url);

export function projectOwners(project: string): string[] {
  const usersRoot = path.join(REPO_ROOT, "config", "users");
  if (!fs.existsSync(usersRoot)) {
    return [];
  }
  return fs
    .readdirSync(usersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((userProfileId) => {
      const projectRoot = path.join(usersRoot, userProfileId, "projects", project);
      return fs.existsSync(projectRoot);
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
  const owners = projectOwners(project);
  if (owners.length === 0) {
    return;
  }
  throw new Error(
    `Project name '${project}' is already in use by user ${owners[0]}. Choose a different project name until user-qualified runtime naming is implemented.`,
  );
}
