import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import { renderAndWriteDockerWorkspace } from "../../backends/docker/render.js";
import { renderAndWriteKubevirtWorkspace } from "../../backends/kubevirt/render.js";
import { renderAndWritePodWorkspace } from "../../backends/pod/render.js";
import { getBackendDriver } from "../../backends/index.js";
import { parseWorkspaceReference } from "../../config/load.js";
import { projectOwners } from "../../config/project-ownership.js";
import type { WorkspaceSpec } from "../../core/workspace.js";
import { logInfo } from "../../utils/log.js";
import { polarisUsersRoot, repoRoot } from "../../utils/paths.js";
import { withWorkspaceMutationLock } from "../../utils/workspace-lifecycle-lock.js";
import { loadWorkspaceForProjectRef } from "./shared.js";

const REPO_ROOT = repoRoot(import.meta.url);
const USER_ROOT = polarisUsersRoot(import.meta.url);

type BackendTarget = {
  backend: WorkspaceSpec["backend"]["kind"];
  profile?: string;
  specFile: string;
};

const BACKEND_TARGETS: BackendTarget[] = [
  { backend: "docker", specFile: "docker.agent.yaml" },
  { backend: "pod", profile: "gvisor", specFile: "pod.agent.yaml" },
  { backend: "kubevirt-vm", specFile: "kubevirt.agent.yaml" },
];

function workspaceRoot(userId: string, workspace: string): string {
  return path.join(USER_ROOT, userId, "workspaces", workspace);
}

function portalWorkspaceStateRoot(userId: string, workspace: string): string {
  return path.join(
    workspaceRoot(userId, workspace),
    ".portal",
  );
}

function archivedPortalWorkspaceStateRoot(userId: string, archiveId: string): string {
  return path.join(
    archivedWorkspacesRoot(userId),
    archiveId,
    ".portal",
  );
}

function archivedWorkspacesRoot(userId: string): string {
  return path.join(USER_ROOT, userId, "archives", "workspaces");
}

function archiveStamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function archiveIdFor(workspace: string, archivedAt: Date): string {
  return `${archiveStamp(archivedAt)}-${workspace}`;
}

function moveIntoArchive(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(source, destination);
}

function workspaceProjectRef(workspace: string, target: BackendTarget): string {
  return target.backend === "pod" && target.profile
    ? `${workspace}@pod:${target.profile}`
    : `${workspace}@${target.backend}`;
}

function existingTargets(userId: string, workspace: string): BackendTarget[] {
  const root = workspaceRoot(userId, workspace);
  return BACKEND_TARGETS.filter((target) => fs.existsSync(path.join(root, target.specFile)));
}

function loadExistingWorkspaces(userId: string, workspace: string): WorkspaceSpec[] {
  return existingTargets(userId, workspace).flatMap((target) => {
    try {
      return [loadWorkspaceForProjectRef(workspaceProjectRef(workspace, target))];
    } catch {
      return [];
    }
  });
}

function runTolerant(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (/not found|no resources found|could not find/i.test(output)) {
      return;
    }
    throw new Error(
      `Command failed (${result.status ?? 1}): ${command} ${args.join(" ")}\n${output}`.trim(),
    );
  }
}

async function assertWorkspaceNotRunning(workspaces: WorkspaceSpec[]): Promise<void> {
  for (const workspace of workspaces) {
    const observation = await getBackendDriver(workspace.backend.kind).inspect(workspace);
    if (observation.backend.running) {
      const backendRef = workspace.backend.kind === "pod" && workspace.backend.profile
        ? `pod:${workspace.backend.profile}`
        : workspace.backend.kind;
      throw new Error(
        `Workspace '${workspace.identity.projectName}' is still running on ${backendRef}. Stop it before deleting.`,
      );
    }
  }
}

function teardownBackend(workspace: WorkspaceSpec): void {
  if (workspace.backend.kind === "docker") {
    const outputPath = renderAndWriteDockerWorkspace(workspace);
    runTolerant("docker", ["compose", "-f", outputPath, "down", "-v", "--remove-orphans"]);
    return;
  }
  if (workspace.backend.kind === "pod") {
    const outputPath = renderAndWritePodWorkspace(workspace);
    runTolerant("kubectl", ["delete", "-f", outputPath, "--ignore-not-found=true", "--wait=true"]);
    return;
  }
  const outputPath = renderAndWriteKubevirtWorkspace(workspace);
  runTolerant("kubectl", ["delete", "-f", outputPath, "--ignore-not-found=true", "--wait=true"]);
}

async function prepareWorkspaceRemoval(
  userId: string,
  workspace: string,
): Promise<{
  root: string;
}> {
  const root = workspaceRoot(userId, workspace);
  if (!fs.existsSync(root)) {
    throw new Error(`Workspace '${workspace}' for user '${userId}' was not found`);
  }
  const workspaces = loadExistingWorkspaces(userId, workspace);
  await assertWorkspaceNotRunning(workspaces);
  for (const entry of workspaces) {
    teardownBackend(entry);
  }
  return {
    root,
  };
}

export async function archiveWorkspaceOwnedByUser(userId: string, workspace: string): Promise<{
  archived: true;
  archiveId: string;
  archivedAt: string;
  workspace: string;
}> {
  return withWorkspaceMutationLock(import.meta.url, userId, workspace, async () => {
    const { root } = await prepareWorkspaceRemoval(userId, workspace);
    const archivedAt = new Date();
    const archiveId = archiveIdFor(workspace, archivedAt);
    const archiveRoot = path.join(archivedWorkspacesRoot(userId), archiveId);
    const portalStateRoot = portalWorkspaceStateRoot(userId, workspace);
    const archivedPortalStateRoot = archivedPortalWorkspaceStateRoot(userId, archiveId);
    moveIntoArchive(root, archiveRoot);
    fs.writeFileSync(
      path.join(archiveRoot, ".polaris-archive.json"),
      `${JSON.stringify({
        archiveId,
        workspaceName: workspace,
        archivedAt: archivedAt.toISOString(),
        originalWorkspaceRoot: `config/users/${userId}/workspaces/${workspace}`,
        originalPortalStateRoot: fs.existsSync(archivedPortalStateRoot)
          ? `config/users/${userId}/workspaces/${workspace}/.portal`
          : undefined,
        workspaceRoot: `config/users/${userId}/archives/workspaces/${archiveId}`,
        portalStateRoot: fs.existsSync(archivedPortalStateRoot)
          ? `config/users/${userId}/archives/workspaces/${archiveId}/.portal`
          : undefined,
      }, null, 2)}\n`,
      "utf8",
    );
    logInfo("cli", "workspace-archived", {
      userId,
      workspace,
      archiveId,
    });
    return {
      archived: true,
      archiveId,
      archivedAt: archivedAt.toISOString(),
      workspace,
    };
  });
}

export async function deleteWorkspaceOwnedByUser(userId: string, workspace: string): Promise<{
  deleted: true;
  workspace: string;
}> {
  return withWorkspaceMutationLock(import.meta.url, userId, workspace, async () => {
    const { root } = await prepareWorkspaceRemoval(userId, workspace);
    fs.rmSync(root, { recursive: true, force: true });
    logInfo("cli", "workspace-deleted", {
      userId,
      workspace,
    });
    return {
      deleted: true,
      workspace,
    };
  });
}

export async function deleteArchivedWorkspaceOwnedByUser(userId: string, archiveId: string): Promise<{
  deleted: true;
  archiveId: string;
}> {
  const archiveRoot = path.join(archivedWorkspacesRoot(userId), archiveId);
  if (!fs.existsSync(archiveRoot)) {
    throw new Error(`Archived workspace '${archiveId}' for user '${userId}' was not found`);
  }
  fs.rmSync(archiveRoot, { recursive: true, force: true });
  logInfo("cli", "workspace-archive-deleted", {
    userId,
    archiveId,
  });
  return {
    deleted: true,
    archiveId,
  };
}

export async function deleteCommand(projectArg: string): Promise<void> {
  const { project } = parseWorkspaceReference(projectArg);
  const owners = projectOwners(project);
  if (owners.length === 0) {
    throw new Error(`Workspace '${project}' was not found`);
  }
  if (owners.length > 1) {
    throw new Error(
      `Workspace '${project}' is ambiguous across multiple users (${owners.join(", ")}). Delete it through a user-scoped API route.`,
    );
  }
  await deleteWorkspaceOwnedByUser(owners[0]!, project);
}
