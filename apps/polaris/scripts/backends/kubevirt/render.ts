import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { WorkspaceSpec } from "../../core/workspace.js";
import { resolveConfiguredPaseoAppBaseUrl } from "../../core/pairing-url.js";
import { resolveRepoRoot } from "../../utils/repo-root.js";
import { kubevirtProbePassword } from "./probe-access.js";
import {
  isNetfsSource,
  netfsResolvedPath,
  requireNetfsField,
  workspaceDataClaimName,
  workspaceDataPersistentVolumeName,
} from "../../core/netfs.js";
import { writeGeneratedManifest } from "../../output/write-generated.js";

const REPO_ROOT = resolveRepoRoot(import.meta.url);
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

function existingPersistentVolumeClaimName(
  workspace: WorkspaceSpec,
  claimName: string,
): string | null {
  const result = spawnSync(
    "kubectl",
    [
      "-n",
      workspace.identity.projectName,
      "get",
      "pvc",
      claimName,
      "-o",
      "jsonpath={.metadata.name}",
    ],
    { encoding: "utf8" },
  );
  const name = String(result.stdout || "").trim();
  return result.status === 0 && name ? name : null;
}

function buildPersistentVolumeClaimDocs(workspace: WorkspaceSpec): string {
  const docs: string[] = [];
  if (isNetfsSource(workspace.attachments.workspaceData.source)) {
    const source = workspace.attachments.workspaceData.source;
    const claimName = workspaceDataClaimName(workspace);
    if (!existingPersistentVolumeClaimName(workspace, claimName)) {
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
    }
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
  const paseoAppBaseUrl = resolveConfiguredPaseoAppBaseUrl();
  const rootdiskImage =
    workspace.runtime.rootdiskImage || "quay.io/containerdisks/debian:13";
  const memoryGuest =
    workspace.resources.memory || "4Gi";
  const memoryRequest =
    workspace.resources.memoryRequest || memoryGuest;
  const declaredPorts = workspace.connectivity.servicePorts.map((port, index) => ({
    name: port.name?.trim() || `service-${index + 1}`,
    containerPort: String(port.containerPort),
    nodePort: port.nodePort ? String(port.nodePort) : undefined,
  }));
  const sshDeclared = declaredPorts.some((port) => port.containerPort === "22" || port.name === "ssh");
  const servicePorts = sshDeclared
    ? declaredPorts
    : [...declaredPorts, { name: "ssh", containerPort: "22" as const, nodePort: undefined }];
  const renderedServicePorts = servicePorts
    .map((port) => [
      `    - name: ${port.name}`,
      `      port: ${port.containerPort}`,
      `      targetPort: ${port.containerPort}`,
      ...(port.nodePort ? [`      nodePort: ${port.nodePort}`] : []),
    ].join("\n"))
    .join("\n");
  const renderedInterfacePorts = servicePorts
    .map((port) => [
      `                - port: ${port.containerPort}`,
      "                  protocol: TCP",
    ].join("\n"))
    .join("\n");
  return text
    .replaceAll(
      "__PERSISTENT_VOLUME_CLAIMS__",
      `${buildPersistentVolumeClaimDocs(workspace)}\n`,
    )
    .replaceAll("__SERVICE_PORTS__", renderedServicePorts)
    .replaceAll("__INTERFACE_PORTS__", renderedInterfacePorts)
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
    .replaceAll("__ROOTDISK_IMAGE__", rootdiskImage)
    .replaceAll("__MEMORY_GUEST__", memoryGuest)
    .replaceAll("__MEMORY_REQUEST__", memoryRequest)
    .replaceAll(
      "__PASEO_APP_BASE_URL_ASSIGNMENT__",
      paseoAppBaseUrl
        ? `data.setdefault("app", {})["baseUrl"] = ${JSON.stringify(paseoAppBaseUrl)}; `
        : "",
    );
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
  let renderedCloudinit = cloudinitTemplate
    .replace("__CODEX_AUTH_JSON_B64__", Buffer.from(codexAuth ?? "{}", "utf8").toString("base64"))
    .replace("__CODEX_CONFIG_TOML_B64__", Buffer.from(codexConfig ?? "", "utf8").toString("base64"))
    .replace("__CLAUDE_SETTINGS_JSON_B64__", Buffer.from("{}", "utf8").toString("base64"))
    .replace("__PROBE_PASSWORD__", kubevirtProbePassword(workspace));
  const evolutionOutputs = [
    [workspace.evolution?.workspaceMemoryFile, workspace.evolution?.workspaceMemoryContent],
    [workspace.evolution?.userMemoryFile, workspace.evolution?.userMemoryContent],
    [workspace.evolution?.sessionSnapshotFile, workspace.evolution?.sessionSnapshotContent],
  ] as Array<[string | undefined, string | undefined]>;
  const writes = evolutionOutputs
    .filter(([filePath, content]) => Boolean(filePath && content))
    .map(([filePath, content]) => `      - |\n        cat >${filePath} <<'EOF'\n${indentBlock(content || "", 8)}\n        EOF`)
    .join("\n");
  if (writes) {
    renderedCloudinit = renderedCloudinit.replace(
      "      - chmod 1777 /run/workspace/tmp",
      `      - chmod 1777 /run/workspace/tmp\n${writes}`,
    );
  }
  return `${renderedCloudinit.trimEnd()}\n---\n${vmTemplate.trimEnd()}\n`;
}

export function renderAndWriteKubevirtWorkspace(workspace: WorkspaceSpec): string {
  return writeGeneratedManifest(workspace, renderKubevirtWorkspace(workspace));
}
