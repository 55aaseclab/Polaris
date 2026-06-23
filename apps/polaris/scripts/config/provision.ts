import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { parseWorkspaceReference } from "./load.js";
import { workspaceConfigPath, workspaceImageRef } from "./scaffold.js";
import { logInfo } from "../utils/log.js";
import { runCommand } from "../utils/shell.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../");

type BackendKind = "docker" | "pod" | "kubevirt-vm";

function workspaceDataNetfsSource(project: string): Record<string, any> {
  return {
    kind: "netfs",
    server: "netfs.local",
    export_path: "/exports/polaris/workspaces",
    sub_path: project,
    mount_options: ["nfsvers=4.1", "hard", "rw"],
    volume_ref: `${project}-workspace-data`,
    volume_size: "120Gi",
    description: `shared workspace data for ${project}`,
  };
}

interface WorkspaceConfigMatch {
  userProfileId: string;
  project: string;
  backendKind: BackendKind;
  configPath: string;
}

function configMatches(project: string): WorkspaceConfigMatch[] {
  const usersRoot = path.join(REPO_ROOT, "config", "users");
  if (!fs.existsSync(usersRoot)) {
    return [];
  }

  return fs
    .readdirSync(usersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      (["docker", "pod", "kubevirt-vm"] as const)
        .map((backendKind) => {
          const configPath = workspaceConfigPath(project, backendKind, entry.name);
          return fs.existsSync(configPath)
            ? {
                userProfileId: entry.name,
                project,
                backendKind,
                configPath,
              }
            : null;
        })
        .filter(Boolean) as WorkspaceConfigMatch[],
    )
    .sort((left, right) => left.configPath.localeCompare(right.configPath));
}

function findConfig(project: string, backendKind: BackendKind): WorkspaceConfigMatch | null {
  return configMatches(project).find((match) => match.backendKind === backendKind) ?? null;
}

function bestSourceConfig(project: string): WorkspaceConfigMatch | null {
  const matches = configMatches(project);
  return matches.find((match) => match.backendKind === "docker") ?? matches[0] ?? null;
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
  backendKind: BackendKind,
): void {
  const attachments = ((doc.attachments ??= {}) as Record<string, any>);
  const workspaceData = ((attachments["workspace-data"] ??= {}) as Record<string, any>);
  const workspaceRuntimeState = ((attachments["workspace-runtime-state"] ??= {}) as Record<string, any>);
  const userIdentityState = ((attachments["user-identity-state"] ??= {}) as Record<string, any>);
  const userSshState = ((attachments["user-ssh-state"] ??= {}) as Record<string, any>);

  if (backendKind === "kubevirt-vm") {
    workspaceData.source = workspaceDataNetfsSource(project);
    workspaceRuntimeState.source = {
      kind: "persistent-volume",
      volume_ref: `${project}-workspace-runtime-state`,
      volume_size: "20Gi",
      description: `reusable workspace runtime state for ${project}`,
    };
    userIdentityState.source = {
      kind: "persistent-volume",
      volume_ref: `${project}-user-identity-state`,
      volume_size: "5Gi",
      description: `persistent user identity state for ${project}`,
    };
    userSshState.source = {
      kind: "persistent-volume",
      volume_ref: `${project}-user-ssh-state`,
      volume_size: "1Gi",
      description: `persistent user SSH state for ${project}`,
    };
    return;
  }

  if (backendKind === "pod") {
    workspaceData.source = workspaceDataNetfsSource(project);
    workspaceRuntimeState.source = {
      kind: "persistent-volume",
      volume_ref: `${project}-workspace-runtime-state`,
      volume_size: "20Gi",
      description: `reusable workspace runtime state for ${project}`,
    };
    userIdentityState.source ??= {
      kind: "secret-material",
      description: "user identity material sourced from spec auth files",
    };
    userSshState.source ??= {
      kind: "generated-material",
      description: "user SSH material",
    };
    return;
  }

  const volumeRef = `${project}-project`;
  workspaceData.source = workspaceDataNetfsSource(project);
  workspaceRuntimeState.source = {
    kind: "persistent-volume",
    volume_ref: volumeRef,
    sub_path: "state",
    description: `reusable ${backendKind} workspace runtime state for ${project}`,
  };
  userIdentityState.source ??= {
    kind: "secret-material",
    description: "user identity material sourced from spec auth files",
  };
  userSshState.source ??= {
    kind: "generated-material",
    description: `reusable user SSH material for ${project}`,
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
    base_image: doc.runtime?.base_image ?? workspaceImageRef(userProfileId, project),
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
  synthesizeAttachments(doc, project, backendKind);
  doc.profile ??= "morpheus";
  return doc;
}

export function ensureWorkspaceConfig(projectRef: string): WorkspaceConfigMatch | null {
  const { project, backendHint, profileHint } = parseWorkspaceReference(projectRef);
  if (!backendHint) {
    return null;
  }

  const existing = findConfig(project, backendHint);
  if (existing) {
    return existing;
  }

  const source = bestSourceConfig(project);
  if (!source) {
    return null;
  }

  const sourceDoc = (yaml.load(fs.readFileSync(source.configPath, "utf8")) ?? {}) as Record<string, any>;
  const outputPath = workspaceConfigPath(project, backendHint, source.userProfileId);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const synthesized = synthesizeConfigDoc(
    sourceDoc,
    project,
    source.userProfileId,
    backendHint,
    profileHint,
  );
  fs.writeFileSync(outputPath, yaml.dump(synthesized, { lineWidth: 120, noRefs: true }), "utf8");
  logInfo("provision", "workspace-config-synthesized", {
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

function userDockerfilePath(userProfileId: string): string {
  return path.join(REPO_ROOT, "config", "users", userProfileId, "docker", "workspace-prebuilt.Dockerfile");
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

export function ensureCanonicalWorkspaceImage(projectRef: string): void {
  const { project } = parseWorkspaceReference(projectRef);
  const ensured = ensureWorkspaceConfig(projectRef);
  const source = ensured ?? bestSourceConfig(project);
  if (!source) {
    return;
  }

  const imageRef = workspaceImageRef(source.userProfileId, source.project);
  if (hasLocalImage(imageRef) || canPullImage(imageRef)) {
    return;
  }

  const dockerfile = userDockerfilePath(source.userProfileId);
  if (!fs.existsSync(dockerfile)) {
    throw new Error(
      `Canonical workspace image '${imageRef}' is missing and no Dockerfile was found at ${path.relative(REPO_ROOT, dockerfile)}`,
    );
  }

  logInfo("provision", "workspace-image-build", {
    project: source.project,
    userProfileId: source.userProfileId,
    imageRef,
    dockerfile: path.relative(REPO_ROOT, dockerfile),
  });
  runCommand("docker", ["build", "-f", dockerfile, "-t", imageRef, "."]);
  runCommand("docker", ["push", imageRef]);
}

export function ensureProvisionedWorkspace(projectRef: string): void {
  ensureWorkspaceConfig(projectRef);
  ensureCanonicalWorkspaceImage(projectRef);
}
