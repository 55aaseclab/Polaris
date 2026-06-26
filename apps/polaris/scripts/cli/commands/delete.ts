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
import { resolveRepoRoot } from "../../utils/repo-root.js";
import { loadWorkspaceForProjectRef } from "./shared.js";

const REPO_ROOT = resolveRepoRoot(import.meta.url);

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
  return path.join(REPO_ROOT, "config", "users", userId, "projects", workspace);
}

function profilePath(userId: string): string {
  return path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);
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

function removeWorkspaceFromProfile(userId: string, workspace: string): void {
  const filePath = profilePath(userId);
  if (!fs.existsSync(filePath)) {
    return;
  }
  const data = (yaml.load(fs.readFileSync(filePath, "utf8")) ?? {}) as Record<string, unknown>;
  const workspaces = Array.isArray(data.workspaces)
    ? data.workspaces.map((value) => String(value)).filter(Boolean)
    : [];
  data.workspaces = workspaces.filter((value) => value !== workspace);
  fs.writeFileSync(filePath, yaml.dump(data, { lineWidth: 120, noRefs: true }), "utf8");
}

export async function deleteWorkspaceOwnedByUser(userId: string, workspace: string): Promise<void> {
  const root = workspaceRoot(userId, workspace);
  if (!fs.existsSync(root)) {
    throw new Error(`Workspace '${workspace}' for user '${userId}' was not found`);
  }
  const workspaces = loadExistingWorkspaces(userId, workspace);
  await assertWorkspaceNotRunning(workspaces);
  for (const entry of workspaces) {
    teardownBackend(entry);
  }
  fs.rmSync(root, { recursive: true, force: true });
  removeWorkspaceFromProfile(userId, workspace);
  logInfo("cli", "workspace-deleted", { userId, workspace });
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
