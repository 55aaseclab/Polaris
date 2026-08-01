import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import yaml from "js-yaml";
import { userIdentityDurablePaths } from "../core/identity-layout.js";
import { workspaceRuntimeResourceName } from "../core/workspace-name.js";
import { assertNoProjectNameCollision } from "./project-ownership.js";
import {
  polarisConfigDockerRoot,
  polarisNetfsLocalExportRoot,
  polarisUsersRoot,
  repoRoot,
} from "../utils/paths.js";

const REPO_ROOT = repoRoot(import.meta.url);
const USER_SECRETS_ROOT = polarisUsersRoot(import.meta.url);
const USER_PROFILES_DIR = path.join(USER_SECRETS_ROOT, "profiles");
const DEMO_USER_PROFILE_ID = "100000000000000001";
const WORKSPACE_SERVICE_PORT_START = 32000;
const WORKSPACE_SERVICE_PORT_END = 32999;

export interface UserWorkspaceDefaults {
  dockerBaseImage: string | null;
}

function workspaceDataNetfsSource(project: string): Record<string, any> {
  return {
    kind: "netfs",
    server: "netfs.local",
    export_path: polarisNetfsLocalExportRoot(import.meta.url),
    sub_path: project,
    mount_options: ["nfsvers=4.1", "hard", "rw"],
    volume_ref: workspaceDataVolumeRef(DEMO_USER_PROFILE_ID, project),
    volume_size: "120Gi",
    description: `shared workspace data for ${project}`,
  };
}

function workspaceDataVolumeRef(userProfileId: string, project: string): string {
  return workspaceRuntimeResourceName(userProfileId, project, "workspace-data");
}

function sanitizeImageTagComponent(raw: string, fallback: string): string {
  const sanitized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || fallback;
}

function neutralUserImageTagSegment(userProfileId: string): string {
  const trimmed = userProfileId.trim();
  if (/^\d+$/.test(trimmed)) {
    return `user-${trimmed.slice(-3).padStart(3, "0")}`;
  }
  return `user-${sanitizeImageTagComponent(trimmed, "default").slice(0, 24)}`;
}

export function workspaceImageRef(userProfileId: string, project: string): string {
  const userSegment = neutralUserImageTagSegment(userProfileId);
  const projectSegment = sanitizeImageTagComponent(project, "workspace").slice(0, 32);
  return `ttl.sh/${userSegment}-${projectSegment}:24h`;
}

export function workspaceConfigPath(
  project: string,
  backendKind: "docker" | "pod" | "kubevirt-vm" = "docker",
  userProfileId: string,
): string {
  const backendFile =
    backendKind === "kubevirt-vm"
      ? "kubevirt.agent.yaml"
      : `${backendKind}.agent.yaml`;
  return path.join(
    USER_SECRETS_ROOT,
    userProfileId.trim(),
    "workspaces",
    project,
    backendFile,
  );
}

export function workspaceConfigExists(project: string, userProfileId?: string): boolean {
  if (!userProfileId?.trim()) {
    assertNoProjectNameCollision(project);
  }
  const candidateUserIds = userProfileId?.trim()
    ? [userProfileId.trim()]
    : fs.existsSync(USER_SECRETS_ROOT)
      ? fs.readdirSync(USER_SECRETS_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
      : [];
  const userScopedMatches = candidateUserIds.flatMap((candidateUserId) => [
    workspaceConfigPath(project, "docker", candidateUserId),
    workspaceConfigPath(project, "pod", candidateUserId),
    workspaceConfigPath(project, "kubevirt-vm", candidateUserId),
  ]);
  return [
    ...userScopedMatches,
    path.join(REPO_ROOT, "agents", `${project}.agent.yaml`),
  ].some((candidate) => fs.existsSync(candidate));
}

function sanitizeUserProfileId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function readGitConfig(key: "user.name" | "user.email"): string {
  const result = spawnSync("git", ["config", "--get", key], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
}

function currentlyListeningPorts(): Set<number> {
  const result = spawnSync("ss", ["-ltnH"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return new Set();
  }

  const ports = new Set<number>();
  for (const line of result.stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const localAddress = fields[3] ?? "";
    const portRaw = localAddress.includes(":") ? localAddress.slice(localAddress.lastIndexOf(":") + 1) : "";
    const port = Number.parseInt(portRaw, 10);
    if (Number.isInteger(port) && port > 0) {
      ports.add(port);
    }
  }
  return ports;
}

function localUserProfileSeed(): { id: string; name: string; email: string } {
  const gitName = process.env.GIT_AUTHOR_NAME?.trim() || readGitConfig("user.name");
  const gitEmail = process.env.GIT_AUTHOR_EMAIL?.trim() || readGitConfig("user.email");
  const systemUser = process.env.USER?.trim() || "user";
  const identitySeed = gitEmail || gitName || systemUser;
  const id = `local-${sanitizeUserProfileId(identitySeed)}`;
  return {
    id,
    name: gitName || systemUser || "Polaris User",
    email: gitEmail || `${sanitizeUserProfileId(systemUser)}@polaris.local`,
  };
}

function userProfilePath(userProfileId: string): string {
  return path.join(USER_PROFILES_DIR, `${userProfileId}.yaml`);
}

function readUserProfileDoc(userProfileId: string): Record<string, any> {
  const profilePath = userProfilePath(userProfileId);
  if (!fs.existsSync(profilePath)) {
    throw new Error(`User profile '${userProfileId}' was not found.`);
  }
  return (yaml.load(fs.readFileSync(profilePath, "utf8")) ?? {}) as Record<string, any>;
}

function writeUserProfileDoc(userProfileId: string, doc: Record<string, any>): void {
  const profilePath = userProfilePath(userProfileId);
  if (!fs.existsSync(profilePath)) {
    throw new Error(`User profile '${userProfileId}' was not found.`);
  }
  fs.writeFileSync(profilePath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
}

function normalizeBaseImage(value: unknown): string | null {
  const baseImage = String(value ?? "").trim();
  return baseImage || null;
}

function readWorkspaceDefaultsDoc(userProfileId: string): Record<string, any> {
  const doc = readUserProfileDoc(userProfileId);
  return doc.workspace_defaults && typeof doc.workspace_defaults === "object"
    ? (doc.workspace_defaults as Record<string, any>)
    : {};
}

export function readUserWorkspaceDefaults(userProfileId: string): UserWorkspaceDefaults {
  const defaults = readWorkspaceDefaultsDoc(userProfileId);
  return {
    dockerBaseImage: normalizeBaseImage(defaults.docker?.runtime?.base_image),
  };
}

function writeWorkspaceDefaultsDoc(
  userProfileId: string,
  defaults: UserWorkspaceDefaults,
): void {
  const doc = readUserProfileDoc(userProfileId);
  const workspaceDefaults = (doc.workspace_defaults ??= {}) as Record<string, any>;
  const dockerDefaults = (workspaceDefaults.docker ??= {}) as Record<string, any>;
  const dockerRuntimeDefaults = (dockerDefaults.runtime ??= {}) as Record<string, any>;

  if (defaults.dockerBaseImage) {
    dockerRuntimeDefaults.base_image = defaults.dockerBaseImage;
  } else {
    delete dockerRuntimeDefaults.base_image;
  }

  if (Object.keys(dockerRuntimeDefaults).length === 0) {
    delete dockerDefaults.runtime;
  }
  if (Object.keys(dockerDefaults).length === 0) {
    delete workspaceDefaults.docker;
  }
  if (Object.keys(workspaceDefaults).length === 0) {
    delete doc.workspace_defaults;
  }

  writeUserProfileDoc(userProfileId, doc);
}

export function setUserWorkspaceDefaults(
  userProfileId: string,
  defaults: UserWorkspaceDefaults,
): UserWorkspaceDefaults {
  writeWorkspaceDefaultsDoc(userProfileId, defaults);
  return readUserWorkspaceDefaults(userProfileId);
}

export function resolveWorkspaceDockerBaseImage(input: {
  userProfileId: string;
  project: string;
  baseImage?: string | null;
}): string {
  const explicitBaseImage = normalizeBaseImage(input.baseImage);
  if (explicitBaseImage) {
    return explicitBaseImage;
  }
  const defaultBaseImage = readUserWorkspaceDefaults(input.userProfileId).dockerBaseImage;
  if (defaultBaseImage) {
    return defaultBaseImage;
  }
  return workspaceImageRef(input.userProfileId, input.project);
}

export function isManagedWorkspaceDockerBaseImage(input: {
  userProfileId: string;
  project: string;
  baseImage?: string | null;
}): boolean {
  return resolveWorkspaceDockerBaseImage(input) === workspaceImageRef(input.userProfileId, input.project);
}

function userCredentialRegistryDir(userProfileId: string): string {
  return path.join(USER_SECRETS_ROOT, userProfileId, "credentials");
}

function configuredWorkspaceServicePorts(): Set<number> {
  const configured = new Set<number>();
  if (!fs.existsSync(USER_SECRETS_ROOT)) {
    return configured;
  }

  for (const userEntry of fs.readdirSync(USER_SECRETS_ROOT, { withFileTypes: true })) {
    if (!userEntry.isDirectory()) {
      continue;
    }
    const workspacesRoot = path.join(USER_SECRETS_ROOT, userEntry.name, "workspaces");
    if (!fs.existsSync(workspacesRoot)) {
      continue;
    }
    for (const projectEntry of fs.readdirSync(workspacesRoot, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) {
        continue;
      }
      const dockerSpecPath = path.join(workspacesRoot, projectEntry.name, "docker.agent.yaml");
      if (!fs.existsSync(dockerSpecPath)) {
        continue;
      }
      const doc = (yaml.load(fs.readFileSync(dockerSpecPath, "utf8")) ?? {}) as {
        service?: { ports?: Array<{ node_port?: unknown }> };
      };
      for (const portEntry of doc.service?.ports ?? []) {
        const value = Number.parseInt(String(portEntry.node_port ?? ""), 10);
        if (Number.isInteger(value) && value > 0) {
          configured.add(value);
        }
      }
    }
  }

  return configured;
}

function allocateWorkspaceServicePort(): string {
  const unavailable = new Set<number>([
    ...configuredWorkspaceServicePorts(),
    ...currentlyListeningPorts(),
  ]);

  for (let port = WORKSPACE_SERVICE_PORT_START; port <= WORKSPACE_SERVICE_PORT_END; port += 1) {
    if (!unavailable.has(port)) {
      return String(port);
    }
  }

  throw new Error(
    `No free workspace service port is available in range ${WORKSPACE_SERVICE_PORT_START}-${WORKSPACE_SERVICE_PORT_END}`,
  );
}

function userDockerfilePath(userProfileId: string): string {
  return path.join(USER_SECRETS_ROOT, userProfileId, "docker", "workspace-prebuilt.Dockerfile");
}

function defaultWorkspaceDockerfileTemplatePath(): string {
  return path.join(
    polarisConfigDockerRoot(import.meta.url),
    "workspace-prebuilt.Dockerfile",
  );
}

function filesHaveSameContents(leftPath: string, rightPath: string): boolean {
  return fs.readFileSync(leftPath).equals(fs.readFileSync(rightPath));
}

export function ensureWorkspaceDockerfile(userProfileId: string): string {
  const target = userDockerfilePath(userProfileId);
  if (fs.existsSync(target)) {
    return target;
  }

  const template = defaultWorkspaceDockerfileTemplatePath();
  if (!fs.existsSync(template)) {
    throw new Error(
      `Default workspace Dockerfile template was not found at ${path.relative(REPO_ROOT, template)}`,
    );
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(template, target);
  return target;
}

export function syncWorkspaceDockerfileTemplate(userProfileId: string): {
  path: string;
  created: boolean;
  refreshed: boolean;
} {
  const target = userDockerfilePath(userProfileId);
  const template = defaultWorkspaceDockerfileTemplatePath();
  if (!fs.existsSync(template)) {
    throw new Error(
      `Default workspace Dockerfile template was not found at ${path.relative(REPO_ROOT, template)}`,
    );
  }
  if (path.resolve(target) === path.resolve(template)) {
    return {
      path: target,
      created: false,
      refreshed: false,
    };
  }
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(template, target);
    return {
      path: target,
      created: true,
      refreshed: false,
    };
  }

  const templateStat = fs.statSync(template);
  const targetStat = fs.statSync(target);
  if (targetStat.mtimeMs >= templateStat.mtimeMs) {
    return {
      path: target,
      created: false,
      refreshed: false,
    };
  }
  if (filesHaveSameContents(template, target)) {
    return {
      path: target,
      created: false,
      refreshed: false,
    };
  }

  fs.copyFileSync(template, target);
  return {
    path: target,
    created: false,
    refreshed: true,
  };
}

function resolveDefaultCredentialBindings(
  userProfileId: string,
): {
  bindings: Array<{
    purpose: "agent-auth" | "git-auth";
    credentialId: string;
    required: boolean;
  }>;
  defaults: string[];
} {
  const registryDir = userCredentialRegistryDir(userProfileId);
  if (!fs.existsSync(registryDir)) {
    return { bindings: [], defaults: [] };
  }

  const credentials = fs.readdirSync(registryDir)
    .filter((entry) => entry.endsWith(".yaml"))
    .map((entry) => {
      const absolute = path.join(registryDir, entry);
      const doc = (yaml.load(fs.readFileSync(absolute, "utf8")) ?? {}) as {
        id?: string;
        purposes?: unknown;
      };
      return {
        id: String(doc.id ?? "").trim(),
        purposes: Array.isArray(doc.purposes)
          ? doc.purposes.map((value) => String(value).trim()).filter(Boolean)
          : [],
      };
    })
    .filter((entry) => entry.id);

  const gitAuth = credentials.find((entry) => entry.purposes.includes("git-auth"));
  const bindings = [
    ...(gitAuth ? [{ purpose: "git-auth" as const, credentialId: gitAuth.id, required: false }] : []),
  ];
  return {
    bindings,
    defaults: bindings.map((binding) => binding.credentialId),
  };
}

export function listDefaultCredentialIds(userProfileId: string): string[] {
  return resolveDefaultCredentialBindings(userProfileId).defaults;
}

function requireWorkspaceGitAuth(userProfileId: string, bindings: Array<{
  purpose: "agent-auth" | "git-auth";
  credentialId: string;
  required: boolean;
}>): void {
  if (bindings.some((binding) => binding.purpose === "git-auth")) {
    return;
  }
  throw new Error(
    `Workspace create requires a git-auth credential for user '${userProfileId}'. Stage SSH credentials first.`,
  );
}

function writeUserSecretsLayout(userProfileId: string): void {
  const secretsRoot = path.join(USER_SECRETS_ROOT, userProfileId);
  fs.mkdirSync(path.join(secretsRoot, "credentials", "ssh"), { recursive: true });
  fs.writeFileSync(path.join(secretsRoot, ".gitignore"), "*\n!.gitignore\n", "utf8");
}

export function createScaffoldUserProfile(profile: {
  id: string;
  name: string;
  email: string;
  referredByCode?: string;
}): {
  id: string;
  name: string;
  email: string;
  created: boolean;
  profilePath: string;
  secretsRoot: string;
} {
  const profilePath = userProfilePath(profile.id);
  const created = fs.existsSync(profilePath) === false;

  if (created) {
    fs.mkdirSync(USER_PROFILES_DIR, { recursive: true });
    fs.mkdirSync(userCredentialRegistryDir(profile.id), { recursive: true });
    fs.writeFileSync(
      profilePath,
      yaml.dump({
        id: profile.id,
        name: profile.name,
        email: profile.email,
        github: {
          account: null,
        },
        ssh: {
          mode: "managed-key",
          comment: profile.email,
        },
        ...(profile.referredByCode
          ? {
            referral: {
              referred_by_code: profile.referredByCode,
              captured_at: new Date().toISOString(),
            },
          }
          : {}),
      }, { lineWidth: 120, noRefs: true }),
      "utf8",
    );
  }

  writeUserSecretsLayout(profile.id);

  return {
    ...profile,
    created,
    profilePath: path.join("config", "users", "profiles", `${profile.id}.yaml`),
    secretsRoot: path.join("config", "users", profile.id),
  };
}

export function ensureScaffoldUserProfile(): {
  id: string;
  name: string;
  email: string;
  created: boolean;
  profilePath: string;
  secretsRoot: string;
} {
  return createScaffoldUserProfile(localUserProfileSeed());
}

export function scaffoldUserProfileById(input: {
  id: string;
  name?: string;
  email?: string;
  referredByCode?: string;
}): {
  id: string;
  name: string;
  email: string;
  created: boolean;
  profilePath: string;
  secretsRoot: string;
} {
  const id = sanitizeUserProfileId(input.id);
  return createScaffoldUserProfile({
    id,
    name: input.name?.trim() || id,
    email: input.email?.trim() || `${id}@polaris.local`,
    ...(input.referredByCode?.trim()
      ? { referredByCode: input.referredByCode.trim() }
      : {}),
  });
}

export function userProfileExists(userProfileId: string): boolean {
  return fs.existsSync(userProfilePath(userProfileId));
}

export function scaffoldDockerWorkspace(
  project: string,
  userProfileId: string,
  options?: {
    baseImage?: string | null;
  },
): string {
  const outputPath = workspaceConfigPath(project, "docker", userProfileId);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const baseImage = resolveWorkspaceDockerBaseImage({
    userProfileId,
    project,
    baseImage: options?.baseImage,
  });
  if (baseImage === workspaceImageRef(userProfileId, project)) {
    ensureWorkspaceDockerfile(userProfileId);
  }
  const defaultCredentials = resolveDefaultCredentialBindings(userProfileId);
  requireWorkspaceGitAuth(userProfileId, defaultCredentials.bindings);
  const workspaceServicePort = allocateWorkspaceServicePort();
  const doc = {
    project,
    user_profile: userProfileId,
    backend: {
      kind: "docker",
      spec_files: null,
    },
    credentials: {
      bindings: defaultCredentials.bindings,
    },
    runtime: {
      class: "docker",
      base_image: baseImage,
      user: "root",
      storage_claim_name: null,
      privileged: null,
      docker_enabled: true,
    },
    resources: {
      cpu: "8",
      memory: "16Gi",
      ephemeral_storage: "120Gi",
      cpu_request: "2",
      memory_request: "4Gi",
      ephemeral_storage_request: "20Gi",
      unbounded: true,
    },
    agent: {
      kind: "multi",
      label: "Codex + Claude Code",
      args: [],
      persist_state: true,
    },
    tooling: {
      bootstrap_profile: "prebuilt",
      install_rustup: true,
      git_core_editor: "vi",
    },
    env: {
      plain: {},
    },
    service: {
      enabled: true,
      mode: "nodeport",
      ports: [
        {
          container_port: "6767",
          node_port: workspaceServicePort,
          name: "paseo",
        },
      ],
      host: null,
      path: "/",
    },
    attachments: {
      "workspace-data": {
        scope: "workspace",
        sharing: "exclusive",
        mount_root: "/workspace/project",
        durable_paths: ["/workspace/project"],
        source: workspaceDataNetfsSource(project),
      },
      "workspace-runtime-state": {
        scope: "workspace",
        sharing: "exclusive",
        mount_root: "/workspace/state",
        durable_paths: ["/workspace/state/paseo", "/workspace/state/paseo/evolution"],
        source: {
          kind: "generated-material",
          description: `docker workspace runtime state for ${project}`,
        },
      },
      "user-identity-state": {
        scope: "user",
        sharing: "cross-workspace",
        mount_root: "/identity",
        durable_paths: userIdentityDurablePaths("/identity"),
        source: {
          kind: "secret-material",
          description: "user identity material sourced from spec auth files",
        },
      },
      "ephemeral-runtime": {
        mount_root: "/run/workspace",
        paths: ["/run/workspace/tmp", "/run/workspace/pids", "/run/workspace/sockets"],
        stale_artifacts: ["/root/.paseo/paseo.pid", "/run/workspace/pids/paseo.pid"],
      },
    },
    profile: "morpheus",
  };

  fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
  return outputPath;
}
