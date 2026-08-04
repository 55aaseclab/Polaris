import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import { renderAndWriteDockerVault } from "../../backends/docker/render.js";
import { renderAndWriteKubevirtVault } from "../../backends/kubevirt/render.js";
import { renderAndWritePodVault } from "../../backends/pod/render.js";
import { getBackendDriver } from "../../backends/index.js";
import { parseVaultReference } from "../../config/load.js";
import { projectOwners } from "../../config/project-ownership.js";
import type { VaultSpec } from "../../core/vault.js";
import { getPolarisControlStore } from "../../portal/control-store.js";
import { logInfo } from "../../utils/log.js";
import { polarisUsersRoot, repoRoot } from "../../utils/paths.js";
import { withVaultMutationLock } from "../../utils/vault-lifecycle-lock.js";
import { loadVaultForProjectRef } from "./shared.js";

const REPO_ROOT = repoRoot(import.meta.url);
const USER_ROOT = polarisUsersRoot(import.meta.url);

type BackendTarget = {
  backend: VaultSpec["backend"]["kind"];
  profile?: string;
  specFile: string;
};

const BACKEND_TARGETS: BackendTarget[] = [
  { backend: "docker", specFile: "docker.agent.yaml" },
  { backend: "pod", profile: "gvisor", specFile: "pod.agent.yaml" },
  { backend: "kubevirt-vm", specFile: "kubevirt.agent.yaml" },
];

function vaultRoot(userId: string, vault: string): string {
  return path.join(USER_ROOT, userId, "vaults", vault);
}

function vaultProjectRef(vault: string, target: BackendTarget): string {
  return target.backend === "pod" && target.profile
    ? `${vault}@pod:${target.profile}`
    : `${vault}@${target.backend}`;
}

function existingTargets(userId: string, vault: string): BackendTarget[] {
  const root = vaultRoot(userId, vault);
  return BACKEND_TARGETS.filter((target) => fs.existsSync(path.join(root, target.specFile)));
}

function loadExistingVaults(userId: string, vault: string): VaultSpec[] {
  return existingTargets(userId, vault).flatMap((target) => {
    try {
      return [loadVaultForProjectRef(vaultProjectRef(vault, target))];
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

async function assertVaultNotRunning(vaults: VaultSpec[]): Promise<void> {
  for (const vault of vaults) {
    const observation = await getBackendDriver(vault.backend.kind).inspect(vault);
    if (observation.backend.running) {
      const backendRef = vault.backend.kind === "pod" && vault.backend.profile
        ? `pod:${vault.backend.profile}`
        : vault.backend.kind;
      throw new Error(
        `Vault '${vault.identity.projectName}' is still running on ${backendRef}. Stop it before deleting.`,
      );
    }
  }
}

function teardownBackend(vault: VaultSpec): void {
  if (vault.backend.kind === "docker") {
    const outputPath = renderAndWriteDockerVault(vault);
    runTolerant("docker", ["compose", "-f", outputPath, "down", "-v", "--remove-orphans"]);
    return;
  }
  if (vault.backend.kind === "pod") {
    const outputPath = renderAndWritePodVault(vault);
    runTolerant("kubectl", ["delete", "-f", outputPath, "--ignore-not-found=true", "--wait=true"]);
    return;
  }
  const outputPath = renderAndWriteKubevirtVault(vault);
  runTolerant("kubectl", ["delete", "-f", outputPath, "--ignore-not-found=true", "--wait=true"]);
}

async function prepareVaultRemoval(
  userId: string,
  vault: string,
): Promise<{
  root: string;
}> {
  const root = vaultRoot(userId, vault);
  if (!fs.existsSync(root)) {
    throw new Error(`Vault '${vault}' for user '${userId}' was not found`);
  }
  const vaults = loadExistingVaults(userId, vault);
  await assertVaultNotRunning(vaults);
  for (const entry of vaults) {
    teardownBackend(entry);
  }
  return {
    root,
  };
}

export async function deleteVaultOwnedByUser(userId: string, vault: string): Promise<{
  deleted: true;
  vault: string;
}> {
  return withVaultMutationLock(import.meta.url, userId, vault, async () => {
    const pendingJobs = getPolarisControlStore(import.meta.url)
      .listPendingJobsForVault(userId, vault);
    if (pendingJobs.length > 0) {
      throw new Error(
        `Vault '${vault}' cannot be deleted while durable jobs are queued or running. Cancel or finish those jobs first.`,
      );
    }
    const { root } = await prepareVaultRemoval(userId, vault);
    fs.rmSync(root, { recursive: true, force: true });
    getPolarisControlStore(import.meta.url).deleteTerminalProvisionJob(userId, vault);
    logInfo("cli", "vault-deleted", {
      userId,
      vault,
    });
    return {
      deleted: true,
      vault,
    };
  });
}

export async function deleteCommand(projectArg: string, userProfileId?: string): Promise<void> {
  const { project } = parseVaultReference(projectArg);
  if (userProfileId?.trim()) {
    await deleteVaultOwnedByUser(userProfileId.trim(), project);
    return;
  }
  const owners = projectOwners(project);
  if (owners.length === 0) {
    throw new Error(`Vault '${project}' was not found`);
  }
  if (owners.length > 1) {
    throw new Error(
      `Vault '${project}' is ambiguous across multiple users (${owners.join(", ")}). Delete it through a user-scoped API route.`,
    );
  }
  await deleteVaultOwnedByUser(owners[0]!, project);
}
