import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import { ensureCanonicalWorkspaceImage, ensureWorkspaceConfig } from "../config/provision.js";
import { scaffoldDockerWorkspace } from "../config/scaffold.js";
import {
  clearWorkspaceProvisionProgress,
  listOwnedWorkspaces,
  listPortalCredentials,
  listPortalProfiles,
  listWorkspaceDriverTargets,
  loadWorkspaceDetail,
  loadWorkspaceSummary,
  readWorkspaceProvisionProgress,
  type PortalCredentialSummary,
  type PortalDriverTarget,
  type PortalProvisionProgress,
  type PortalWorkspaceDetail,
  type PortalWorkspaceSummary,
  workspaceRefFromTarget,
  writeWorkspaceProvisionProgress,
} from "../core/portal.js";
import { loadWorkspace } from "../config/load.js";
import { performWorkspaceSwitch } from "../cli/commands/switch.js";
import { renderAndWriteDockerWorkspace } from "../backends/docker/render.js";
import { renderAndWritePodWorkspace } from "../backends/pod/render.js";
import { renderAndWriteKubevirtWorkspace } from "../backends/kubevirt/render.js";
import type { WorkspaceSpec } from "../core/workspace.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../");
const PROVISION_TOTAL_STEPS = 6;
const provisionJobs = new Map<string, Promise<void>>();

function rootKey(userId: string, workspace: string): string {
  return `${userId}:${workspace}`;
}

function portalRoot(userId: string, workspace: string): string {
  return path.join(REPO_ROOT, "config", "users", userId, "projects", workspace);
}

function portalStateProgress(userId: string, workspace: string): PortalProvisionProgress | null {
  return readWorkspaceProvisionProgress(userId, workspace);
}

function updateProgress(userId: string, workspace: string, patch: Partial<PortalProvisionProgress>): PortalProvisionProgress {
  const current = portalStateProgress(userId, workspace) ?? {
    userId,
    workspace,
    phase: "queued",
    step: 0,
    totalSteps: PROVISION_TOTAL_STEPS,
    percent: 0,
    message: "queued",
    updatedAt: new Date().toISOString(),
    done: false,
  };
  const next: PortalProvisionProgress = {
    ...current,
    ...patch,
    userId,
    workspace,
    totalSteps: PROVISION_TOTAL_STEPS,
    percent: patch.percent ?? Math.round(((patch.step ?? current.step) / PROVISION_TOTAL_STEPS) * 100),
    updatedAt: new Date().toISOString(),
    done: patch.done ?? current.done,
  };
  writeWorkspaceProvisionProgress(userId, workspace, next);
  return next;
}

function ensureImageRefAvailable(imageRef: string): void {
  const inspect = spawnSync("docker", ["image", "inspect", imageRef], { encoding: "utf8" });
  if (inspect.status === 0) {
    return;
  }
  const pull = spawnSync("docker", ["pull", imageRef], { encoding: "utf8" });
  if (pull.status === 0) {
    return;
  }
  throw new Error(`Image '${imageRef}' is not available`);
}

function renderWorkspaceTargets(workspace: string): void {
  const dockerWorkspace = loadWorkspace(`${workspace}@docker`);
  renderAndWriteDockerWorkspace(dockerWorkspace);
  const podWorkspace = loadWorkspace(`${workspace}@pod:gvisor`);
  renderAndWritePodWorkspace(podWorkspace);
  const kubevirtWorkspace = loadWorkspace(`${workspace}@kubevirt-vm`);
  renderAndWriteKubevirtWorkspace(kubevirtWorkspace);
}

function ensureWorkspaceImageTargets(workspace: string): void {
  ensureCanonicalWorkspaceImage(`${workspace}@docker`);
  ensureCanonicalWorkspaceImage(`${workspace}@pod:gvisor`);
  ensureCanonicalWorkspaceImage(`${workspace}@kubevirt-vm`);
  const kubevirtWorkspace = loadWorkspace(`${workspace}@kubevirt-vm`);
  ensureImageRefAvailable(kubevirtWorkspace.runtime.rootdiskImage ?? "quay.io/containerdisks/debian:13");
}

function ensureWorkspaceTargetSpecs(userId: string, workspace: string): void {
  fs.mkdirSync(portalRoot(userId, workspace), { recursive: true });
  ensureWorkspaceConfig(`${workspace}@docker`);
  ensureWorkspaceConfig(`${workspace}@pod:gvisor`);
  ensureWorkspaceConfig(`${workspace}@kubevirt-vm`);
  const selectionPath = path.join(portalRoot(userId, workspace), "state", "selection.json");
  if (!fs.existsSync(selectionPath)) {
    fs.mkdirSync(path.dirname(selectionPath), { recursive: true });
    fs.writeFileSync(selectionPath, `${JSON.stringify({ backend: "docker" }, null, 2)}\n`, "utf8");
  }
}

async function provisionWorkspaceInternal(userId: string, workspace: string): Promise<void> {
  updateProgress(userId, workspace, { phase: "starting", step: 0, message: "starting workspace provisioning" });

  if (!listOwnedWorkspaces(userId).includes(workspace)) {
    scaffoldDockerWorkspace(workspace, userId);
  }

  updateProgress(userId, workspace, { phase: "specs", step: 1, message: "ensuring driver specs" });
  ensureWorkspaceTargetSpecs(userId, workspace);

  updateProgress(userId, workspace, { phase: "images", step: 2, message: "ensuring workspace images" });
  ensureWorkspaceImageTargets(workspace);

  updateProgress(userId, workspace, { phase: "manifests", step: 3, message: "rendering backend manifests" });
  renderWorkspaceTargets(workspace);

  updateProgress(userId, workspace, { phase: "status", step: 4, message: "collecting workspace status" });
  const summary = loadWorkspaceSummary(userId, workspace);
  if (summary.selectedDriver === null) {
    updateProgress(userId, workspace, { phase: "selection", step: 5, message: "defaulting driver selection" });
  }

  updateProgress(userId, workspace, {
    phase: "done",
    step: PROVISION_TOTAL_STEPS,
    message: "workspace provisioning complete",
    done: true,
    percent: 100,
  });
}

export function startProvisionWorkspace(userId: string, workspace: string): Promise<void> {
  const key = rootKey(userId, workspace);
  const existing = provisionJobs.get(key);
  if (existing) {
    return existing;
  }
  const job = (async () => {
    try {
      await provisionWorkspaceInternal(userId, workspace);
    } catch (error) {
      updateProgress(userId, workspace, {
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      provisionJobs.delete(key);
    }
  })();
  provisionJobs.set(key, job);
  return job;
}

export async function provisionWorkspace(userId: string, workspace: string): Promise<PortalProvisionProgress> {
  await startProvisionWorkspace(userId, workspace);
  return readWorkspaceProvisionProgress(userId, workspace) ?? updateProgress(userId, workspace, {
    phase: "done",
    step: PROVISION_TOTAL_STEPS,
    percent: 100,
    done: true,
    message: "workspace provisioning complete",
  });
}

export function listPortalWorkspaces(userId: string): PortalWorkspaceSummary[] {
  return listOwnedWorkspaces(userId).map((workspace) => loadWorkspaceSummary(userId, workspace));
}

export function getPortalWorkspaceDetail(userId: string, workspace: string): PortalWorkspaceDetail {
  return loadWorkspaceDetail(userId, workspace);
}

export function listUserPortalCredentials(userId: string): PortalCredentialSummary[] {
  return listPortalCredentials(userId);
}

export function upsertPortalCredential(userId: string, credential: {
  id: string;
  kind: PortalCredentialSummary["kind"];
  label: string;
  purposes: string[];
  status?: string;
  files: Array<{
    key: string;
    sourcePath: string;
    content: string;
    mountPath?: string;
  }>;
}): PortalCredentialSummary {
  const credentialsRoot = path.join(REPO_ROOT, "config", "users", userId, "credentials");
  fs.mkdirSync(credentialsRoot, { recursive: true });
  for (const file of credential.files) {
    const absolute = path.join(REPO_ROOT, "config", "users", userId, file.sourcePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, file.content, "utf8");
  }
  const document = {
    id: credential.id,
    userId,
    kind: credential.kind,
    label: credential.label,
    purposes: credential.purposes,
    materialRef: {
      type: "file",
      key: credential.id,
      files: credential.files.map((file) => ({
        key: file.key,
        source_path: file.sourcePath,
        ...(file.mountPath ? { mount_path: file.mountPath } : {}),
      })),
    },
    metadata: {
      source: "portal",
    },
    status: credential.status ?? "ready",
  };
  const outputPath = path.join(credentialsRoot, `${credential.id}.yaml`);
  fs.writeFileSync(outputPath, `${yaml.dump(document, { lineWidth: 120, noRefs: true })}`, "utf8");
  return {
    id: credential.id,
    kind: credential.kind,
    label: credential.label,
    purposes: credential.purposes,
    status: credential.status ?? "ready",
    paths: credential.files.map((file) => file.sourcePath),
  };
}

export async function switchPortalWorkspace(userId: string, workspace: string, target: PortalDriverTarget): Promise<ReturnType<typeof performWorkspaceSwitch>> {
  const ref = workspaceRefFromTarget(workspace, target);
  return performWorkspaceSwitch(ref);
}
