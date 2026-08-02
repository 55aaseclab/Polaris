import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import yaml from "js-yaml";
import { parseVaultReference } from "./load.js";
import { syncVaultDockerfileTemplate, vaultConfigPath, vaultImageRef } from "./scaffold.js";
import { vaultRuntimeResourceName } from "../core/vault-name.js";
import { logInfo } from "../utils/log.js";
import {
  polarisNetfsLocalExportRoot,
  polarisUsersRoot,
  repoRoot,
} from "../utils/paths.js";
import { runCommand } from "../utils/shell.js";

const REPO_ROOT = repoRoot(import.meta.url);
const USER_ROOT = polarisUsersRoot(import.meta.url);

type BackendKind = "docker" | "pod" | "kubevirt-vm";

function vaultDataNetfsSource(project: string, userProfileId: string): Record<string, any> {
  return {
    kind: "netfs",
    server: "netfs.local",
    export_path: polarisNetfsLocalExportRoot(import.meta.url),
    sub_path: project,
    mount_options: ["nfsvers=4.1", "hard", "rw"],
    volume_ref: vaultRuntimeResourceName(userProfileId, project, "vault-data"),
    volume_size: "120Gi",
    description: `shared vault data for ${project}`,
  };
}

interface VaultConfigMatch {
  userProfileId: string;
  project: string;
  backendKind: BackendKind;
  configPath: string;
}

interface VaultImageBuildState {
  imageRef: string;
  sharedImageRef: string;
  dockerfileDigest: string;
  dockerfilePath: string;
  updatedAt: string;
}

function sanitizeImageTagSegment(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "default";
}

function sharedVaultImageRef(dockerfileDigest: string): string {
  return `ttl.sh/polaris-vault-prebuilt-${sanitizeImageTagSegment(dockerfileDigest).slice(0, 32)}:24h`;
}

function configMatches(project: string, userProfileId?: string): VaultConfigMatch[] {
  if (!fs.existsSync(USER_ROOT)) {
    return [];
  }

  const candidateUserIds = userProfileId?.trim()
    ? [userProfileId.trim()]
    : fs.readdirSync(USER_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

  return candidateUserIds
    .flatMap((candidateUserId) =>
      (["docker", "pod", "kubevirt-vm"] as const)
        .map((backendKind) => {
          const configPath = vaultConfigPath(project, backendKind, candidateUserId);
          return fs.existsSync(configPath)
            ? {
                userProfileId: candidateUserId,
                project,
                backendKind,
                configPath,
              }
            : null;
        })
        .filter(Boolean) as VaultConfigMatch[],
    )
    .sort((left, right) => left.configPath.localeCompare(right.configPath));
}

function findConfig(
  project: string,
  backendKind: BackendKind,
  userProfileId?: string,
): VaultConfigMatch | null {
  return configMatches(project, userProfileId).find((match) => match.backendKind === backendKind) ?? null;
}

function bestSourceConfig(project: string, userProfileId?: string): VaultConfigMatch | null {
  const matches = configMatches(project, userProfileId);
  return matches.find((match) => match.backendKind === "docker") ?? matches[0] ?? null;
}

function readConfigDoc(configPath: string): Record<string, any> {
  return (yaml.load(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<string, any>;
}

function cloneDoc<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultNodePort(userProfileId: string): string {
  const digits = userProfileId.replace(/\D+/g, "");
  const suffix = Number.parseInt(digits.slice(-3) || "0", 10);
  return String(32000 + (suffix % 1000));
}

function ensureService(doc: Record<string, any>, userProfileId: string): void {
  const service = ((doc.service ??= {}) as Record<string, any>);
  service.enabled ??= true;
  service.mode ??= "nodeport";
  service.host ??= null;
  service.path ??= "/";
  if (!Array.isArray(service.ports) || service.ports.length === 0) {
    service.ports = [];
  }
  const port = ((service.ports[0] ??= {}) as Record<string, any>);
  port.container_port ??= "6767";
  port.node_port ??= defaultNodePort(userProfileId);
  port.name ??= "paseo";
}

function synthesizeAttachments(
  doc: Record<string, any>,
  project: string,
  userProfileId: string,
  backendKind: BackendKind,
): void {
  const attachments = ((doc.attachments ??= {}) as Record<string, any>);
  const vaultData = ((attachments["vault-data"] ??= {}) as Record<string, any>);
  const vaultRuntimeState = ((attachments["vault-runtime-state"] ??= {}) as Record<string, any>);
  const userIdentityState = ((attachments["user-identity-state"] ??= {}) as Record<string, any>);

  if (backendKind === "kubevirt-vm") {
    vaultData.source = vaultDataNetfsSource(project, userProfileId);
    vaultRuntimeState.source = {
      kind: "persistent-volume",
      volume_ref: vaultRuntimeResourceName(userProfileId, project, "vault-runtime-state"),
      volume_size: "20Gi",
      description: `reusable vault runtime state for ${project}`,
    };
    userIdentityState.source = {
      kind: "persistent-volume",
      volume_ref: vaultRuntimeResourceName(userProfileId, project, "user-identity-state"),
      volume_size: "5Gi",
      description: `persistent user identity state for ${project}`,
    };
    return;
  }

  if (backendKind === "pod") {
    vaultData.source = vaultDataNetfsSource(project, userProfileId);
    vaultRuntimeState.source = {
      kind: "persistent-volume",
      volume_ref: vaultRuntimeResourceName(userProfileId, project, "vault-runtime-state"),
      volume_size: "20Gi",
      description: `reusable vault runtime state for ${project}`,
    };
    userIdentityState.source ??= {
      kind: "secret-material",
      description: "user identity material sourced from spec auth files",
    };
    return;
  }

  vaultData.source = vaultDataNetfsSource(project, userProfileId);
  vaultRuntimeState.source = {
    kind: "persistent-volume",
    volume_ref: vaultRuntimeResourceName(userProfileId, project, "vault-runtime-state"),
    volume_size: "20Gi",
    description: `reusable ${backendKind} vault runtime state for ${project}`,
  };
  userIdentityState.source ??= {
    kind: "secret-material",
    description: "user identity material sourced from spec auth files",
  };
}

function synthesizeConfigDoc(
  sourceDoc: Record<string, any>,
  project: string,
  userProfileId: string,
  backendKind: BackendKind,
  profileHint?: string,
): Record<string, any> {
  const doc = cloneDoc(sourceDoc);
  doc.project = project;
  doc.user_profile = userProfileId;
  doc.backend = {
    ...(doc.backend ?? {}),
    kind: backendKind,
    spec_files: null,
  };
  doc.runtime = {
    ...(doc.runtime ?? {}),
    class: backendKind === "docker" ? "docker" : profileHint || "gvisor",
    base_image: doc.runtime?.base_image ?? vaultImageRef(userProfileId, project),
    user: doc.runtime?.user ?? "root",
    privileged: doc.runtime?.privileged ?? null,
    docker_enabled: doc.runtime?.docker_enabled ?? true,
  };
  if (backendKind === "kubevirt-vm") {
    doc.runtime.rootdisk_image ??= null;
    delete doc.runtime.storage_claim_name;
  } else {
    doc.runtime.storage_claim_name ??= null;
    delete doc.runtime.rootdisk_image;
  }
  doc.resources = {
    cpu: "8",
    memory: "16Gi",
    ephemeral_storage: "120Gi",
    cpu_request: "2",
    memory_request: "4Gi",
    ephemeral_storage_request: "20Gi",
    unbounded: true,
    ...(doc.resources ?? {}),
  };
  doc.tooling = {
    bootstrap_profile: "prebuilt",
    install_rustup: false,
    git_core_editor: "vi",
    ...(doc.tooling ?? {}),
  };
  ensureService(doc, userProfileId);
  synthesizeAttachments(doc, project, userProfileId, backendKind);
  doc.profile ??= "morpheus";
  return doc;
}

export function ensureVaultConfig(
  projectRef: string,
  userProfileId?: string,
): VaultConfigMatch | null {
  const { project, backendHint, profileHint } = parseVaultReference(projectRef);
  if (!backendHint) {
    return null;
  }

  const existing = findConfig(project, backendHint, userProfileId);
  if (existing) {
    return existing;
  }

  const source = bestSourceConfig(project, userProfileId);
  if (!source) {
    return null;
  }

  const sourceDoc = readConfigDoc(source.configPath);
  const outputPath = vaultConfigPath(project, backendHint, source.userProfileId);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const synthesized = synthesizeConfigDoc(
    sourceDoc,
    project,
    source.userProfileId,
    backendHint,
    profileHint,
  );
  fs.writeFileSync(outputPath, yaml.dump(synthesized, { lineWidth: 120, noRefs: true }), "utf8");
  logInfo("provision", "vault-config-synthesized", {
    project,
    backend: backendHint,
    sourceBackend: source.backendKind,
    configPath: path.relative(REPO_ROOT, outputPath),
  });
  return {
    userProfileId: source.userProfileId,
    project,
    backendKind: backendHint,
    configPath: outputPath,
  };
}

function hasLocalImage(imageRef: string): boolean {
  try {
    runCommand("docker", ["image", "inspect", imageRef]);
    return true;
  } catch {
    return false;
  }
}

function canPullImage(imageRef: string): boolean {
  try {
    runCommand("docker", ["pull", imageRef]);
    return true;
  } catch {
    return false;
  }
}

function vaultImageBuildStatePath(source: VaultConfigMatch): string {
  return path.join(path.dirname(source.configPath), "state", "image-build.json");
}

function digestFile(filePath: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function readVaultImageBuildState(
  source: VaultConfigMatch,
): VaultImageBuildState | null {
  const statePath = vaultImageBuildStatePath(source);
  if (!fs.existsSync(statePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as VaultImageBuildState;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeVaultImageBuildState(
  source: VaultConfigMatch,
  state: VaultImageBuildState,
): void {
  const statePath = vaultImageBuildStatePath(source);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function buildSharedVaultImage(args: {
  dockerfilePath: string;
  sharedImageRef: string;
  cacheRefs: string[];
}): void {
  logInfo("provision", "vault-shared-image-build", {
    sharedImageRef: args.sharedImageRef,
    dockerfile: path.relative(REPO_ROOT, args.dockerfilePath),
    cacheRefs: args.cacheRefs,
  });
  const commandArgs = ["build"];
  for (const cacheRef of args.cacheRefs) {
    commandArgs.push("--cache-from", cacheRef);
  }
  commandArgs.push("-f", args.dockerfilePath, "-t", args.sharedImageRef, ".");
  runCommand("docker", commandArgs);
}

function tagVaultImage(sharedImageRef: string, imageRef: string): void {
  if (sharedImageRef === imageRef) {
    return;
  }
  logInfo("provision", "vault-image-tag", {
    sharedImageRef,
    imageRef,
  });
  runCommand("docker", ["tag", sharedImageRef, imageRef]);
}

function allRecordedVaultImageRefs(dockerfileDigest: string): string[] {
  if (!fs.existsSync(USER_ROOT)) {
    return [];
  }
  const refs = new Set<string>();
  for (const userEntry of fs.readdirSync(USER_ROOT, { withFileTypes: true })) {
    if (!userEntry.isDirectory()) {
      continue;
    }
    const vaultsRoot = path.join(USER_ROOT, userEntry.name, "vaults");
    if (!fs.existsSync(vaultsRoot)) {
      continue;
    }
    for (const vaultEntry of fs.readdirSync(vaultsRoot, { withFileTypes: true })) {
      if (!vaultEntry.isDirectory()) {
        continue;
      }
      const statePath = path.join(vaultsRoot, vaultEntry.name, "state", "image-build.json");
      if (!fs.existsSync(statePath)) {
        continue;
      }
      try {
        const parsed = JSON.parse(
          fs.readFileSync(statePath, "utf8"),
        ) as Partial<VaultImageBuildState>;
        if (parsed.dockerfileDigest !== dockerfileDigest) {
          continue;
        }
        if (typeof parsed.sharedImageRef === "string" && parsed.sharedImageRef.trim()) {
          refs.add(parsed.sharedImageRef.trim());
        }
        if (typeof parsed.imageRef === "string" && parsed.imageRef.trim()) {
          refs.add(parsed.imageRef.trim());
        }
      } catch {
        continue;
      }
    }
  }
  return [...refs];
}

export function ensureCanonicalVaultImage(
  projectRef: string,
  userProfileId?: string,
): void {
  const { project } = parseVaultReference(projectRef);
  const ensured = ensureVaultConfig(projectRef, userProfileId);
  const source = ensured ?? bestSourceConfig(project, userProfileId);
  if (!source) {
    return;
  }

  const sourceDoc = readConfigDoc(source.configPath);
  const imageRef = vaultImageRef(source.userProfileId, source.project);
  const configuredBaseImage = String(sourceDoc.runtime?.base_image ?? "").trim();
  if (configuredBaseImage && configuredBaseImage !== imageRef) {
    logInfo("provision", "vault-image-external", {
      project: source.project,
      userProfileId: source.userProfileId,
      imageRef: configuredBaseImage,
      configPath: path.relative(REPO_ROOT, source.configPath),
    });
    return;
  }

  const dockerfileState = syncVaultDockerfileTemplate(source.userProfileId);
  const dockerfileDigest = digestFile(dockerfileState.path);
  const sharedImageRef = sharedVaultImageRef(dockerfileDigest);
  const recordedBuild = readVaultImageBuildState(source);
  const buildStateMatches =
    recordedBuild?.imageRef === imageRef
    && recordedBuild?.sharedImageRef === sharedImageRef
    && recordedBuild?.dockerfileDigest === dockerfileDigest
    && recordedBuild?.dockerfilePath === path.relative(REPO_ROOT, dockerfileState.path);
  const recordBuild = (): void => {
    writeVaultImageBuildState(source, {
      imageRef,
      sharedImageRef,
      dockerfileDigest,
      dockerfilePath: path.relative(REPO_ROOT, dockerfileState.path),
      updatedAt: new Date().toISOString(),
    });
  };
  if (buildStateMatches && (hasLocalImage(imageRef) || canPullImage(imageRef))) {
    return;
  }

  const dockerfile = dockerfileState.path;
  if (!fs.existsSync(dockerfile)) {
    throw new Error(
      `Canonical vault image '${imageRef}' is missing and no Dockerfile was found at ${path.relative(REPO_ROOT, dockerfile)}`,
    );
  }

  if (hasLocalImage(sharedImageRef) || canPullImage(sharedImageRef)) {
    logInfo("provision", "vault-image-reused", {
      project: source.project,
      userProfileId: source.userProfileId,
      imageRef,
      sharedImageRef,
      dockerfile: path.relative(REPO_ROOT, dockerfile),
      reason: buildStateMatches
        ? "vault-image-missing"
        : dockerfileState.refreshed
          ? "dockerfile-template-refreshed"
          : recordedBuild
            ? "dockerfile-digest-changed"
            : "image-build-state-missing",
    });
    tagVaultImage(sharedImageRef, imageRef);
    recordBuild();
    return;
  }

  logInfo("provision", "vault-image-build", {
    project: source.project,
    userProfileId: source.userProfileId,
    imageRef,
    sharedImageRef,
    dockerfile: path.relative(REPO_ROOT, dockerfile),
    reason: dockerfileState.created
      ? "dockerfile-created"
      : dockerfileState.refreshed
        ? "dockerfile-template-refreshed"
      : !buildStateMatches
        ? (recordedBuild ? "dockerfile-digest-changed" : "image-build-state-missing")
        : "image-missing",
  });
  buildSharedVaultImage({
    dockerfilePath: dockerfile,
    sharedImageRef,
    cacheRefs: [sharedImageRef, imageRef, ...allRecordedVaultImageRefs(dockerfileDigest)],
  });
  tagVaultImage(sharedImageRef, imageRef);
  recordBuild();
}

export function ensureProvisionedVault(projectRef: string, userProfileId?: string): void {
  ensureVaultConfig(projectRef, userProfileId);
  ensureCanonicalVaultImage(projectRef, userProfileId);
}
