import fs from "node:fs";
import path from "node:path";
import { vaultImageRef } from "../config/scaffold.js";
import type { VaultSpec, VaultStatus } from "./vault.js";
import { polarisUsersRoot, repoRoot } from "../utils/paths.js";

const REPO_ROOT = repoRoot(import.meta.url);
const USER_ROOT = polarisUsersRoot(import.meta.url);

function repoRelative(filePath: string): string {
  return path.relative(REPO_ROOT, filePath) || ".";
}

function userDockerfilePath(userProfileId: string): string {
  return path.join(
    USER_ROOT,
    userProfileId,
    "docker",
    "vault-prebuilt.Dockerfile",
  );
}

function vaultSpecPath(
  userProfileId: string,
  vault: string,
  fileName: string,
): string {
  return path.join(
    USER_ROOT,
    userProfileId,
    "vaults",
    vault,
    fileName,
  );
}

function evolutionAssets(vault: VaultSpec): NonNullable<VaultStatus["assets"]>["evolutionFiles"] {
  const projectRoot = path.join(
    USER_ROOT,
    vault.userProfile.id,
    "vaults",
    vault.identity.projectName,
  );
  const userPolarisRoot = path.join(
    USER_ROOT,
    vault.userProfile.id,
    "polaris",
  );
  const runtimeVaultMemory = path.join(
    vault.attachments.vaultData.mountRoot,
    ".polaris",
    "MEMORY.md",
  );
  const runtimeUserMemory = path.join(
    vault.attachments.userIdentityState.mountRoot,
    "polaris",
    "USER.md",
  );
  const runtimeSnapshot = path.join(
    vault.agent.runtime.evolutionRoot,
    "sessions",
    "bootstrap",
    "memory-snapshot.md",
  );
  return [
    {
      name: "vault-memory",
      path: repoRelative(runtimeVaultMemory),
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
      name: "vault-memory",
      path: repoRelative(path.join(projectRoot, "state", "MEMORY.md")),
      scope: "control-plane",
      exists: fs.existsSync(path.join(projectRoot, "state", "MEMORY.md")),
    },
    {
      name: "user-memory",
      path: repoRelative(path.join(userPolarisRoot, "USER.md")),
      scope: "control-plane",
      exists: fs.existsSync(path.join(userPolarisRoot, "USER.md")),
    },
    {
      name: "session-snapshot",
      path: repoRelative(path.join(projectRoot, "state", "sessions", "bootstrap", "memory-snapshot.md")),
      scope: "control-plane",
      exists: fs.existsSync(path.join(projectRoot, "state", "sessions", "bootstrap", "memory-snapshot.md")),
    },
    {
      name: "pending-memory",
      path: repoRelative(path.join(projectRoot, "state", "pending-memory.json")),
      scope: "control-plane",
      exists: fs.existsSync(path.join(projectRoot, "state", "pending-memory.json")),
    },
  ];
}

export function buildStatusAssets(vault: VaultSpec): NonNullable<VaultStatus["assets"]> {
  const dockerVault = vault.identity.projectName;
  const dockerfilePath = userDockerfilePath(vault.userProfile.id);
  const dockerSpec = vaultSpecPath(vault.userProfile.id, dockerVault, "docker.agent.yaml");
  const podSpec = vaultSpecPath(vault.userProfile.id, dockerVault, "pod.agent.yaml");
  const kubevirtSpec = vaultSpecPath(vault.userProfile.id, dockerVault, "kubevirt.agent.yaml");

  return {
    dockerfile: {
      file: path.basename(dockerfilePath),
      path: repoRelative(dockerfilePath),
      exists: fs.existsSync(dockerfilePath),
    },
    specs: [
      {
        driver: "docker",
        file: path.basename(dockerSpec),
        path: repoRelative(dockerSpec),
        exists: fs.existsSync(dockerSpec),
      },
      {
        driver: "pod",
        file: path.basename(podSpec),
        path: repoRelative(podSpec),
        exists: fs.existsSync(podSpec),
      },
      {
        driver: "kubevirt-vm",
        file: path.basename(kubevirtSpec),
        path: repoRelative(kubevirtSpec),
        exists: fs.existsSync(kubevirtSpec),
      },
    ],
    generatedManifests: [
      {
        driver: "docker",
        file: "docker.yaml",
        path: repoRelative(path.join(USER_ROOT, vault.userProfile.id, "vaults", vault.identity.projectName, "generated", "docker.yaml")),
        exists: fs.existsSync(path.join(USER_ROOT, vault.userProfile.id, "vaults", vault.identity.projectName, "generated", "docker.yaml")),
      },
      {
        driver: "pod",
        file: "pod.yaml",
        path: repoRelative(path.join(USER_ROOT, vault.userProfile.id, "vaults", vault.identity.projectName, "generated", "pod.yaml")),
        exists: fs.existsSync(path.join(USER_ROOT, vault.userProfile.id, "vaults", vault.identity.projectName, "generated", "pod.yaml")),
      },
      {
        driver: "kubevirt-vm",
        file: "kubevirt.yaml",
        path: repoRelative(path.join(USER_ROOT, vault.userProfile.id, "vaults", vault.identity.projectName, "generated", "kubevirt.yaml")),
        exists: fs.existsSync(path.join(USER_ROOT, vault.userProfile.id, "vaults", vault.identity.projectName, "generated", "kubevirt.yaml")),
      },
    ],
    imageTags: [
      {
        name: "vault",
        tag: vaultImageRef(vault.userProfile.id, vault.identity.projectName),
      },
      {
        name: "runtime-base",
        tag: vault.runtime.baseImage,
      },
      ...(vault.runtime.rootdiskImage
        ? [{
            name: "rootdisk",
            tag: vault.runtime.rootdiskImage,
          }]
        : []),
    ],
    evolutionFiles: evolutionAssets(vault),
    persistentVolumes: [
      {
        name: "vault-data",
        sourceKind: vault.attachments.vaultData.source.kind,
        sourceRef: vault.attachments.vaultData.source.volumeRef,
        mountRoot: vault.attachments.vaultData.mountRoot,
        durablePaths: vault.attachments.vaultData.durablePaths,
      },
      {
        name: "vault-runtime-state",
        sourceKind: vault.attachments.vaultRuntimeState.source.kind,
        sourceRef: vault.attachments.vaultRuntimeState.source.volumeRef,
        mountRoot: vault.attachments.vaultRuntimeState.mountRoot,
        durablePaths: vault.attachments.vaultRuntimeState.durablePaths,
      },
    ],
  };
}
