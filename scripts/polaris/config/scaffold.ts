import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import yaml from "js-yaml";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const USER_PROFILES_DIR = path.join(REPO_ROOT, "config", "users", "profiles");
const USER_SECRETS_ROOT = path.join(REPO_ROOT, "config", "users");

export function workspaceConfigPath(project: string, backendKind: "docker" | "pod" | "kubevirt-vm" = "docker"): string {
  const backendDir = backendKind === "kubevirt-vm" ? "kubevirt" : backendKind;
  return path.join(REPO_ROOT, "config", "specs", backendDir, "projects", `${project}.agent.yaml`);
}

export function workspaceConfigExists(project: string): boolean {
  return [
    workspaceConfigPath(project, "docker"),
    workspaceConfigPath(project, "pod"),
    workspaceConfigPath(project, "kubevirt-vm"),
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

function writeUserSecretsLayout(userProfileId: string): void {
  const secretsRoot = path.join(USER_SECRETS_ROOT, userProfileId);
  fs.mkdirSync(path.join(secretsRoot, "codex"), { recursive: true });
  fs.mkdirSync(path.join(secretsRoot, "claude"), { recursive: true });
  fs.writeFileSync(path.join(secretsRoot, ".gitignore"), "*\n!.gitignore\n", "utf8");
}

export function ensureScaffoldUserProfile(): {
  id: string;
  name: string;
  email: string;
  created: boolean;
  profilePath: string;
  secretsRoot: string;
} {
  const profile = localUserProfileSeed();
  const profilePath = userProfilePath(profile.id);
  const created = fs.existsSync(profilePath) === false;

  if (created) {
    fs.mkdirSync(USER_PROFILES_DIR, { recursive: true });
    fs.writeFileSync(
      profilePath,
      yaml.dump({
        id: profile.id,
        name: profile.name,
        email: profile.email,
        ssh: {
          mode: "managed-key",
          comment: profile.email,
        },
        auth: {
          files: [
            {
              key: "codex-auth.json",
              mount_path: "/root/.codex/auth.json",
              source_path: "codex/auth.json",
              content: null,
            },
            {
              key: "codex-config.toml",
              mount_path: "/root/.codex/config.toml",
              source_path: "codex/config.toml",
              content: null,
            },
            {
              key: "claude-settings.json",
              mount_path: "/root/.claude/settings.json",
              source_path: "claude/settings.json",
              content: null,
            },
          ],
        },
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

export function scaffoldDockerWorkspace(project: string, userProfileId: string): string {
  const outputPath = workspaceConfigPath(project, "docker");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const doc = {
    project,
    user_profile: userProfileId,
    backend: {
      kind: "docker",
      spec_files: null,
    },
    runtime: {
      class: "docker",
      base_image: "ttl.sh/morpheus-prebuilt-1781875178:24h",
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
        source: {
          kind: "generated-material",
          description: `docker workspace data for ${project}`,
        },
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
        durable_paths: ["/identity/codex", "/identity/claude"],
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
