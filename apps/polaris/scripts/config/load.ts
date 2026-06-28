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
  Credential,
  CredentialKind,
  WorkspaceCredentialBinding,
  ResolvedWorkspaceCredentialBinding,
} from "../core/workspace.js";
import { validateWorkspace } from "../core/capabilities.js";
import { workspaceHarnessIds } from "../core/harness-catalog.js";
import {
  defaultMountPathForCredentialFile,
  userIdentityDurablePaths,
} from "../core/identity-layout.js";
import { readWorkspaceDriverSelection } from "../output/state-store.js";
import { assertNoProjectNameCollision } from "./project-ownership.js";
import { polarisUsersRoot, repoRoot } from "../utils/paths.js";

const REPO_ROOT = repoRoot(import.meta.url);
const USER_SECRETS_ROOT = polarisUsersRoot(import.meta.url);

const BUILTIN_PROFILES: Record<string, WorkspaceProfile> = {
  morpheus: {
    name: "morpheus",
    assetBaseName: "morpheus",
    workspaceAlias: "Morpheus",
    defaults: {
      runtime: {
        baseImage: "ttl.sh/polaris-demo-debian13-1782126452:24h",
        bootstrapProfile: "prebuilt",
        user: "root",
      },
      service: {
        path: "/",
      },
    },
  },
};

const USER_PROFILES_DIR = path.join(USER_SECRETS_ROOT, "profiles");
const POD_PROFILE_SPECS_DIR = path.join(REPO_ROOT, "config", "pod", "profiles");
const SUPPORTED_CREDENTIAL_KINDS = new Set<CredentialKind>([
  "ssh-key",
  "api-key",
  "codex-auth",
  "git-https-token",
  "kubeconfig",
  "cloud-token",
]);

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
  const userScopedSpecs = (
    backendKind: WorkspaceSpec["backend"]["kind"] | "kubevirt",
  ): string[] => {
    const backendFile =
      backendKind === "kubevirt-vm" || backendKind === "kubevirt"
        ? "kubevirt.agent.yaml"
        : `${backendKind}.agent.yaml`;
    if (!fs.existsSync(USER_SECRETS_ROOT)) {
      return [];
    }
    return fs
      .readdirSync(USER_SECRETS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(USER_SECRETS_ROOT, entry.name, "workspaces", project, backendFile));
  };
  const preferredBackend =
    backendHint === "kubevirt-vm"
      ? "kubevirt"
      : backendHint;
  const orderedSpecs = preferredBackend
    ? userScopedSpecs(preferredBackend)
    : [
        ...userScopedSpecs("pod"),
        ...userScopedSpecs("kubevirt"),
        ...userScopedSpecs("docker"),
      ];
  return Array.from(new Set([
    ...orderedSpecs,
    path.join(REPO_ROOT, "agents", `${project}.agent.yaml`)
  ]));
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

function userCredentialRegistryDir(userProfileId: string): string {
  return path.join(USER_SECRETS_ROOT, userProfileId, "credentials");
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
    workspaces: [],
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

function normalizeCredentialMetadata(
  rawMetadata: unknown,
): Credential["metadata"] {
  if (!rawMetadata || typeof rawMetadata !== "object") {
    return {};
  }
  const metadata: Credential["metadata"] = {};
  for (const [key, value] of Object.entries(rawMetadata as Record<string, unknown>)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      metadata[key] = value;
      continue;
    }
    if (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string")
    ) {
      metadata[key] = value.map((item) => String(item));
    }
  }
  return metadata;
}

function credentialKindAttachmentKind(
  _kind: CredentialKind,
): ResolvedWorkspaceCredentialBinding["attachmentKind"] {
  return "user-identity-state";
}

function mountPathForCredentialFile(
  kind: CredentialKind,
  runtimeHome: string,
  key: string,
): string {
  return defaultMountPathForCredentialFile(kind, runtimeHome, key);
}

function normalizeCredentialMaterialFiles(args: {
  rawFiles: unknown;
  runtimeHome: string;
  baseDir: string;
  kind: CredentialKind;
  credentialId: string;
}): Credential["materialRef"]["files"] {
  const files = Array.isArray(args.rawFiles) ? args.rawFiles : [];
  return files
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    .map((entry) => {
      const key = String(entry.key ?? "");
      const rawSourcePath = String(entry.source_path ?? "");
      if (!key || !rawSourcePath) {
        throw new Error(
          `Credential '${args.credentialId}' must declare file key and source_path`,
        );
      }
      if (entry.content !== undefined && entry.content !== null) {
        throw new Error(
          `Credential '${args.credentialId}' must externalize secret material through materialRef.files.source_path`,
        );
      }
      return {
        key,
        sourcePath: resolveAuthSourcePath(rawSourcePath, args.baseDir),
        mountPath: entry.mount_path
          ? String(entry.mount_path)
          : mountPathForCredentialFile(args.kind, args.runtimeHome, key),
        content: undefined,
      };
    });
}

function normalizeCredentialMaterialRef(args: {
  rawMaterialRef: unknown;
  runtimeHome: string;
  baseDir: string;
  kind: CredentialKind;
  credentialId: string;
}): Credential["materialRef"] {
  if (!args.rawMaterialRef || typeof args.rawMaterialRef !== "object") {
    throw new Error(`Credential '${args.credentialId}' must declare materialRef`);
  }
  const rawMaterialRef = args.rawMaterialRef as Record<string, unknown>;
  const type = String(rawMaterialRef.type ?? "");
  if (type !== "file") {
    throw new Error(
      `Credential '${args.credentialId}' materialRef.type must be 'file'`,
    );
  }
  const key = String(rawMaterialRef.key ?? "").trim();
  if (!key) {
    throw new Error(`Credential '${args.credentialId}' must declare materialRef.key`);
  }
  const files = normalizeCredentialMaterialFiles({
    rawFiles: rawMaterialRef.files,
    runtimeHome: args.runtimeHome,
    baseDir: args.baseDir,
    kind: args.kind,
    credentialId: args.credentialId,
  });
  if (files.length === 0) {
    throw new Error(
      `Credential '${args.credentialId}' must declare at least one materialRef.files entry`,
    );
  }
  return {
    type: "file",
    key,
    files,
  };
}

function loadUserCredentials(
  userProfileId: string,
  runtimeHome: string,
): Credential[] {
  const registryDir = userCredentialRegistryDir(userProfileId);
  const legacyRegistryDir = path.join(USER_SECRETS_ROOT, "credentials", userProfileId);
  const activeRegistryDir = fs.existsSync(registryDir)
    ? registryDir
    : legacyRegistryDir;
  if (!fs.existsSync(activeRegistryDir)) {
    return [];
  }
  return fs
    .readdirSync(activeRegistryDir)
    .filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"))
    .sort()
    .map((entry) => {
      const credentialPath = path.join(activeRegistryDir, entry);
      const data = (yaml.load(fs.readFileSync(credentialPath, "utf8")) ?? {}) as Record<string, unknown>;
      const id = String(data.id ?? "").trim();
      const userId = String(data.userId ?? data.user_id ?? "").trim();
      const kind = String(data.kind ?? "").trim() as CredentialKind;
      const label = String(data.label ?? "").trim();
      const purposes = Array.isArray(data.purposes)
        ? data.purposes.map((item) => String(item)).filter(Boolean)
        : [];
      const status = String(data.status ?? "").trim();
      if (!id || !userId || !kind || !label || !status || purposes.length === 0) {
        throw new Error(
          `Credential registry entry '${path.relative(REPO_ROOT, credentialPath)}' is missing required fields`,
        );
      }
      if (userId !== userProfileId) {
        throw new Error(
          `Credential '${id}' must be owned by user '${userProfileId}', got '${userId}'`,
        );
      }
      if (!SUPPORTED_CREDENTIAL_KINDS.has(kind)) {
        throw new Error(`Credential '${id}' uses unsupported kind '${kind}'`);
      }
      const materialRef = normalizeCredentialMaterialRef({
        rawMaterialRef: data.materialRef ?? data.material_ref,
        runtimeHome,
        baseDir: path.join(USER_SECRETS_ROOT, userProfileId),
        kind,
        credentialId: id,
      });
      return {
        id,
        userId,
        kind,
        label,
        purposes,
        materialRef,
        metadata: normalizeCredentialMetadata(data.metadata),
        status,
      };
    });
}

function credentialFilesToAuthFiles(
  credential: Credential,
): AuthFile[] {
  return credential.materialRef.files.map((file) => ({
    key: file.key,
    mountPath: file.mountPath,
    sourcePath: file.sourcePath,
    content: file.content ?? (fs.existsSync(file.sourcePath)
      ? fs.readFileSync(file.sourcePath, "utf8")
      : undefined),
  }));
}

function normalizeCredentialBindings(
  rawBindings: unknown,
): WorkspaceCredentialBinding[] {
  if (!Array.isArray(rawBindings)) {
    return [];
  }
  return rawBindings
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    .map((entry) => ({
      purpose: String(entry.purpose ?? "").trim(),
      credentialId: String(entry.credentialId ?? entry.credential_id ?? "").trim(),
      required: entry.required === undefined ? true : Boolean(entry.required),
    }))
    .filter((entry) => entry.purpose && entry.credentialId);
}

function buildCompatibilityCredentials(
  userProfile: UserProfile,
): Credential[] {
  if (userProfile.authFiles.length === 0) {
    return [];
  }
  const byKind = new Map<CredentialKind, AuthFile[]>();
  for (const authFile of userProfile.authFiles) {
    const kind = authFile.mountPath.includes("/.ssh/")
      ? "ssh-key"
      : "codex-auth";
    const files = byKind.get(kind) ?? [];
    files.push(authFile);
    byKind.set(kind, files);
  }
  const credentials: Credential[] = [];
  for (const [kind, files] of byKind.entries()) {
    credentials.push({
      id: `legacy-${userProfile.id}-${kind}`,
      userId: userProfile.id,
      kind,
      label: `Legacy ${kind} for ${userProfile.id}`,
      purposes: kind === "ssh-key" ? ["git-auth", "ssh-auth"] : ["agent-auth"],
      materialRef: {
        type: "file",
        key: `legacy/${kind}`,
        files: files.map((file) => ({
          key: file.key,
          sourcePath: file.sourcePath ?? "",
          mountPath: file.mountPath,
          content: file.content,
        })),
      },
      metadata: {
        compatibility: true,
      },
      status: "ready",
    });
  }
  return credentials;
}

function resolveCredentialBindings(args: {
  directBindings: WorkspaceCredentialBinding[];
  registryCredentials: Credential[];
  compatibilityCredentials: Credential[];
}): ResolvedWorkspaceCredentialBinding[] {
  const registryById = new Map(args.registryCredentials.map((credential) => [credential.id, credential]));
  const resolved: ResolvedWorkspaceCredentialBinding[] = [];

  for (const binding of args.directBindings) {
    const credential = registryById.get(binding.credentialId);
    if (!credential) {
      throw new Error(
        `Workspace binding '${binding.purpose}' references unknown credential '${binding.credentialId}'`,
      );
    }
    if (!credential.purposes.includes(binding.purpose)) {
      throw new Error(
        `Credential '${credential.id}' does not support binding purpose '${binding.purpose}'`,
      );
    }
    resolved.push({
      ...binding,
      source: "registry",
      credential,
      attachmentKind: credentialKindAttachmentKind(credential.kind),
      authFiles: credentialFilesToAuthFiles(credential),
    });
  }

  const hasPurpose = (purpose: string): boolean =>
    resolved.some((binding) => binding.purpose === purpose);

  const activeCodexCredential = args.registryCredentials.find((credential) => {
    return credential.kind === "codex-auth" && credential.metadata?.harness === "codex" && credential.metadata?.active === true;
  });
  if (activeCodexCredential && !hasPurpose("agent-auth")) {
    resolved.push({
      purpose: "agent-auth",
      credentialId: activeCodexCredential.id,
      required: true,
      source: "registry",
      credential: activeCodexCredential,
      attachmentKind: credentialKindAttachmentKind(activeCodexCredential.kind),
      authFiles: credentialFilesToAuthFiles(activeCodexCredential),
    });
  }

  const activeGitCredential = args.registryCredentials.find((credential) =>
    credential.purposes.includes("git-auth") && credential.metadata?.active === true,
  );
  const defaultGitCredential = activeGitCredential
    ?? args.registryCredentials.find((credential) =>
      credential.purposes.includes("git-auth"),
    );
  if (defaultGitCredential && !hasPurpose("git-auth")) {
    resolved.push({
      purpose: "git-auth",
      credentialId: defaultGitCredential.id,
      required: false,
      source: "registry",
      credential: defaultGitCredential,
      attachmentKind: credentialKindAttachmentKind(defaultGitCredential.kind),
      authFiles: credentialFilesToAuthFiles(defaultGitCredential),
    });
  }

  for (const credential of args.compatibilityCredentials) {
    const purpose = credential.kind === "ssh-key" ? "git-auth" : "agent-auth";
    if (hasPurpose(purpose)) {
      continue;
    }
    resolved.push({
      purpose,
      credentialId: credential.id,
      required: true,
      source: "compatibility",
      credential,
      attachmentKind: credentialKindAttachmentKind(credential.kind),
      authFiles: credentialFilesToAuthFiles(credential),
    });
  }

  return resolved;
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
      workspaces: Array.isArray(data.workspaces)
        ? data.workspaces.map((item: unknown) => String(item)).filter(Boolean)
        : [],
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
      volumeSize: (entry.source as Record<string, unknown> | undefined)?.volume_size ? String((entry.source as Record<string, unknown>).volume_size) : undefined,
      subPath: (entry.source as Record<string, unknown> | undefined)?.sub_path ? String((entry.source as Record<string, unknown>).sub_path) : undefined,
      server: (entry.source as Record<string, unknown> | undefined)?.server ? String((entry.source as Record<string, unknown>).server) : undefined,
      exportPath: (entry.source as Record<string, unknown> | undefined)?.export_path ? String((entry.source as Record<string, unknown>).export_path) : undefined,
      mountOptions: Array.isArray((entry.source as Record<string, unknown> | undefined)?.mount_options)
        ? ((entry.source as Record<string, unknown>).mount_options as unknown[]).map((item) => String(item))
        : undefined,
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
  const ephemeralRuntime = normalizeDirectEphemeralRuntimeConfig(attachments["ephemeral-runtime"]);
  if (!workspaceData || !workspaceRuntimeState || !userIdentityState || !ephemeralRuntime) {
    return null;
  }
  return {
    "workspace-data": workspaceData,
    "workspace-runtime-state": workspaceRuntimeState,
    "user-identity-state": userIdentityState,
    "ephemeral-runtime": ephemeralRuntime,
  };
}

function buildWorkspaceAttachmentsFromDirectConfig(config: DirectAttachmentConfig): WorkspaceAttachments {
  const identityDurablePaths = Array.from(new Set([
    ...config["user-identity-state"].durablePaths,
    ...userIdentityDurablePaths(config["user-identity-state"].mountRoot),
  ]));
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
      identityDurablePaths,
      config["user-identity-state"].source,
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
  const identityFiles = args.authFiles;

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
      userIdentityDurablePaths("/identity"),
      {
        kind: "secret-material",
        description: identityFiles.length
          ? `user identity material sourced from ${identityFiles.map((file) => file.key).join(", ")}`
          : "user identity material",
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
    return "default";
  }
  return kind;
}

function buildAgentContract(home: string, agentKind: string): WorkspaceAgentContract {
  const enabled = true;
  const stateRoot = `${home}/.paseo`;
  const evolutionRoot = `${stateRoot}/evolution`;
  return {
    enabled,
    managerId: "paseo",
    contractVersion: "v1",
    capabilities: {
      supportsEventStream: true,
      supportsTranscriptReplay: true,
      supportsStructuredArtifacts: true,
      supportsReview: true,
      supportsRetrieval: true,
      supportsCuration: true,
      requiresDaemon: true,
      supportsPairing: true,
    },
    harnesses: workspaceHarnessIds(),
    runtime: {
      stateRoot,
      evolutionRoot,
      daemonAddress: "0.0.0.0:6767",
      readyFile: "/tmp/.ready",
      pairingFile: `${stateRoot}/pairing.json`,
      staleRuntimeArtifacts: [`${stateRoot}/paseo.pid`, "/run/workspace/pids/paseo.pid"],
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

export function resolveWorkspaceConfigPath(projectRef: string): {
  configPath: string;
  project: string;
  backendHint?: WorkspaceSpec["backend"]["kind"];
  profileHint?: string;
} {
  const { project, backendHint, profileHint } = parseWorkspaceReference(projectRef);
  assertNoProjectNameCollision(project);
  const resolvedBackendHint = resolveBackendHint(project, backendHint);
  const resolvedProfileHint = resolveProfileHint(project, profileHint);
  const configPath = specCandidates(project, resolvedBackendHint).find((candidate) => fs.existsSync(candidate));
  if (!configPath) {
    throw new Error(`Config not found for project '${project}'`);
  }
  return {
    project,
    configPath,
    backendHint: resolvedBackendHint,
    profileHint: resolvedProfileHint,
  };
}

export function loadWorkspaceFromConfigPath(
  configPath: string,
  project = "",
  backendHint?: WorkspaceSpec["backend"]["kind"],
  profileHint?: string,
): WorkspaceSpec {
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
  const podProfileDefaults = backendKind === "pod" && profileHint
    ? loadPodProfileDefaults(profileHint)
    : {};
  const workspaceAuthFiles = normalizeAuthFiles(auth.files, path.dirname(configPath));
  const registryCredentials = loadUserCredentials(userProfile.id, home);
  const directCredentialBindings = normalizeCredentialBindings(
    (data.credentials as Record<string, unknown> | undefined)?.bindings,
  );
  const compatibilityUserProfile = {
    ...userProfile,
    authFiles: mergeAuthFiles(workspaceAuthFiles, userProfile.authFiles),
  };
  const compatibilityCredentials = buildCompatibilityCredentials(
    compatibilityUserProfile,
  );
  const resolvedCredentialBindings = resolveCredentialBindings({
    directBindings: directCredentialBindings,
    registryCredentials,
    compatibilityCredentials,
  });
  const boundAuthFiles = mergeAuthFiles(
    resolvedCredentialBindings.flatMap((binding) => binding.authFiles),
    [],
  );
  const agentKind = normalizeAgentKind(agent.kind);
  const plainEnvVars = normalizePlainEnv((env.plain ?? {}) as Record<string, unknown>);
  const persistState = Boolean(agent.persist_state ?? true);
  const claimName = String(runtime.storage_claim_name ?? `${projectName}-project`);
  const directAttachmentConfig = normalizeDirectAttachmentConfig(data.attachments);
  const compatibilityAuthFiles = mergeAuthFiles(workspaceAuthFiles, userProfile.authFiles);
  const runtimeAuthFiles = mergeAuthFiles(boundAuthFiles, compatibilityAuthFiles);
  const attachments = directAttachmentConfig
    ? buildWorkspaceAttachmentsFromDirectConfig(directAttachmentConfig)
    : translateLegacyAttachments({
        projectName,
        home,
      persistState,
      claimName,
      authFiles: runtimeAuthFiles,
      backendKind,
    });
  const agentContract = buildAgentContract(home, agentKind);

  const workspace: WorkspaceSpec = {
    identity: { projectName },
    profile,
    userProfile,
    credentials: registryCredentials,
    credentialBindings: directCredentialBindings,
    resolvedCredentialBindings,
    backend: {
      kind: backendKind,
      profile: backendKind === "pod"
        ? String(podProfileDefaults.backendProfile ?? profileHint ?? runtime.class ?? "kata-qemu")
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
      rootdiskImage: runtime.rootdisk_image ? String(runtime.rootdisk_image) : undefined,
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
      authFiles: runtimeAuthFiles
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
        `${home}/.codex, ${home}/.claude, ${home}/.copilot, ${home}/.pi, and OpenCode runtime state SHALL assemble from user-identity-state`,
        `Codex XDG config/data/state SHALL assemble from user-identity-state`,
        `${home}/.ssh SHALL assemble from user-identity-state with strict key permissions`,
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
