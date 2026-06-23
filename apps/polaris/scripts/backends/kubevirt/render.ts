import fs from "node:fs";
import path from "node:path";
import type { WorkspaceSpec } from "../../core/workspace.js";
import {
  isNetfsSource,
  netfsResolvedPath,
  requireNetfsField,
  workspaceDataClaimName,
  workspaceDataPersistentVolumeName,
} from "../../core/netfs.js";
import { writeGeneratedManifest } from "../../output/write-generated.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../../");
const GENERATED_KUBEVIRT_DIR = path.join(REPO_ROOT, "config", "generated", "kubevirt");
const FALLBACK_KUBEVIRT_DIR = path.join(REPO_ROOT, "config", "kubevirt", "templates");

function indentBlock(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split(/\r?\n/)
    .filter((line, index, arr) => !(index === arr.length - 1 && line === ""))
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function readTemplate(preferredPath: string, fallbackPath: string): string {
  if (fs.existsSync(preferredPath)) {
    return fs.readFileSync(preferredPath, "utf8");
  }
  return fs.readFileSync(fallbackPath, "utf8");
}

function requireAttachmentVolumeRef(
  workspace: WorkspaceSpec,
  attachment:
    | "workspaceData"
    | "workspaceRuntimeState"
    | "userIdentityState"
    | "userSshState",
): string {
  const source = workspace.attachments[attachment].source;
  if (attachment === "workspaceData" && isNetfsSource(source)) {
    return workspaceDataClaimName(workspace);
  }
  if (source.kind !== "persistent-volume" || !source.volumeRef?.trim()) {
    throw new Error(
      `KubeVirt render requires '${workspace.attachments[attachment].kind}' to use a dedicated persistent-volume source`,
    );
  }
  return source.volumeRef.trim();
}

function attachmentVolumeSize(
  workspace: WorkspaceSpec,
  attachment:
    | "workspaceData"
    | "workspaceRuntimeState"
    | "userIdentityState"
    | "userSshState",
): string {
  const source = workspace.attachments[attachment].source;
  if (source.volumeSize?.trim()) {
    return source.volumeSize.trim();
  }
  switch (attachment) {
    case "workspaceData":
      return workspace.resources.ephemeralStorage;
    case "workspaceRuntimeState":
      return "20Gi";
    case "userIdentityState":
      return "5Gi";
    case "userSshState":
      return "1Gi";
  }
}

function buildPersistentVolumeClaimDocs(workspace: WorkspaceSpec): string {
  const docs: string[] = [];
  if (isNetfsSource(workspace.attachments.workspaceData.source)) {
    const source = workspace.attachments.workspaceData.source;
    const claimName = workspaceDataClaimName(workspace);
    docs.push([
      "apiVersion: v1",
      "kind: PersistentVolume",
      "metadata:",
      `  name: ${workspaceDataPersistentVolumeName(workspace)}`,
      "spec:",
      "  accessModes:",
      "  - ReadWriteMany",
      "  capacity:",
      `    storage: ${attachmentVolumeSize(workspace, "workspaceData")}`,
      "  persistentVolumeReclaimPolicy: Retain",
      "  storageClassName: ''",
      "  mountOptions:",
      ...((source.mountOptions?.length ? source.mountOptions : ["nfsvers=4.1", "hard", "rw"])
        .map((entry) => `  - ${entry}`)),
      "  nfs:",
      `    server: ${requireNetfsField(source.server, "server", "workspace-data")}`,
      `    path: ${netfsResolvedPath(source)}`,
      "  claimRef:",
      `    namespace: ${workspace.identity.projectName}`,
      `    name: ${claimName}`,
    ].join("\n"));
    docs.push([
      "apiVersion: v1",
      "kind: PersistentVolumeClaim",
      "metadata:",
      `  name: ${claimName}`,
      `  namespace: ${workspace.identity.projectName}`,
      "spec:",
      "  accessModes:",
      "  - ReadWriteMany",
      "  resources:",
      "    requests:",
      `      storage: ${attachmentVolumeSize(workspace, "workspaceData")}`,
      "  storageClassName: ''",
      `  volumeName: ${workspaceDataPersistentVolumeName(workspace)}`,
    ].join("\n"));
  } else {
    docs.push([
      "apiVersion: v1",
      "kind: PersistentVolumeClaim",
      "metadata:",
      `  name: ${requireAttachmentVolumeRef(workspace, "workspaceData")}`,
      `  namespace: ${workspace.identity.projectName}`,
      "spec:",
      "  accessModes:",
      "  - ReadWriteOnce",
      "  resources:",
      "    requests:",
      `      storage: ${attachmentVolumeSize(workspace, "workspaceData")}`,
    ].join("\n"));
  }
  for (const attachment of [
    "workspaceRuntimeState",
    "userIdentityState",
    "userSshState",
  ] as const) {
    docs.push([
      "apiVersion: v1",
      "kind: PersistentVolumeClaim",
      "metadata:",
      `  name: ${requireAttachmentVolumeRef(workspace, attachment)}`,
      `  namespace: ${workspace.identity.projectName}`,
      "spec:",
      "  accessModes:",
      "  - ReadWriteOnce",
      "  resources:",
      "    requests:",
      `      storage: ${attachmentVolumeSize(workspace, attachment)}`,
    ].join("\n"));
  }
  return docs.join("\n---\n");
}

function replacePlaceholders(text: string, workspace: WorkspaceSpec): string {
  const servicePort =
    workspace.connectivity.servicePorts[0]?.containerPort ?? "6767";
  const nodePort =
    workspace.connectivity.servicePorts[0]?.nodePort ?? servicePort;
  const rootdiskImage =
    workspace.runtime.rootdiskImage || "quay.io/containerdisks/debian:13";
  const memoryGuest =
    workspace.resources.memory || "4Gi";
  const memoryRequest =
    workspace.resources.memoryRequest || memoryGuest;
  return text
    .replaceAll(
      "__PERSISTENT_VOLUME_CLAIMS__",
      `${buildPersistentVolumeClaimDocs(workspace)}\n`,
    )
    .replaceAll("__PROJECT__", workspace.identity.projectName)
    .replaceAll(
      "__WORKSPACE_DATA_VOLUME__",
      requireAttachmentVolumeRef(workspace, "workspaceData"),
    )
    .replaceAll(
      "__WORKSPACE_RUNTIME_STATE_VOLUME__",
      requireAttachmentVolumeRef(workspace, "workspaceRuntimeState"),
    )
    .replaceAll(
      "__USER_IDENTITY_STATE_VOLUME__",
      requireAttachmentVolumeRef(workspace, "userIdentityState"),
    )
    .replaceAll(
      "__USER_SSH_STATE_VOLUME__",
      requireAttachmentVolumeRef(workspace, "userSshState"),
    )
    .replaceAll("__SERVICE_PORT__", servicePort)
    .replaceAll("__NODE_PORT__", nodePort)
    .replaceAll("__ROOTDISK_IMAGE__", rootdiskImage)
    .replaceAll("__MEMORY_GUEST__", memoryGuest)
    .replaceAll("__MEMORY_REQUEST__", memoryRequest);
}

export function renderKubevirtWorkspace(workspace: WorkspaceSpec): string {
  if (workspace.profile.assetBaseName !== "morpheus") {
    throw new Error(`Workspace backend 'kubevirt-vm' does not have built-in templates for profile '${workspace.profile.name}' yet`);
  }
  const cloudinitPath = path.join(
    GENERATED_KUBEVIRT_DIR,
    `${workspace.profile.assetBaseName}-vm-cloudinit-secret.yaml`,
  );
  const vmPath = path.join(
    GENERATED_KUBEVIRT_DIR,
    `${workspace.profile.assetBaseName}.yaml`,
  );
  const cloudinitTemplate = replacePlaceholders(
    readTemplate(
      cloudinitPath,
      path.join(FALLBACK_KUBEVIRT_DIR, "vm-cloudinit-secret.yaml"),
    ),
    workspace,
  );
  const vmTemplate = replacePlaceholders(
    readTemplate(vmPath, path.join(FALLBACK_KUBEVIRT_DIR, "vm.yaml")),
    workspace,
  );
  const codexAuth = workspace.runtime.authFiles.find((item) => item.key === "codex-auth.json")?.content;
  const codexConfig = workspace.runtime.authFiles.find((item) => item.key === "codex-config.toml")?.content;
  const claudeSettings = workspace.runtime.authFiles.find((item) => item.key === "claude-settings.json")?.content;
  const sshPrivateKey = workspace.runtime.authFiles.find((item) => item.mountPath.startsWith(`${workspace.runtime.home}/.ssh/`) && !item.mountPath.endsWith(".pub"))?.content;
  const sshPublicKey = workspace.runtime.authFiles.find((item) => item.mountPath.startsWith(`${workspace.runtime.home}/.ssh/`) && item.mountPath.endsWith(".pub"))?.content;
  if (workspace.agent.enabled && (!codexAuth || !codexConfig || !claudeSettings)) {
    throw new Error("KubeVirt render requires codex-auth.json, codex-config.toml, and claude-settings.json");
  }
  let renderedCloudinit = cloudinitTemplate
    .replace("__CODEX_AUTH_JSON_B64__", Buffer.from(codexAuth ?? "{}", "utf8").toString("base64"))
    .replace("__CODEX_CONFIG_TOML_B64__", Buffer.from(codexConfig ?? "", "utf8").toString("base64"))
    .replace("__CLAUDE_SETTINGS_JSON_B64__", Buffer.from(claudeSettings ?? "{}", "utf8").toString("base64"));
  renderedCloudinit = renderedCloudinit.replace(
    `      - /bin/sh -lc 'if [ ! -f /ssh/id_ed25519 ]; then ssh-keygen -q -t ed25519 -C fixture@polaris -N "" -f /ssh/id_ed25519; fi'`,
    `      - /bin/sh -lc 'if [ ! -f /ssh/id_ed25519 ]; then ssh-keygen -q -t ed25519 -C ${workspace.userProfile.ssh.comment} -N "" -f /ssh/id_ed25519; fi'`,
  );
  if (workspace.evolution?.bootstrapContextFile && workspace.evolution.bootstrapContextContent) {
    renderedCloudinit = renderedCloudinit.replace(
      "      - chmod 1777 /run/workspace/tmp",
      `      - chmod 1777 /run/workspace/tmp\n      - |\n        cat >${workspace.evolution.bootstrapContextFile} <<'EOF'\n${indentBlock(workspace.evolution.bootstrapContextContent, 8)}\n        EOF`,
    );
  }
  if (sshPrivateKey) {
    renderedCloudinit = renderedCloudinit.replace(
      `      - /bin/sh -lc 'if [ ! -f /ssh/id_ed25519 ]; then ssh-keygen -q -t ed25519 -C ${workspace.userProfile.ssh.comment} -N "" -f /ssh/id_ed25519; fi'`,
      `      - |\n        cat >/ssh/id_ed25519 <<'EOF'\n${indentBlock(sshPrivateKey, 8)}\n        EOF\n      - chmod 400 /ssh/id_ed25519${sshPublicKey ? `\n      - |\n        cat >/ssh/id_ed25519.pub <<'EOF'\n${indentBlock(sshPublicKey, 8)}\n        EOF\n      - chmod 644 /ssh/id_ed25519.pub` : ""}`,
    );
  }
  return `${renderedCloudinit.trimEnd()}\n---\n${vmTemplate.trimEnd()}\n`;
}

export function renderAndWriteKubevirtWorkspace(workspace: WorkspaceSpec): string {
  return writeGeneratedManifest(workspace, renderKubevirtWorkspace(workspace));
}
