import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import yaml from "js-yaml";
import { userIdentityDurablePaths } from "../core/identity-layout.js";
import { vaultRuntimeResourceName } from "../core/vault-name.js";
import { assertNoProjectNameCollision } from "./project-ownership.js";
import {
  polarisConfigDockerRoot,
  polarisNetfsLocalExportRoot,
  polarisUsersRoot,
  repoRelativePath,
  repoRoot,
} from "../utils/paths.js";

const REPO_ROOT = repoRoot(import.meta.url);
const USER_SECRETS_ROOT = polarisUsersRoot(import.meta.url);
const USER_PROFILES_DIR = path.join(USER_SECRETS_ROOT, "profiles");
const DEMO_USER_PROFILE_ID = "100000000000000001";
const VAULT_SERVICE_PORT_START = 32000;
const VAULT_SERVICE_PORT_END = 32999;

export interface UserVaultDefaults {}

export type VaultSubscriptionLine = "coding" | "vertical";

function vaultDataNetfsSource(project: string): Record<string, any> {
  return {
    kind: "netfs",
    server: "netfs.local",
    export_path: polarisNetfsLocalExportRoot(import.meta.url),
    sub_path: project,
    mount_options: ["nfsvers=4.1", "hard", "rw"],
    volume_ref: vaultDataVolumeRef(DEMO_USER_PROFILE_ID, project),
    volume_size: "120Gi",
    description: `shared vault data for ${project}`,
  };
}

function vaultDataVolumeRef(userProfileId: string, project: string): string {
  return vaultRuntimeResourceName(userProfileId, project, "vault-data");
}

function sanitizeImageTagComponent(
  raw: string,
  fallback: string,
  maxLength?: number,
): string {
  const sanitized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const bounded = maxLength === undefined
    ? sanitized
    : sanitized.slice(0, maxLength).replace(/^-+|-+$/g, "");
  return bounded || fallback;
}

function neutralUserImageTagSegment(userProfileId: string): string {
  const trimmed = userProfileId.trim();
  if (/^\d+$/.test(trimmed)) {
    return `user-${trimmed.slice(-3).padStart(3, "0")}`;
  }
  return `user-${sanitizeImageTagComponent(trimmed, "default", 24)}`;
}

export function vaultImageRef(userProfileId: string, project: string): string {
  const userSegment = neutralUserImageTagSegment(userProfileId);
  const projectSegment = sanitizeImageTagComponent(project, "vault", 32);
  return `ttl.sh/${userSegment}-${projectSegment}:24h`;
}

export function vaultConfigPath(
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
    "vaults",
    project,
    backendFile,
  );
}

export function vaultConfigExists(project: string, userProfileId?: string): boolean {
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
    vaultConfigPath(project, "docker", candidateUserId),
    vaultConfigPath(project, "pod", candidateUserId),
    vaultConfigPath(project, "kubevirt-vm", candidateUserId),
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

export function readUserVaultDefaults(userProfileId: string): UserVaultDefaults {
  void userProfileId;
  return {};
}

function writeVaultDefaultsDoc(
  userProfileId: string,
  defaults: UserVaultDefaults,
): void {
  void defaults;
  const doc = readUserProfileDoc(userProfileId);
  const vaultDefaults =
    doc.vault_defaults && typeof doc.vault_defaults === "object"
      ? (doc.vault_defaults as Record<string, any>)
      : null;
  const dockerDefaults =
    vaultDefaults?.docker && typeof vaultDefaults.docker === "object"
      ? vaultDefaults.docker as Record<string, any>
      : null;
  const dockerRuntimeDefaults =
    dockerDefaults?.runtime && typeof dockerDefaults.runtime === "object"
      ? dockerDefaults.runtime as Record<string, any>
      : null;

  if (dockerRuntimeDefaults && "base_image" in dockerRuntimeDefaults) {
    delete dockerRuntimeDefaults.base_image;
  }
  if (dockerRuntimeDefaults && Object.keys(dockerRuntimeDefaults).length === 0 && dockerDefaults) {
    delete dockerDefaults.runtime;
  }
  if (dockerDefaults && Object.keys(dockerDefaults).length === 0 && vaultDefaults) {
    delete vaultDefaults.docker;
  }
  if (vaultDefaults && Object.keys(vaultDefaults).length === 0) {
    delete doc.vault_defaults;
  }

  writeUserProfileDoc(userProfileId, doc);
}

export function setUserVaultDefaults(
  userProfileId: string,
  defaults: UserVaultDefaults,
): UserVaultDefaults {
  writeVaultDefaultsDoc(userProfileId, defaults);
  return readUserVaultDefaults(userProfileId);
}

export function resolveVaultDockerBaseImage(input: {
  userProfileId: string;
  project: string;
  baseImage?: string | null;
  line?: VaultSubscriptionLine;
}): string {
  const explicitBaseImage = normalizeBaseImage(input.baseImage);
  if (explicitBaseImage) {
    return explicitBaseImage;
  }
  if (input.line === "vertical") {
    return verticalVaultBaseImage();
  }
  return vaultImageRef(input.userProfileId, input.project);
}

export function isManagedVaultDockerBaseImage(input: {
  userProfileId: string;
  project: string;
  baseImage?: string | null;
}): boolean {
  return resolveVaultDockerBaseImage(input) === vaultImageRef(input.userProfileId, input.project);
}

function userCredentialRegistryDir(userProfileId: string): string {
  return path.join(USER_SECRETS_ROOT, userProfileId, "credentials");
}

function configuredVaultServicePorts(): Set<number> {
  const configured = new Set<number>();
  if (!fs.existsSync(USER_SECRETS_ROOT)) {
    return configured;
  }

  for (const userEntry of fs.readdirSync(USER_SECRETS_ROOT, { withFileTypes: true })) {
    if (!userEntry.isDirectory()) {
      continue;
    }
    const vaultsRoot = path.join(USER_SECRETS_ROOT, userEntry.name, "vaults");
    if (!fs.existsSync(vaultsRoot)) {
      continue;
    }
    for (const projectEntry of fs.readdirSync(vaultsRoot, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) {
        continue;
      }
      const dockerSpecPath = path.join(vaultsRoot, projectEntry.name, "docker.agent.yaml");
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

function allocateVaultServicePort(unavailableExtra: Iterable<number> = []): string {
  const unavailable = new Set<number>([
    ...configuredVaultServicePorts(),
    ...currentlyListeningPorts(),
    ...unavailableExtra,
  ]);

  for (let port = VAULT_SERVICE_PORT_START; port <= VAULT_SERVICE_PORT_END; port += 1) {
    if (!unavailable.has(port)) {
      return String(port);
    }
  }

  throw new Error(
    `No free vault service port is available in range ${VAULT_SERVICE_PORT_START}-${VAULT_SERVICE_PORT_END}`,
  );
}

/** Vertical wanghai portal listens in-container; coding-only images do not. */
export const WANGHAI_PORTAL_CONTAINER_PORT = "9090";
export const DEFAULT_WANGHAI_VAULT_IMAGE = "wanghai-admin-portal:latest";
export const WANGHAI_PROFILE_ENV_FILE_KEY = "wanghai-root-env";
export const WANGHAI_PROFILE_ENV_SOURCE_PATH = "wanghai/.env";
export const WANGHAI_PROFILE_ENV_MOUNT_PATH = "/opt/wanghai/.env";
export const WANGHAI_VAULTS_RUNTIME_ROOT = "/vault/project/vaults";
export const WANGHAI_BACKUP_RUNTIME_ROOT = "/vault/project/backups";
export const WANGHAI_CACHE_RUNTIME_ROOT = "/vault/project/cache";

export function verticalVaultBaseImage(): string {
  return String(process.env.POLARIS_WANGHAI_VAULT_IMAGE ?? "").trim()
    || DEFAULT_WANGHAI_VAULT_IMAGE;
}

export function isWanghaiVerticalBaseImage(baseImage: string | null | undefined): boolean {
  const image = String(baseImage ?? "").trim().toLowerCase();
  if (!image) {
    return false;
  }
  return image.includes("wanghai-admin-portal") || /(^|\/)wanghai([:@]|$)/.test(image);
}

export function wanghaiProfileEnvAuthFile(): {
  key: string;
  mount_path: string;
  source_path: string;
  optional: true;
} {
  return {
    key: WANGHAI_PROFILE_ENV_FILE_KEY,
    mount_path: WANGHAI_PROFILE_ENV_MOUNT_PATH,
    source_path: WANGHAI_PROFILE_ENV_SOURCE_PATH,
    optional: true,
  };
}

function ensureUserProfileWanghaiEnvEntry(doc: Record<string, any>): Record<string, any> {
  const auth = doc.auth && typeof doc.auth === "object"
    ? doc.auth as Record<string, any>
    : {};
  const files = Array.isArray(auth.files) ? [...auth.files] : [];
  const hasWanghaiEnvEntry = files.some((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const file = entry as Record<string, unknown>;
    return String(file.key ?? "").trim() === WANGHAI_PROFILE_ENV_FILE_KEY
      || String(file.mount_path ?? "").trim() === WANGHAI_PROFILE_ENV_MOUNT_PATH
      || String(file.source_path ?? "").trim() === WANGHAI_PROFILE_ENV_SOURCE_PATH;
  });
  if (!hasWanghaiEnvEntry) {
    files.push(wanghaiProfileEnvAuthFile());
  }
  return {
    ...doc,
    auth: {
      ...auth,
      files,
    },
  };
}

function userDockerfilePath(userProfileId: string): string {
  return path.join(USER_SECRETS_ROOT, userProfileId, "docker", "vault-prebuilt.Dockerfile");
}

function defaultVaultDockerfileTemplatePath(): string {
  return path.join(
    polarisConfigDockerRoot(import.meta.url),
    "vault-prebuilt.Dockerfile",
  );
}

function filesHaveSameContents(leftPath: string, rightPath: string): boolean {
  return fs.readFileSync(leftPath).equals(fs.readFileSync(rightPath));
}

export function ensureVaultDockerfile(userProfileId: string): string {
  const target = userDockerfilePath(userProfileId);
  if (fs.existsSync(target)) {
    return target;
  }

  const template = defaultVaultDockerfileTemplatePath();
  if (!fs.existsSync(template)) {
    throw new Error(
      `Default vault Dockerfile template was not found at ${path.relative(REPO_ROOT, template)}`,
    );
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(template, target);
  return target;
}

export function syncVaultDockerfileTemplate(userProfileId: string): {
  path: string;
  created: boolean;
  refreshed: boolean;
} {
  const target = userDockerfilePath(userProfileId);
  const template = defaultVaultDockerfileTemplatePath();
  if (!fs.existsSync(template)) {
    throw new Error(
      `Default vault Dockerfile template was not found at ${path.relative(REPO_ROOT, template)}`,
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

function requireVaultGitAuth(userProfileId: string, bindings: Array<{
  purpose: "agent-auth" | "git-auth";
  credentialId: string;
  required: boolean;
}>): void {
  if (bindings.some((binding) => binding.purpose === "git-auth")) {
    return;
  }
  throw new Error(
    `Vault create requires a git-auth credential for user '${userProfileId}'. Stage SSH credentials first.`,
  );
}

function writeUserSecretsLayout(userProfileId: string): void {
  const secretsRoot = path.join(USER_SECRETS_ROOT, userProfileId);
  fs.mkdirSync(path.join(secretsRoot, "credentials", "ssh"), { recursive: true });
  fs.mkdirSync(path.join(secretsRoot, "wanghai"), { recursive: true });
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
  fs.mkdirSync(USER_PROFILES_DIR, { recursive: true });
  fs.mkdirSync(userCredentialRegistryDir(profile.id), { recursive: true });
  const profileDoc = created
    ? {
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
      }
    : (yaml.load(fs.readFileSync(profilePath, "utf8")) ?? {}) as Record<string, any>;
  fs.writeFileSync(
    profilePath,
    yaml.dump(
      ensureUserProfileWanghaiEnvEntry(profileDoc),
      { lineWidth: 120, noRefs: true },
    ),
    "utf8",
  );

  writeUserSecretsLayout(profile.id);

  return {
    ...profile,
    created,
    profilePath: repoRelativePath(import.meta.url, profilePath),
    secretsRoot: repoRelativePath(import.meta.url, path.join(USER_SECRETS_ROOT, profile.id)),
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

export function scaffoldDockerVault(
  project: string,
  userProfileId: string,
  options?: {
    baseImage?: string | null;
    line?: VaultSubscriptionLine;
  },
): string {
  const outputPath = vaultConfigPath(project, "docker", userProfileId);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const baseImage = resolveVaultDockerBaseImage({
    userProfileId,
    project,
    baseImage: options?.baseImage,
    line: options?.line,
  });
  if (baseImage === vaultImageRef(userProfileId, project)) {
    ensureVaultDockerfile(userProfileId);
  }
  const defaultCredentials = resolveDefaultCredentialBindings(userProfileId);
  requireVaultGitAuth(userProfileId, defaultCredentials.bindings);
  const vaultServicePort = allocateVaultServicePort();
  const verticalWanghai = isWanghaiVerticalBaseImage(baseImage);
  const wanghaiServicePort = verticalWanghai
    ? allocateVaultServicePort([Number.parseInt(vaultServicePort, 10)])
    : null;
  const servicePorts: Array<Record<string, string>> = [
    {
      container_port: "6767",
      node_port: vaultServicePort,
      name: "paseo",
    },
  ];
  if (wanghaiServicePort) {
    servicePorts.push({
      container_port: WANGHAI_PORTAL_CONTAINER_PORT,
      node_port: wanghaiServicePort,
      name: "wanghai",
    });
  }
  const doc = {
    project,
    user_profile: userProfileId,
    surfaces: verticalWanghai ? ["paseo", "wanghai"] : ["paseo"],
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
      plain: verticalWanghai
        ? {
            WANGHAI_REPO_ROOT: "/opt/wanghai",
            WANGHAI_VAULTS_ROOT: WANGHAI_VAULTS_RUNTIME_ROOT,
            WANGHAI_BACKUP_ROOT: WANGHAI_BACKUP_RUNTIME_ROOT,
            WANGHAI_CACHE_ROOT: WANGHAI_CACHE_RUNTIME_ROOT,
          }
        : {},
    },
    service: {
      enabled: true,
      mode: "nodeport",
      ports: servicePorts,
      host: null,
      path: "/",
    },
    attachments: {
      "vault-data": {
        scope: "vault",
        sharing: "exclusive",
        mount_root: "/vault/project",
        durable_paths: ["/vault/project"],
        source: vaultDataNetfsSource(project),
      },
      "vault-runtime-state": {
        scope: "vault",
        sharing: "exclusive",
        mount_root: "/vault/state",
        durable_paths: ["/vault/state/paseo", "/vault/state/paseo/evolution"],
        source: {
          kind: "generated-material",
          description: `docker vault runtime state for ${project}`,
        },
      },
      "user-identity-state": {
        scope: "user",
        sharing: "cross-vault",
        mount_root: "/identity",
        durable_paths: userIdentityDurablePaths("/identity"),
        source: {
          kind: "secret-material",
          description: "user identity material sourced from spec auth files",
        },
      },
      "ephemeral-runtime": {
        mount_root: "/run/vault",
        paths: ["/run/vault/tmp", "/run/vault/pids", "/run/vault/sockets"],
        stale_artifacts: ["/root/.paseo/paseo.pid", "/run/vault/pids/paseo.pid"],
      },
    },
    profile: "morpheus",
  };

  fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
  return outputPath;
}
