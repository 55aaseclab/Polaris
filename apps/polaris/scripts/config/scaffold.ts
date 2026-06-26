import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import yaml from "js-yaml";
import { assertNoProjectNameCollision } from "./project-ownership.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../");
const USER_PROFILES_DIR = path.join(REPO_ROOT, "config", "users", "profiles");
const USER_SECRETS_ROOT = path.join(REPO_ROOT, "config", "users");
const DEMO_USER_PROFILE_ID = "100000000000000001";

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
    REPO_ROOT,
    "config",
    "users",
    userProfileId.trim(),
    "projects",
    project,
    backendFile,
  );
}

export function workspaceConfigExists(project: string): boolean {
  assertNoProjectNameCollision(project);
  const userScopedRoot = path.join(REPO_ROOT, "config", "users");
  const userScopedMatches = fs.existsSync(userScopedRoot)
    ? fs.readdirSync(userScopedRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => [
        workspaceConfigPath(project, "docker", entry.name),
        workspaceConfigPath(project, "pod", entry.name),
        workspaceConfigPath(project, "kubevirt-vm", entry.name),
      ])
    : [];
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

function userCredentialRegistryDir(userProfileId: string): string {
  return path.join(USER_SECRETS_ROOT, userProfileId, "credentials");
}

function userDockerfilePath(userProfileId: string): string {
  return path.join(USER_SECRETS_ROOT, userProfileId, "docker", "workspace-prebuilt.Dockerfile");
}

export function ensureWorkspaceDockerfile(userProfileId: string): string {
  const target = userDockerfilePath(userProfileId);
  if (fs.existsSync(target)) {
    return target;
  }

  const template = userDockerfilePath(DEMO_USER_PROFILE_ID);
  if (!fs.existsSync(template)) {
    throw new Error(
      `Default workspace Dockerfile template was not found at ${path.relative(REPO_ROOT, template)}`,
    );
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(template, target);
  return target;
}

function ensureWorkspaceListedInUserProfile(userProfileId: string, project: string): void {
  const profilePath = userProfilePath(userProfileId);
  if (!fs.existsSync(profilePath)) {
    return;
  }
  const data = (yaml.load(fs.readFileSync(profilePath, "utf8")) ?? {}) as Record<string, any>;
  const workspaces = Array.isArray(data.workspaces)
    ? data.workspaces.map((item) => String(item)).filter(Boolean)
    : [];
  if (workspaces.includes(project)) {
    return;
  }
  data.workspaces = [...workspaces, project].sort();
  fs.writeFileSync(profilePath, yaml.dump(data, { lineWidth: 120, noRefs: true }), "utf8");
}

function writeUserSecretsLayout(userProfileId: string): void {
  const secretsRoot = path.join(USER_SECRETS_ROOT, userProfileId);
  fs.mkdirSync(path.join(secretsRoot, "credentials", "codex"), { recursive: true });
  fs.mkdirSync(path.join(secretsRoot, "credentials", "claude"), { recursive: true });
  fs.mkdirSync(path.join(secretsRoot, "credentials", "ssh"), { recursive: true });
  fs.writeFileSync(path.join(secretsRoot, ".gitignore"), "*\n!.gitignore\n", "utf8");
}

export function createScaffoldUserProfile(profile: {
  id: string;
  name: string;
  email: string;
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
        workspaces: [],
        github: {
          account: null,
        },
        ssh: {
          mode: "managed-key",
          comment: profile.email,
        },
      }, { lineWidth: 120, noRefs: true }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(userCredentialRegistryDir(profile.id), "codex-default.yaml"),
      yaml.dump({
        id: "codex-default",
        userId: profile.id,
        kind: "codex-auth",
        label: "Default Codex + Claude auth",
        purposes: ["agent-auth"],
        materialRef: {
          type: "file",
          key: "user-identity-state/default",
          files: [
            {
              key: "codex-auth.json",
              source_path: "credentials/codex/auth.json",
            },
            {
              key: "codex-config.toml",
              source_path: "credentials/codex/config.toml",
            },
            {
              key: "claude-settings.json",
              source_path: "credentials/claude/settings.json",
            },
          ],
        },
        metadata: {
          provider: "local",
        },
        status: "ready",
      }, { lineWidth: 120, noRefs: true }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(userCredentialRegistryDir(profile.id), "github-ssh.yaml"),
      yaml.dump({
        id: "github-ssh",
        userId: profile.id,
        kind: "ssh-key",
        label: "Default SSH key",
        purposes: ["git-auth", "ssh-auth"],
        materialRef: {
          type: "file",
          key: "user-ssh-state/default",
          files: [
            {
              key: "id_ed25519",
              source_path: "credentials/ssh/id_ed25519",
            },
            {
              key: "id_ed25519.pub",
              source_path: "credentials/ssh/id_ed25519.pub",
            },
          ],
        },
        metadata: {
          provider: "local",
        },
        status: "ready",
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
  });
}

export function userProfileExists(userProfileId: string): boolean {
  return fs.existsSync(userProfilePath(userProfileId));
}

export function scaffoldDockerWorkspace(project: string, userProfileId: string): string {
  const outputPath = workspaceConfigPath(project, "docker", userProfileId);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  ensureWorkspaceDockerfile(userProfileId);
  ensureWorkspaceListedInUserProfile(userProfileId, project);
  const doc = {
    project,
    user_profile: userProfileId,
    backend: {
      kind: "docker",
      spec_files: null,
    },
    credentials: {
      bindings: [
        {
          purpose: "agent-auth",
          credentialId: "codex-default",
          required: true,
        },
        {
          purpose: "git-auth",
          credentialId: "github-ssh",
          required: false,
        },
      ],
    },
    runtime: {
      class: "docker",
      base_image: workspaceImageRef(userProfileId, project),
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
          node_port: "6767",
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
        durable_paths: [
          "/identity/codex",
          "/identity/claude",
          "/identity/codex-xdg/config",
          "/identity/codex-xdg/data",
          "/identity/codex-xdg/state",
        ],
        source: {
          kind: "secret-material",
          description: "user identity material sourced from spec auth files",
        },
      },
      "user-ssh-state": {
        scope: "user",
        sharing: "cross-workspace",
        mount_root: "/ssh",
        durable_paths: ["/ssh"],
        source: {
          kind: "generated-material",
          description: "user SSH material",
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
