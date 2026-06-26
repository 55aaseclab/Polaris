import path from "node:path";
import { workspaceImageRef } from "../config/scaffold.js";
import type { WorkspaceSpec, WorkspaceStatus } from "./workspace.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../");

function repoRelative(filePath: string): string {
  return path.relative(REPO_ROOT, filePath) || ".";
}

function userDockerfilePath(userProfileId: string): string {
  return path.join(
    REPO_ROOT,
    "config",
    "users",
    userProfileId,
    "docker",
    "workspace-prebuilt.Dockerfile",
  );
}

function workspaceSpecPath(
  userProfileId: string,
  workspace: string,
  fileName: string,
): string {
  return path.join(
    REPO_ROOT,
    "config",
    "users",
    userProfileId,
    "projects",
    workspace,
    fileName,
  );
}

function evolutionAssets(workspace: WorkspaceSpec): NonNullable<WorkspaceStatus["assets"]>["evolutionFiles"] {
  const projectRoot = path.join(
    REPO_ROOT,
    "config",
    "users",
    workspace.userProfile.id,
    "projects",
    workspace.identity.projectName,
  );
  const userPolarisRoot = path.join(
    REPO_ROOT,
    "config",
    "users",
    workspace.userProfile.id,
    "polaris",
  );
  const runtimeWorkspaceMemory = path.join(
    workspace.attachments.workspaceData.mountRoot,
    ".polaris",
    "MEMORY.md",
  );
  const runtimeUserMemory = path.join(
    workspace.attachments.userIdentityState.mountRoot,
    "polaris",
    "USER.md",
  );
  const runtimeSnapshot = path.join(
    workspace.agent.runtime.evolutionRoot,
    "sessions",
    "bootstrap",
    "memory-snapshot.md",
  );
  return [
    {
      name: "workspace-memory",
      path: repoRelative(runtimeWorkspaceMemory),
      scope: "runtime",
    },
    {
      name: "user-memory",
      path: repoRelative(runtimeUserMemory),
      scope: "runtime",
    },
    {
      name: "session-snapshot",
      path: repoRelative(runtimeSnapshot),
      scope: "runtime",
    },
    {
      name: "workspace-memory",
      path: repoRelative(path.join(projectRoot, "state", "MEMORY.md")),
      scope: "control-plane",
    },
    {
      name: "user-memory",
      path: repoRelative(path.join(userPolarisRoot, "USER.md")),
      scope: "control-plane",
    },
    {
      name: "session-snapshot",
      path: repoRelative(path.join(projectRoot, "state", "sessions", "bootstrap", "memory-snapshot.md")),
      scope: "control-plane",
    },
    {
      name: "pending-memory",
      path: repoRelative(path.join(projectRoot, "state", "pending-memory.json")),
      scope: "control-plane",
    },
  ];
}

export function buildStatusAssets(workspace: WorkspaceSpec): NonNullable<WorkspaceStatus["assets"]> {
  const dockerWorkspace = workspace.identity.projectName;
  const dockerfilePath = userDockerfilePath(workspace.userProfile.id);
  const dockerSpec = workspaceSpecPath(workspace.userProfile.id, dockerWorkspace, "docker.agent.yaml");
  const podSpec = workspaceSpecPath(workspace.userProfile.id, dockerWorkspace, "pod.agent.yaml");
  const kubevirtSpec = workspaceSpecPath(workspace.userProfile.id, dockerWorkspace, "kubevirt.agent.yaml");

  return {
    dockerfile: {
      file: path.basename(dockerfilePath),
      path: repoRelative(dockerfilePath),
    },
    specs: [
      {
        driver: "docker",
        file: path.basename(dockerSpec),
        path: repoRelative(dockerSpec),
      },
      {
        driver: "pod",
        file: path.basename(podSpec),
        path: repoRelative(podSpec),
      },
      {
        driver: "kubevirt-vm",
        file: path.basename(kubevirtSpec),
        path: repoRelative(kubevirtSpec),
      },
    ],
    generatedManifests: [
      {
        driver: "docker",
        file: "docker.yaml",
        path: repoRelative(path.join(REPO_ROOT, "config", "users", workspace.userProfile.id, "projects", workspace.identity.projectName, "generated", "docker.yaml")),
      },
      {
        driver: "pod",
        file: "pod.yaml",
        path: repoRelative(path.join(REPO_ROOT, "config", "users", workspace.userProfile.id, "projects", workspace.identity.projectName, "generated", "pod.yaml")),
      },
      {
        driver: "kubevirt-vm",
        file: "kubevirt.yaml",
        path: repoRelative(path.join(REPO_ROOT, "config", "users", workspace.userProfile.id, "projects", workspace.identity.projectName, "generated", "kubevirt.yaml")),
      },
    ],
    imageTags: [
      {
        name: "workspace",
        tag: workspaceImageRef(workspace.userProfile.id, workspace.identity.projectName),
      },
      {
        name: "runtime-base",
        tag: workspace.runtime.baseImage,
      },
      ...(workspace.runtime.rootdiskImage
        ? [{
            name: "rootdisk",
            tag: workspace.runtime.rootdiskImage,
          }]
        : []),
    ],
    evolutionFiles: evolutionAssets(workspace),
    persistentVolumes: [
      {
        name: "workspace-data",
        sourceKind: workspace.attachments.workspaceData.source.kind,
        sourceRef: workspace.attachments.workspaceData.source.volumeRef,
        mountRoot: workspace.attachments.workspaceData.mountRoot,
        durablePaths: workspace.attachments.workspaceData.durablePaths,
      },
      {
        name: "workspace-runtime-state",
        sourceKind: workspace.attachments.workspaceRuntimeState.source.kind,
        sourceRef: workspace.attachments.workspaceRuntimeState.source.volumeRef,
        mountRoot: workspace.attachments.workspaceRuntimeState.mountRoot,
        durablePaths: workspace.attachments.workspaceRuntimeState.durablePaths,
      },
    ],
  };
}
