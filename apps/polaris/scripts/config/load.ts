import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type {
  WorkspaceSpec,
  PlainEnvVar,
  AuthFile,
  ServicePort,
  WorkspaceAttachments,
  DurableAttachment,
  DirectAttachmentConfig,
  DirectDurableAttachmentConfig,
  DirectEphemeralRuntimeConfig,
  WorkspaceProfile,
  WorkspaceAgentContract,
  UserProfile,
} from "../core/workspace.js";
import { validateWorkspace } from "../core/capabilities.js";
import { readWorkspaceDriverSelection } from "../output/state-store.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../");

const BUILTIN_PROFILES: Record<string, WorkspaceProfile> = {
  morpheus: {
    name: "morpheus",
    assetBaseName: "morpheus",
    workspaceAlias: "Morpheus",
    defaults: {
      runtime: {
        baseImage: "ttl.sh/morpheus-prebuilt-1781875178:24h",
        bootstrapProfile: "prebuilt",
        user: "root",
      },
      service: {
        path: "/",
      },
    },
  },
};

const USER_PROFILES_DIR = path.join(REPO_ROOT, "config", "users", "profiles");
const USER_SECRETS_ROOT = path.join(REPO_ROOT, "config", "users");
const POD_PROFILE_SPECS_DIR = path.join(REPO_ROOT, "config", "specs", "pod", "profiles");

export function parseWorkspaceReference(projectRef: string): {
  project: string;
  backendHint?: WorkspaceSpec["backend"]["kind"];
  profileHint?: string;
} {
  const match = /^(.+?)@((?:pod)|(?:docker)|(?:kubevirt-vm))(?:[:]([a-zA-Z0-9_.-]+))?$/.exec(projectRef.trim());
  if (!match) {
    return { project: projectRef.trim() };
  }
  return {
    project: match[1],
    backendHint: match[2] as WorkspaceSpec["backend"]["kind"],
    profileHint: match[3] ? String(match[3]) : undefined,
  };
}

function resolveBackendHint(project: string, explicitHint?: WorkspaceSpec["backend"]["kind"]): WorkspaceSpec["backend"]["kind"] | undefined {
  if (explicitHint) {
    return explicitHint;
  }
  return readWorkspaceDriverSelection(project)?.backend;
}

function resolveProfileHint(project: string, explicitHint?: string): string | undefined {
  if (explicitHint) {
    return explicitHint;
  }
  return readWorkspaceDriverSelection(project)?.profile;
}

function loadPodProfileDefaults(profileName: string): { backendProfile?: string } {
  const profilePath = path.join(POD_PROFILE_SPECS_DIR, `${profileName}.yaml`);
  if (!fs.existsSync(profilePath)) {
    return {};
  }
  const data = (yaml.load(fs.readFileSync(profilePath, "utf8")) ?? {}) as Record<string, any>;
  return {
    backendProfile: data.backend?.profile ? String(data.backend.profile) : undefined,
  };
}

function specCandidates(project: string, backendHint?: WorkspaceSpec["backend"]["kind"]): string[] {
  const preferredBackend =
    backendHint === "kubevirt-vm"
      ? "kubevirt"
      : backendHint;
  const configuredSpecs = [
    path.join(REPO_ROOT, "config", "specs", "pod", "projects", `${project}.agent.yaml`),
    path.join(REPO_ROOT, "config", "specs", "kubevirt", "projects", `${project}.agent.yaml`),
    path.join(REPO_ROOT, "config", "specs", "docker", "projects", `${project}.agent.yaml`),
  ];
  const orderedSpecs = preferredBackend
    ? [
        path.join(REPO_ROOT, "config", "specs", preferredBackend, "projects", `${project}.agent.yaml`),
        ...configuredSpecs.filter((candidate) => !candidate.includes(`/${preferredBackend}/`)),
      ]
    : configuredSpecs;
  return [
    ...orderedSpecs,
    path.join(REPO_ROOT, "agents", `${project}.agent.yaml`)
  ];
}

function resolveWorkspaceProfile(rawProfile: unknown, projectName: string): WorkspaceProfile {
  const profileName =
    typeof rawProfile === "string" && rawProfile.trim()
      ? rawProfile.trim()
      : projectName === "morpheus"
        ? "morpheus"
        : "morpheus";
  const profile = BUILTIN_PROFILES[profileName];
  if (!profile) {
    throw new Error(`Unknown workspace profile '${profileName}'`);
  }
  return profile;
}

function userProfilePath(userProfileId: string): string {
  return path.join(USER_PROFILES_DIR, `${userProfileId}.yaml`);
}

function sanitizeUserProfileId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function buildCompatibilityUserProfile(args: {
  runtimeUser: string;
  gitUserName?: string;
  gitUserEmail?: string;
}): UserProfile {
  const identitySeed = args.gitUserEmail || args.gitUserName || args.runtimeUser || "default";
  const id = `legacy-${sanitizeUserProfileId(identitySeed)}`;
  const name = args.gitUserName || "Polaris User";
  const email = args.gitUserEmail || `${sanitizeUserProfileId(args.runtimeUser || "user")}@polaris.local`;
  return {
    id,
    name,
    email,
    secretsRoot: path.join("config", "users", id),
    github: {},
    ssh: {
      mode: "managed-key",
      comment: `${id}@polaris`,
    },
    agentIdentity: {
      codex: "default",
      claude: "default",
    },
    authFiles: [],
  };
}

function mergeAuthFiles(primary: AuthFile[], secondary: AuthFile[]): AuthFile[] {
  const merged = new Map<string, AuthFile>();
  for (const file of secondary) {
    merged.set(file.key, file);
  }
  for (const file of primary) {
    merged.set(file.key, file);
  }
  return Array.from(merged.values());
}

function resolveAuthSourcePath(sourcePath: string, baseDir: string): string {
  return path.isAbsolute(sourcePath) ? sourcePath : path.resolve(baseDir, sourcePath);
}

function resolveUserProfile(rawUserProfile: unknown, args: {
  runtimeUser: string;
  gitUserName?: string;
  gitUserEmail?: string;
}): UserProfile {
  const rawProfileId =
    typeof rawUserProfile === "string" || typeof rawUserProfile === "number"
      ? String(rawUserProfile).trim()
      : "";
  if (rawProfileId) {
    const profileId = rawProfileId;
    const profilePath = userProfilePath(profileId);
    if (!fs.existsSync(profilePath)) {
      throw new Error(`Unknown user profile '${profileId}'`);
    }
    const data = (yaml.load(fs.readFileSync(profilePath, "utf8")) ?? {}) as Record<string, any>;
    return {
      id: String(data.id ?? profileId),
      name: String(data.name ?? ""),
      email: String(data.email ?? ""),
      secretsRoot: path.join("config", "users", profileId),
      github: {
        account: data.github?.account
          ? String(data.github.account)
          : data.github?.repo
            ? String(data.github.repo)
            : undefined,
      },
      ssh: {
        mode: data.ssh?.mode === "provided-key" ? "provided-key" : "managed-key",
        comment: String(data.ssh?.comment ?? `${profileId}@polaris`),
      },
      agentIdentity: {
        codex: String(data.agent_identity?.codex ?? "default"),
        claude: String(data.agent_identity?.claude ?? "default"),
      },
      authFiles: normalizeAuthFiles(data.auth?.files, path.join(USER_SECRETS_ROOT, profileId)),
    };
  }
  return buildCompatibilityUserProfile(args);
}

function canonicalHome(user: string, projectName: string): string {
  return user === "root" ? "/root" : `/home/${user || projectName}`;
}

function authFileKind(file: AuthFile, home: string): "identity" | "ssh" {
  const normalizedHome = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^${normalizedHome}/\\.ssh/`).test(file.mountPath) || file.key.includes("ssh")) {
    return "ssh";
  }
  return "identity";
}

function buildAttachment(
  kind: DurableAttachment["kind"],
  scope: DurableAttachment["scope"],
  sharing: DurableAttachment["sharing"],
  mountRoot: string,
  durablePaths: string[],
  source: DurableAttachment["source"],
): DurableAttachment {
  return {
    kind,
    scope,
    sharing,
    mountRoot,
    durablePaths,
    source,
  };
}

function normalizeDirectDurableAttachmentConfig(raw: unknown): DirectDurableAttachmentConfig | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  return {
    scope: entry.scope === "user" ? "user" : "workspace",
    sharing: entry.sharing === "cross-workspace" ? "cross-workspace" : "exclusive",
    mountRoot: String(entry.mount_root ?? ""),
    durablePaths: Array.isArray(entry.durable_paths) ? entry.durable_paths.map((item) => String(item)) : [],
    source: {
      kind: String((entry.source as Record<string, unknown> | undefined)?.kind ?? "generated-material") as DirectDurableAttachmentConfig["source"]["kind"],
      volumeRef: (entry.source as Record<string, unknown> | undefined)?.volume_ref ? String((entry.source as Record<string, unknown>).volume_ref) : undefined,
      subPath: (entry.source as Record<string, unknown> | undefined)?.sub_path ? String((entry.source as Record<string, unknown>).sub_path) : undefined,
      description: (entry.source as Record<string, unknown> | undefined)?.description ? String((entry.source as Record<string, unknown>).description) : undefined,
    },
  };
}

function normalizeDirectEphemeralRuntimeConfig(raw: unknown): DirectEphemeralRuntimeConfig | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  return {
    mountRoot: String(entry.mount_root ?? ""),
    paths: Array.isArray(entry.paths) ? entry.paths.map((item) => String(item)) : [],
    staleArtifacts: Array.isArray(entry.stale_artifacts) ? entry.stale_artifacts.map((item) => String(item)) : [],
  };
}

function normalizeDirectAttachmentConfig(raw: unknown): DirectAttachmentConfig | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const attachments = raw as Record<string, unknown>;
  const workspaceData = normalizeDirectDurableAttachmentConfig(attachments["workspace-data"]);
  const workspaceRuntimeState = normalizeDirectDurableAttachmentConfig(attachments["workspace-runtime-state"]);
  const userIdentityState = normalizeDirectDurableAttachmentConfig(attachments["user-identity-state"]);
  const userSshState = normalizeDirectDurableAttachmentConfig(attachments["user-ssh-state"]);
  const ephemeralRuntime = normalizeDirectEphemeralRuntimeConfig(attachments["ephemeral-runtime"]);
  if (!workspaceData || !workspaceRuntimeState || !userIdentityState || !userSshState || !ephemeralRuntime) {
    return null;
  }
  return {
    "workspace-data": workspaceData,
    "workspace-runtime-state": workspaceRuntimeState,
    "user-identity-state": userIdentityState,
    "user-ssh-state": userSshState,
    "ephemeral-runtime": ephemeralRuntime,
  };
}

function buildWorkspaceAttachmentsFromDirectConfig(config: DirectAttachmentConfig): WorkspaceAttachments {
  const runtimeDurablePaths = Array.from(new Set([
    ...config["workspace-runtime-state"].durablePaths,
    `${config["workspace-runtime-state"].mountRoot.replace(/\/+$/, "")}/paseo/evolution`,
  ]));
  return {
    workspaceData: buildAttachment(
      "workspace-data",
      config["workspace-data"].scope,
      config["workspace-data"].sharing,
      config["workspace-data"].mountRoot,
      config["workspace-data"].durablePaths,
      config["workspace-data"].source,
    ),
    workspaceRuntimeState: buildAttachment(
      "workspace-runtime-state",
      config["workspace-runtime-state"].scope,
      config["workspace-runtime-state"].sharing,
      config["workspace-runtime-state"].mountRoot,
      runtimeDurablePaths,
      config["workspace-runtime-state"].source,
    ),
    userIdentityState: buildAttachment(
      "user-identity-state",
      config["user-identity-state"].scope,
      config["user-identity-state"].sharing,
      config["user-identity-state"].mountRoot,
      config["user-identity-state"].durablePaths,
      config["user-identity-state"].source,
    ),
    userSshState: buildAttachment(
      "user-ssh-state",
      config["user-ssh-state"].scope,
      config["user-ssh-state"].sharing,
      config["user-ssh-state"].mountRoot,
      config["user-ssh-state"].durablePaths,
      config["user-ssh-state"].source,
    ),
    ephemeralRuntime: {
      mountRoot: config["ephemeral-runtime"].mountRoot,
      paths: config["ephemeral-runtime"].paths,
      staleArtifacts: config["ephemeral-runtime"].staleArtifacts,
    },
  };
}

function translateLegacyAttachments(args: {
  projectName: string;
  home: string;
  persistState: boolean;
  claimName: string;
  authFiles: AuthFile[];
  backendKind: WorkspaceSpec["backend"]["kind"];
}): WorkspaceAttachments {
  const workspaceVolumeSource = args.persistState
    ? {
        kind: "persistent-volume" as const,
        volumeRef: args.claimName,
        description: `workspace-scoped persistent storage for ${args.projectName}`,
      }
    : {
        kind: "generated-material" as const,
        description: `ephemeral workspace storage for ${args.projectName}`,
      };
  const identityFiles = args.authFiles.filter((file) => authFileKind(file, args.home) === "identity");
  const sshFiles = args.authFiles.filter((file) => authFileKind(file, args.home) === "ssh");

  return {
    workspaceData: buildAttachment(
      "workspace-data",
      "workspace",
      "exclusive",
      "/workspace/project",
      ["/workspace/project"],
      workspaceVolumeSource,
    ),
    workspaceRuntimeState: buildAttachment(
      "workspace-runtime-state",
      "workspace",
      "exclusive",
      "/workspace/state",
      ["/workspace/state/paseo", "/workspace/state/paseo/evolution"],
      {
        ...workspaceVolumeSource,
        subPath: "state",
        description: `workspace runtime state for ${args.projectName}`,
      },
    ),
    userIdentityState: buildAttachment(
      "user-identity-state",
      "user",
      "cross-workspace",
      "/identity",
      ["/identity/codex", "/identity/claude"],
      {
        kind: "secret-material",
        description: identityFiles.length
          ? `user identity material sourced from ${identityFiles.map((file) => file.key).join(", ")}`
          : "user identity material",
      },
    ),
    userSshState: buildAttachment(
      "user-ssh-state",
      "user",
      "cross-workspace",
      "/ssh",
      ["/ssh"],
      {
        kind: sshFiles.length ? "secret-material" : "generated-material",
        description: sshFiles.length ? `user SSH material sourced from ${sshFiles.map((file) => file.key).join(", ")}` : "user SSH material",
      },
    ),
    ephemeralRuntime: {
      mountRoot: "/run/workspace",
      paths: ["/run/workspace/tmp", "/run/workspace/pids", "/run/workspace/sockets"],
      staleArtifacts: ["/run/workspace/pids/paseo.pid"],
    },
  };
}

function normalizeAuthFiles(rawFiles: unknown, baseDir = REPO_ROOT): AuthFile[] {
  const files = Array.isArray(rawFiles) ? rawFiles : [];
  return files
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    .map((entry) => ({
      key: String(entry.key ?? ""),
      mountPath: String(entry.mount_path ?? ""),
      content:
        entry.content
          ? String(entry.content)
          : entry.source_path && fs.existsSync(resolveAuthSourcePath(String(entry.source_path), baseDir))
            ? fs.readFileSync(resolveAuthSourcePath(String(entry.source_path), baseDir), "utf8")
            : undefined,
      sourcePath: entry.source_path ? resolveAuthSourcePath(String(entry.source_path), baseDir) : undefined
    }))
    .filter((entry) => entry.key && entry.mountPath);
}

function normalizeAgentKind(rawKind: unknown): string {
  const kind = String(rawKind ?? "").trim().toLowerCase();
  if (!kind || kind === "none" || kind === "disabled") {
    return "";
  }
  return kind;
}

function buildAgentContract(home: string, agentKind: string): WorkspaceAgentContract {
  const enabled = Boolean(agentKind);
  const stateRoot = `${home}/.paseo`;
  const evolutionRoot = `${stateRoot}/evolution`;
  return {
    enabled,
    managerId: enabled ? "paseo" : "none",
    contractVersion: "v1",
    capabilities: {
      supportsEventStream: enabled,
      supportsTranscriptReplay: enabled,
      supportsStructuredArtifacts: enabled,
      supportsReview: enabled,
      supportsRetrieval: enabled,
      supportsCuration: enabled,
      requiresDaemon: enabled,
      supportsPairing: enabled,
    },
    harnesses: enabled ? ["codex", "claude"] : [],
    bootstrapSecretsRoot: "/bootstrap-secrets",
    runtime: {
      stateRoot,
      evolutionRoot,
      readyFile: "/tmp/.ready",
      pairingFile: enabled ? `${stateRoot}/pairing.json` : undefined,
      staleRuntimeArtifacts: enabled ? [`${stateRoot}/paseo.pid`, "/run/workspace/pids/paseo.pid"] : [],
    },
  };
}

function normalizePlainEnv(rawPlain: unknown): PlainEnvVar[] {
  if (!rawPlain || typeof rawPlain !== "object") {
    return [];
  }
  return Object.entries(rawPlain as Record<string, unknown>).map(([name, value]) => ({
    name,
    value: String(value ?? "")
  }));
}

function normalizeServicePorts(service: Record<string, unknown>): ServicePort[] {
  const ports = Array.isArray(service.ports) ? service.ports : [];
  if (ports.length > 0) {
    return ports
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
      .map((entry) => ({
        containerPort: String(entry.container_port ?? ""),
        nodePort: entry.node_port ? String(entry.node_port) : undefined,
        name: entry.name ? String(entry.name) : undefined
      }))
      .filter((entry) => entry.containerPort);
  }
  if (service.container_port) {
    return [
      {
        containerPort: String(service.container_port),
        nodePort: service.node_port ? String(service.node_port) : undefined
      }
    ];
  }
  return [];
}

export function loadWorkspace(projectRef: string): WorkspaceSpec {
  const { project, backendHint, profileHint } = parseWorkspaceReference(projectRef);
  const resolvedBackendHint = resolveBackendHint(project, backendHint);
  const resolvedProfileHint = resolveProfileHint(project, profileHint);
  const configPath = specCandidates(project, resolvedBackendHint).find((candidate) => fs.existsSync(candidate));
  if (!configPath) {
    throw new Error(`Config not found for project '${project}'`);
  }

  const data = (yaml.load(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<string, any>;
  const backend = (data.backend ?? {}) as Record<string, unknown>;
  const runtime = (data.runtime ?? {}) as Record<string, unknown>;
  const resources = (data.resources ?? {}) as Record<string, unknown>;
  const agent = (data.agent ?? {}) as Record<string, unknown>;
  const tooling = (data.tooling ?? {}) as Record<string, unknown>;
  const auth = (data.auth ?? {}) as Record<string, unknown>;
  const env = (data.env ?? {}) as Record<string, unknown>;
  const service = (data.service ?? {}) as Record<string, unknown>;

  const projectName = String(data.project ?? project);
  const profile = resolveWorkspaceProfile(data.profile, projectName);
  const runtimeUser = String(runtime.user ?? "");
  const toolingGitUserName = tooling.git_user_name ? String(tooling.git_user_name) : undefined;
  const toolingGitUserEmail = tooling.git_user_email ? String(tooling.git_user_email) : undefined;
  const mergedRuntimeUser = runtimeUser || profile.defaults.runtime?.user || projectName;
  const home = canonicalHome(mergedRuntimeUser, projectName);
  const userProfile = resolveUserProfile(data.user_profile, {
    runtimeUser: mergedRuntimeUser,
    gitUserName: toolingGitUserName,
    gitUserEmail: toolingGitUserEmail,
  });
  const backendKind = String(backend.kind ?? "pod") as WorkspaceSpec["backend"]["kind"];
  const podProfileDefaults = backendKind === "pod" && resolvedProfileHint
    ? loadPodProfileDefaults(resolvedProfileHint)
    : {};
  const workspaceAuthFiles = normalizeAuthFiles(auth.files, path.dirname(configPath));
  const agentKind = normalizeAgentKind(agent.kind);
  const plainEnvVars = normalizePlainEnv((env.plain ?? {}) as Record<string, unknown>);
  const persistState = Boolean(agent.persist_state ?? true);
  const claimName = String(runtime.storage_claim_name ?? `${projectName}-project`);
  const directAttachmentConfig = normalizeDirectAttachmentConfig(data.attachments);
  const attachments = directAttachmentConfig
    ? buildWorkspaceAttachmentsFromDirectConfig(directAttachmentConfig)
    : translateLegacyAttachments({
        projectName,
        home,
      persistState,
      claimName,
      authFiles: mergeAuthFiles(workspaceAuthFiles, userProfile.authFiles),
      backendKind,
    });
  const authFiles = mergeAuthFiles(workspaceAuthFiles, userProfile.authFiles);
  const agentContract = buildAgentContract(home, agentKind);

  const workspace: WorkspaceSpec = {
    identity: { projectName },
    profile,
    userProfile,
    backend: {
      kind: backendKind,
      profile: backendKind === "pod"
        ? String(podProfileDefaults.backendProfile ?? resolvedProfileHint ?? runtime.class ?? "kata-qemu")
        : backendKind === "docker" ? "legacy" : "vm",
      specFiles: Array.isArray(backend.spec_files) ? backend.spec_files.map((item) => String(item)) : [],
      dockerRuntimeMode: runtime.docker_enabled ? "legacy" : "disabled"
    },
    storage: {
      persistState,
      claimName,
      durablePaths: [
        ...attachments.workspaceData.durablePaths,
        ...attachments.workspaceRuntimeState.durablePaths,
        ...attachments.userIdentityState.durablePaths,
        ...attachments.userSshState.durablePaths,
      ]
    },
    attachments,
    resources: {
      cpu: String(resources.cpu ?? "2"),
      memory: String(resources.memory ?? "4Gi"),
      ephemeralStorage: String(resources.ephemeral_storage ?? "20Gi"),
      cpuRequest: resources.cpu_request ? String(resources.cpu_request) : undefined,
      memoryRequest: resources.memory_request ? String(resources.memory_request) : undefined,
      storageRequest: resources.ephemeral_storage_request ? String(resources.ephemeral_storage_request) : undefined,
      unbounded: Boolean(resources.unbounded ?? false)
    },
    runtime: {
      baseImage: String(runtime.base_image ?? profile.defaults.runtime?.baseImage ?? "debian:trixie-slim"),
      user: mergedRuntimeUser,
      home,
      privileged: Boolean(runtime.privileged ?? false),
      agentLabel: String(agent.label ?? "None"),
      agentCmd: agentKind,
      agentArgs: Array.isArray(agent.args) ? agent.args.map((item) => String(item)) : [],
      bootstrapProfile: String(tooling.bootstrap_profile ?? profile.defaults.runtime?.bootstrapProfile ?? "full"),
      aptPackages: Array.isArray(tooling.apt_packages) ? tooling.apt_packages.map((item) => String(item)) : [],
      installRustup: Boolean(tooling.install_rustup ?? false),
      gitCoreEditor: tooling.git_core_editor ? String(tooling.git_core_editor) : undefined,
      gitUserName: userProfile.name,
      gitUserEmail: userProfile.email,
      plainEnvVars,
      authFiles
    },
    agent: agentContract,
    connectivity: {
      exposeService: Boolean(service.enabled ?? false),
      serviceMode: String(service.mode ?? "nodeport") === "ingress" ? "ingress" : "nodeport",
      servicePorts: normalizeServicePorts(service),
      serviceHost: service.host ? String(service.host) : undefined,
      servicePath: String(service.path ?? profile.defaults.service?.path ?? "/")
    },
    lifecycle: {
      actions: ["create", "start", "stop", "restart", "rebuild", "status", "reconcile", "render", "apply"]
    },
    runtimeContract: {
      minimalInvariants: [
        `runtime home SHALL resolve to ${home}`,
        `${agentContract.runtime.stateRoot} SHALL assemble from workspace-runtime-state`,
        `${agentContract.runtime.evolutionRoot} SHALL assemble from workspace-runtime-state`,
        `${home}/.codex and ${home}/.claude SHALL assemble from user-identity-state`,
        `${home}/.ssh SHALL assemble from user-ssh-state with strict key permissions`,
      ],
      staleRuntimeArtifacts: [...agentContract.runtime.staleRuntimeArtifacts, ...attachments.ephemeralRuntime.staleArtifacts],
    },
    health: {
      readinessMode: backendKind === "pod" && String(runtime.class ?? "") === "gvisor" && agentContract.capabilities.requiresDaemon ? "daemon-port" : "ready-file",
      requiresDaemon: agentContract.capabilities.requiresDaemon
    }
  };

  validateWorkspace(workspace);
  return workspace;
}
