import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { loadWorkspaceFromConfigPath } from "../config/load.js";
import {
  MANAGED_HARNESSES,
  PRESET_SOURCE_COMMIT,
  providerPresetsForHarness,
  supportsLiveCredentialSwitch,
  type HarnessProviderPresetSummary,
} from "../config/credential-catalog.js";
import { buildStatusAssets } from "./status-assets.js";
import {
  normalizePairingUrl,
} from "./pairing-url.js";
import {
  normalizeWorkspaceStatus,
  workspaceStateDir,
  workspaceStatusPath,
} from "../output/state-store.js";
import type { Credential, ServicePort, WorkspaceStatus } from "./workspace.js";
import { polarisUsersRoot, repoRoot } from "../utils/paths.js";

const REPO_ROOT = repoRoot(import.meta.url);
const USER_ROOT = polarisUsersRoot(import.meta.url);
const USER_PROFILES_DIR = path.join(USER_ROOT, "profiles");

export type PortalBackendKind = "docker" | "pod" | "kubevirt-vm";
export type PortalPodProfile = "gvisor" | "data-container";

export interface PortalDriverTarget {
  backend: PortalBackendKind;
  profile?: string;
}

export interface PortalProfileSummary {
  id: string;
  name: string;
  email: string;
  workspaces: string[];
}

export interface PortalProfileDetail extends PortalProfileSummary {
  githubAccount?: string;
  sshMode?: string;
  sshComment?: string;
  referredByCode?: string;
  aiAccessReferralAppliedAt?: string;
}

export interface PortalCredentialSummary {
  id: string;
  kind: Credential["kind"];
  label: string;
  purposes: string[];
  status: string;
  paths: string[];
  harness?: string;
  providerName?: string;
  baseUrl?: string;
  active: boolean;
  liveSwitchSupported: boolean;
  presetId?: string;
}

export interface PortalCredentialCatalog {
  harnesses: Array<{
    id: string;
    supportsCreate: boolean;
    supportsLiveSwitch: boolean;
  }>;
  presetsByHarness: Record<string, HarnessProviderPresetSummary[]>;
  presetSourceCommit: string;
}

export interface PortalCredentialMaterialFile {
  key: string;
  sourcePath: string;
  mountPath?: string;
  content: string;
}

export interface PortalCredentialRecord {
  credential: PortalCredentialSummary;
  files: PortalCredentialMaterialFile[];
}

export interface PortalSkillSummary {
  id: string;
  userId: string;
  harness: "codex" | "claude";
  packageName: string;
  args: string[];
  command: string[];
  label: string;
  source?: string;
  selectedSkillName: string;
  registryPath: string;
  createdAt?: string;
}

export interface PortalWorkspaceAssetPreview {
  path: string;
  content: string;
  truncated: boolean;
}

export interface PortalWorkspaceStaticSummary {
  name: string;
  availableDrivers: Array<PortalDriverTarget & { available: boolean }>;
}

export interface PortalWorkspaceLiveStatus {
  schemaVersion?: WorkspaceStatus["schemaVersion"];
  driver?: WorkspaceStatus["driver"];
  paseo: WorkspaceStatus["paseo"];
  credentials?: Pick<NonNullable<WorkspaceStatus["credentials"]>, "live">;
  evolution?: WorkspaceStatus["evolution"];
}

export interface PortalWorkspaceLiveSummary {
  name: string;
  status: PortalWorkspaceLiveStatus | null;
}

export interface PortalWorkspaceSummary {
  name: string;
  /** Surface capabilities read from the workspace's selected runtime spec. */
  surfaces: string[];
  /** Published ports needed by outer shell surfaces. */
  ports: ServicePort[];
  /** Available once the in-container Paseo daemon finishes pairing. */
  serverId: string | null;
  drivers: PortalDriverTarget[];
  status: WorkspaceStatus | null;
}

export interface PortalWorkspaceDetailStatic {
  name: string;
  availableDrivers: Array<PortalDriverTarget & { available: boolean }>;
  credentialBindings: Array<{
    purpose: string;
    credentialId: string;
    required: boolean;
  }>;
  assets?: WorkspaceStatus["assets"];
  attachments?: WorkspaceStatus["attachments"];
  workspaceAssembly?: WorkspaceStatus["workspaceAssembly"];
}

export interface PortalWorkspaceDetail extends PortalWorkspaceSummary {
  resolvedWorkspace: WorkspaceStatus | null;
  availableDrivers: Array<PortalDriverTarget & { available: boolean }>;
  credentialBindings: Array<{
    purpose: string;
    credentialId: string;
    required: boolean;
  }>;
}

export interface PortalWorkspaceAgentBindingResult {
  enabled: boolean;
  driver: string;
  restarted: boolean;
  credentialBindings: Array<{
    purpose: string;
    credentialId: string;
    required: boolean;
  }>;
}

export interface PortalWorkspacePaseoDiagnostic {
  daemonStatusRaw: string;
  daemonStatus: {
    serverId: string;
    localDaemon: string;
    connectedDaemon: string;
  } | null;
}

export type PortalWorkspaceStreamEvent =
  | {
    type: "snapshot";
    staticWorkspaces: PortalWorkspaceStaticSummary[];
    liveWorkspaces: PortalWorkspaceLiveSummary[];
  }
  | {
    type: "static-upsert";
    workspace: PortalWorkspaceStaticSummary;
  }
  | {
    type: "static-remove";
    workspace: string;
  }
  | {
    type: "live-upsert";
    workspace: PortalWorkspaceLiveSummary;
  }
  | {
    type: "live-remove";
    workspace: string;
  }
  | {
    type: "heartbeat";
    ts: number;
  };

export const PORTAL_DRIVER_TARGETS: PortalDriverTarget[] = [
  { backend: "docker" },
  { backend: "pod", profile: "gvisor" },
  { backend: "pod", profile: "data-container" },
  { backend: "kubevirt-vm" },
];

function userWorkspacesRoot(userId: string): string {
  return path.join(USER_ROOT, userId, "workspaces");
}

function workspaceRoot(userId: string, workspace: string): string {
  return path.join(userWorkspacesRoot(userId), workspace);
}

function workspacePaseoStateRoot(userId: string, workspace: string): string {
  return path.join(workspaceStateDir(workspace, userId), "paseo");
}

function workspaceProvisionProgressPath(userId: string, workspace: string): string {
  return path.join(workspaceRoot(userId, workspace), "state", "provision.json");
}

function readPersistedPaseoServerId(userId: string, workspace: string): string | null {
  const filePath = path.join(workspacePaseoStateRoot(userId, workspace), "server-id");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }
  const value = fs.readFileSync(filePath, "utf8").trim();
  return value || null;
}

function readPersistedPaseoPairingUrl(userId: string, workspace: string): string | null {
  const filePath = path.join(workspacePaseoStateRoot(userId, workspace), "pairing.json");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { url?: unknown };
    const raw = typeof parsed.url === "string" ? parsed.url.trim() : "";
    return normalizePairingUrl(raw, process.env, workspacePaseoScope(userId, workspace)) ?? null;
  } catch {
    return null;
  }
}

function credentialRegistryPath(userId: string, credentialId: string): string {
  return path.join(USER_ROOT, userId, "credentials", `${credentialId}.yaml`);
}

function workspaceBackendFile(target: PortalDriverTarget): string {
  if (target.backend === "pod") {
    return "pod.agent.yaml";
  }
  if (target.backend === "kubevirt-vm") {
    return "kubevirt.agent.yaml";
  }
  return "docker.agent.yaml";
}

function workspaceConfigFilePath(
  userId: string,
  workspace: string,
  target: PortalDriverTarget,
): string {
  return path.join(workspaceRoot(userId, workspace), workspaceBackendFile(target));
}

export function loadPortalWorkspaceByTarget(
  userId: string,
  workspace: string,
  target: PortalDriverTarget,
) {
  const configPath = workspaceConfigFilePath(userId, workspace, target);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Workspace config '${path.relative(REPO_ROOT, configPath)}' was not found`);
  }
  return loadWorkspaceFromConfigPath(
    configPath,
    workspace,
    target.backend,
    target.profile,
  );
}

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readWorkspaceProvisionProgress(
  userId: string,
  workspace: string,
): Record<string, unknown> | null {
  return readJson<Record<string, unknown>>(workspaceProvisionProgressPath(userId, workspace));
}

export function writeWorkspaceProvisionProgress(
  userId: string,
  workspace: string,
  value: Record<string, unknown>,
): void {
  writeJson(workspaceProvisionProgressPath(userId, workspace), value);
}

export function clearWorkspaceProvisionProgress(
  userId: string,
  workspace: string,
): void {
  fs.rmSync(workspaceProvisionProgressPath(userId, workspace), { force: true });
}

function readYAML(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return (yaml.load(fs.readFileSync(filePath, "utf8")) ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeYAML(filePath: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    yaml.dump(value, { lineWidth: 120, noRefs: true }),
    "utf8",
  );
}

function profilePath(userId: string): string {
  return path.join(USER_PROFILES_DIR, `${userId}.yaml`);
}

function parseDriverTarget(backend: string, profile?: string): PortalDriverTarget {
  if (backend === "pod" && profile) {
    return { backend: "pod", profile };
  }
  if (backend === "kubevirt-vm" || backend === "docker") {
    return { backend };
  }
  return { backend: "docker" };
}

export function parsePortalDriverTarget(value: string): PortalDriverTarget {
  const [backend, profile] = value.split(":", 2);
  return parseDriverTarget(backend, profile);
}

export function formatDriverTarget(target: PortalDriverTarget): string {
  return target.backend === "pod" && target.profile
    ? `pod:${target.profile}`
    : target.backend;
}

export function workspaceRefFromTarget(workspace: string, target: PortalDriverTarget): string {
  return target.backend === "pod" && target.profile
    ? `${workspace}@pod:${target.profile}`
    : `${workspace}@${target.backend}`;
}

export function listPortalProfiles(): PortalProfileSummary[] {
  if (!fs.existsSync(USER_PROFILES_DIR)) {
    return [];
  }
  return fs
    .readdirSync(USER_PROFILES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => {
      const id = entry.name.replace(/\.ya?ml$/, "");
      const data = readYAML(path.join(USER_PROFILES_DIR, entry.name)) ?? {};
      return {
        id,
        name: String(data.name ?? ""),
        email: String(data.email ?? ""),
        workspaces: listOwnedWorkspaces(id),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function readPortalProfile(userId: string): PortalProfileDetail | null {
  const data = readYAML(profilePath(userId));
  if (!data) {
    return null;
  }
  return {
    id: userId,
    name: String(data.name ?? ""),
    email: String(data.email ?? ""),
    workspaces: listOwnedWorkspaces(userId),
    githubAccount: typeof data.github === "object" && data.github
      ? String((data.github as Record<string, unknown>).account ?? "") || undefined
      : undefined,
    sshMode: typeof data.ssh === "object" && data.ssh
      ? String((data.ssh as Record<string, unknown>).mode ?? "") || undefined
      : undefined,
    sshComment: typeof data.ssh === "object" && data.ssh
      ? String((data.ssh as Record<string, unknown>).comment ?? "") || undefined
      : undefined,
    referredByCode: typeof data.referral === "object" && data.referral
      ? String((data.referral as Record<string, unknown>).referred_by_code ?? "") || undefined
      : undefined,
    aiAccessReferralAppliedAt: typeof data.referral === "object" && data.referral
      ? String((data.referral as Record<string, unknown>).ai_access_applied_at ?? "") || undefined
      : undefined,
  };
}

export function updatePortalProfile(
  userId: string,
  patch: {
    name?: string;
    email?: string;
    githubAccount?: string;
    sshComment?: string;
  },
): PortalProfileDetail {
  const filePath = profilePath(userId);
  const current = readYAML(filePath);
  if (!current) {
    throw new Error(`User profile '${userId}' was not found`);
  }
  const next = { ...current };
  if (patch.name !== undefined) {
    next.name = patch.name;
  }
  if (patch.email !== undefined) {
    next.email = patch.email;
  }
  const currentGithub = typeof next.github === "object" && next.github
    ? { ...(next.github as Record<string, unknown>) }
    : {};
  if (patch.githubAccount !== undefined) {
    currentGithub.account = patch.githubAccount;
    next.github = currentGithub;
  }
  const currentSsh = typeof next.ssh === "object" && next.ssh
    ? { ...(next.ssh as Record<string, unknown>) }
    : {};
  if (patch.sshComment !== undefined) {
    currentSsh.comment = patch.sshComment;
    next.ssh = currentSsh;
  }
  writeYAML(filePath, next);
  const updated = readPortalProfile(userId);
  if (!updated) {
    throw new Error(`User profile '${userId}' could not be reloaded`);
  }
  return updated;
}

export function resolvePolarisUserIdFromIdentity(params: {
  authingUserId?: string;
  email?: string;
  routeUserId?: string;
}): string | null {
  const profiles = listPortalProfiles();
  const directId = params.routeUserId?.trim();
  if (directId && profiles.some((profile) => profile.id === directId)) {
    return directId;
  }
  const authingUserId = params.authingUserId?.trim();
  if (authingUserId && profiles.some((profile) => profile.id === authingUserId)) {
    return authingUserId;
  }
  const email = params.email?.trim().toLowerCase();
  if (email) {
    const match = profiles.find((profile) => profile.email.toLowerCase() === email);
    if (match) {
      return match.id;
    }
  }
  return null;
}

export function listOwnedWorkspaces(userId: string): string[] {
  const root = userWorkspacesRoot(userId);
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) =>
      PORTAL_DRIVER_TARGETS.some((target) =>
        fs.existsSync(path.join(root, entry.name, workspaceBackendFile(target))),
      ),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export function listWorkspaceDriverTargets(userId: string, workspace: string): Array<PortalDriverTarget & { available: boolean }> {
  const root = workspaceRoot(userId, workspace);
  return PORTAL_DRIVER_TARGETS.map((target) => ({
    ...target,
    available: fs.existsSync(path.join(root, workspaceBackendFile(target))),
  }));
}

export function readWorkspaceStatus(userId: string, workspace: string): WorkspaceStatus | null {
  const status = readJson<WorkspaceStatus>(workspaceStatusPath(workspace, userId));
  return status ? normalizeWorkspaceStatus(status) : null;
}

export function projectPortalWorkspaceLiveStatus(
  status: WorkspaceStatus | null,
): PortalWorkspaceLiveStatus | null {
  if (!status) {
    return null;
  }
  return {
    ...(status.schemaVersion ? { schemaVersion: status.schemaVersion } : {}),
    ...(status.driver ? { driver: status.driver } : {}),
    paseo: status.paseo,
    ...(status.credentials?.live
      ? {
        credentials: {
          live: status.credentials.live,
        },
      }
      : {}),
    ...(status.evolution ? { evolution: status.evolution } : {}),
  };
}

export function readPortalWorkspaceLiveSummary(
  userId: string,
  workspace: string,
): PortalWorkspaceLiveSummary {
  return {
    name: workspace,
    status: projectPortalWorkspaceLiveStatus(readWorkspaceStatus(userId, workspace)),
  };
}

export function listPortalWorkspaceStaticSummaries(
  userId: string,
): PortalWorkspaceStaticSummary[] {
  return listOwnedWorkspaces(userId).map((workspace) => ({
    name: workspace,
    availableDrivers: listWorkspaceDriverTargets(userId, workspace),
  }));
}

export function listPortalWorkspaceLiveSummaries(
  userId: string,
): PortalWorkspaceLiveSummary[] {
  return listOwnedWorkspaces(userId).map((workspace) =>
    readPortalWorkspaceLiveSummary(userId, workspace)
  );
}

function workspacePaseoScope(userId: string, workspace: string): string {
  return `${userId.trim()}:${workspace.trim()}`;
}

function inferPortalCredentialHarness(
  kind: Credential["kind"],
  metadata: Record<string, unknown>,
): string | undefined {
  const explicitHarness = String(metadata.harness ?? "").trim();
  if (MANAGED_HARNESSES.includes(explicitHarness as typeof MANAGED_HARNESSES[number])) {
    return explicitHarness;
  }
  if (kind === "ssh-key") {
    return "ssh";
  }
  if (kind === "codex-auth") {
    return "codex";
  }
  return undefined;
}

export function listPortalCredentials(userId: string): PortalCredentialSummary[] {
  const credentialsRoot = path.join(USER_ROOT, userId, "credentials");
  if (!fs.existsSync(credentialsRoot)) {
    return [];
  }
  return fs
    .readdirSync(credentialsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => {
      const data = readYAML(path.join(credentialsRoot, entry.name)) ?? {};
      const material = data.materialRef as Record<string, unknown> | undefined;
      const metadata = typeof data.metadata === "object" && data.metadata
        ? data.metadata as Record<string, unknown>
        : {};
      const files = Array.isArray(material?.files)
        ? material?.files as Array<Record<string, unknown>>
        : [];
      const paths = files.map((file) => String(file.source_path ?? file.sourcePath ?? file.key ?? "" )).filter(Boolean);
      const status = credentialMaterialStatus(userId, paths, String(data.status ?? "unknown"));
      const kind = String(data.kind ?? "unknown") as Credential["kind"];
      const harness = inferPortalCredentialHarness(kind, metadata);
      return {
        id: String(data.id ?? entry.name.replace(/\.ya?ml$/, "")),
        kind,
        label: String(data.label ?? entry.name),
        purposes: Array.isArray(data.purposes)
          ? data.purposes.map((value) => String(value)).filter(Boolean)
          : [],
        status,
        paths,
        harness,
        providerName: typeof metadata.providerName === "string" ? metadata.providerName : undefined,
        baseUrl: typeof metadata.baseUrl === "string" ? metadata.baseUrl : undefined,
        active: metadata.active === true,
        liveSwitchSupported: metadata.liveSwitchSupported === true
          || (typeof harness === "string" && supportsLiveCredentialSwitch(harness)),
        presetId: typeof metadata.presetId === "string" ? metadata.presetId : undefined,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function credentialCatalog(): PortalCredentialCatalog {
  return {
    harnesses: MANAGED_HARNESSES.map((id) => ({
      id,
      supportsCreate: id !== "ssh",
      supportsLiveSwitch: supportsLiveCredentialSwitch(id),
    })),
    presetsByHarness: Object.fromEntries(
      MANAGED_HARNESSES.map((id) => [id, providerPresetsForHarness(id)]),
    ),
    presetSourceCommit: PRESET_SOURCE_COMMIT,
  };
}

function credentialMaterialStatus(userId: string, paths: string[], declaredStatus: string): string {
  if (paths.length === 0) {
    return declaredStatus;
  }
  const userRoot = path.resolve(USER_ROOT, userId);
  for (const relativePath of paths) {
    const absolute = path.resolve(userRoot, relativePath);
    if (absolute !== userRoot && !absolute.startsWith(`${userRoot}${path.sep}`)) {
      return "error";
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      return "error";
    }
    try {
      const content = fs.readFileSync(absolute, "utf8");
      if (content.includes("placeholder-managed-key")) {
        return "error";
      }
    } catch {
      continue;
    }
  }
  return declaredStatus;
}

function normalizeWorkspaceAssets(
  assets: NonNullable<WorkspaceStatus["assets"]> | undefined,
): NonNullable<WorkspaceStatus["assets"]> | undefined {
  if (!assets) {
    return assets;
  }
  return {
    ...assets,
    dockerfile: {
      ...assets.dockerfile,
      exists: fs.existsSync(path.resolve(REPO_ROOT, assets.dockerfile.path)),
    },
    specs: (assets.specs ?? []).map((item) => ({
      ...item,
      exists: fs.existsSync(path.resolve(REPO_ROOT, item.path)),
    })),
    generatedManifests: (assets.generatedManifests ?? []).map((item) => ({
      ...item,
      exists: fs.existsSync(path.resolve(REPO_ROOT, item.path)),
    })),
  };
}

function augmentWorkspaceStatusAssets(
  userId: string,
  workspace: string,
  status: WorkspaceStatus | null,
): WorkspaceStatus | null {
  if (!status) {
    return null;
  }
  const assets = status.assets as
    | (NonNullable<WorkspaceStatus["assets"]> & { evolutionFiles?: Array<unknown> })
    | undefined;
  let nextStatus = status;
  if (!assets || !Array.isArray(assets.evolutionFiles) || assets.evolutionFiles.length === 0) {
    const preferredTargets = [
      status.driver?.selected ?? null,
      { backend: "docker" as const },
      { backend: "pod" as const, profile: "gvisor" },
      { backend: "kubevirt-vm" as const },
    ].filter(Boolean) as PortalDriverTarget[];
    for (const target of preferredTargets) {
      try {
        const loaded = loadPortalWorkspaceByTarget(userId, workspace, target);
        const nextAssets = buildStatusAssets(loaded);
        nextStatus = {
          ...nextStatus,
          assets: {
            ...(nextStatus.assets ?? {}),
            ...nextAssets,
          },
        };
        break;
      } catch {
        continue;
      }
    }
  }
  if (nextStatus.assets) {
    return {
      ...nextStatus,
      assets: normalizeWorkspaceAssets(nextStatus.assets),
    };
  }
  return nextStatus;
}

export function readPortalWorkspaceAssetPreview(
  userId: string,
  workspace: string,
  assetPath: string,
): PortalWorkspaceAssetPreview {
  const trimmed = assetPath.trim();
  if (!trimmed) {
    throw new Error("workspace asset path is required");
  }
  const userRoot = path.resolve(path.join(USER_ROOT, userId));
  const workspaceDir = path.resolve(workspaceRoot(userId, workspace));
  if (!fs.existsSync(workspaceDir) || !fs.statSync(workspaceDir).isDirectory()) {
    throw new Error(`workspace '${workspace}' not found for user '${userId}'`);
  }
  const absolute = path.resolve(REPO_ROOT, trimmed);
  if (absolute !== userRoot && !absolute.startsWith(`${userRoot}${path.sep}`)) {
    throw new Error("workspace asset path must stay within the user root");
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error("workspace asset not found");
  }
  const raw = fs.readFileSync(absolute);
  if (raw.includes(0)) {
    return {
      path: trimmed,
      content: "[binary content hidden]",
      truncated: false,
    };
  }
  const MAX_PREVIEW_CHARS = 4000;
  const content = raw.toString("utf8");
  return {
    path: trimmed,
    content: content.length > MAX_PREVIEW_CHARS
      ? `${content.slice(0, MAX_PREVIEW_CHARS)}\n…`
      : content,
    truncated: content.length > MAX_PREVIEW_CHARS,
  };
}

export function loadWorkspaceSummary(userId: string, workspace: string): PortalWorkspaceSummary {
  const status = augmentWorkspaceStatusAssets(
    userId,
    workspace,
    readWorkspaceStatus(userId, workspace),
  );
  const runtime = loadPortalWorkspaceRuntimeSurface(userId, workspace, status);
  return {
    name: workspace,
    surfaces: runtime.surfaces,
    ports: runtime.ports,
    serverId: readPersistedPaseoServerId(userId, workspace),
    drivers: PORTAL_DRIVER_TARGETS,
    status,
  };
}

function loadPortalWorkspaceRuntimeSurface(
  userId: string,
  workspace: string,
  status: WorkspaceStatus | null,
): {
  surfaces: string[];
  ports: ServicePort[];
} {
  const targets = [
    status?.driver?.selected ?? null,
    { backend: "docker" as const },
    { backend: "pod" as const, profile: "gvisor" },
    { backend: "kubevirt-vm" as const },
  ].filter(Boolean) as PortalDriverTarget[];
  for (const target of targets) {
    try {
      const loaded = loadPortalWorkspaceByTarget(userId, workspace, target);
      const ports = loaded.connectivity.servicePorts;
      return {
        surfaces: ports.some((port) =>
          port.name?.toLowerCase() === "wanghai" || port.containerPort === "9090"
        )
          ? ["paseo", "wanghai"]
          : ["paseo"],
        ports,
      };
    } catch {
      continue;
    }
  }
  return {
    surfaces: [],
    ports: [],
  };
}

export function loadWorkspaceDetailStatic(
  userId: string,
  workspace: string,
): PortalWorkspaceDetailStatic {
  const liveSummary = readPortalWorkspaceLiveSummary(userId, workspace);
  const statusWithAssets = augmentWorkspaceStatusAssets(
    userId,
    workspace,
    readWorkspaceStatus(userId, workspace),
  );
  let bindings: PortalWorkspaceDetailStatic["credentialBindings"] = [];
  const preferredTargets = [
    liveSummary.status?.driver?.selected ?? null,
    { backend: "docker" as const },
    { backend: "pod" as const, profile: "gvisor" },
    { backend: "kubevirt-vm" as const },
  ].filter(Boolean) as PortalDriverTarget[];
  for (const target of preferredTargets) {
    try {
      const loaded = loadPortalWorkspaceByTarget(userId, workspace, target);
      bindings = loaded.resolvedCredentialBindings.map((binding) => ({
        purpose: binding.purpose,
        credentialId: binding.credentialId,
        required: binding.required,
      }));
      break;
    } catch {
      continue;
    }
  }
  return {
    name: workspace,
    availableDrivers: listWorkspaceDriverTargets(userId, workspace),
    credentialBindings: bindings,
    ...(statusWithAssets?.assets ? { assets: statusWithAssets.assets } : {}),
    ...(statusWithAssets?.attachments ? { attachments: statusWithAssets.attachments } : {}),
    ...(statusWithAssets?.workspaceAssembly
      ? { workspaceAssembly: statusWithAssets.workspaceAssembly }
      : {}),
  };
}

export function loadWorkspaceDetail(userId: string, workspace: string): PortalWorkspaceDetail {
  const summary = loadWorkspaceSummary(userId, workspace);
  const staticDetail = loadWorkspaceDetailStatic(userId, workspace);
  return {
    ...summary,
    resolvedWorkspace: summary.status,
    availableDrivers: staticDetail.availableDrivers,
    credentialBindings: staticDetail.credentialBindings,
  };
}

export function updatePortalWorkspaceAgentBinding(input: {
  userId: string;
  workspace: string;
  target: PortalDriverTarget;
  credentialId?: string;
  enabled: boolean;
}): {
  configPath: string;
  credentialBindings: Array<{
    purpose: string;
    credentialId: string;
    required: boolean;
  }>;
} {
  const configPath = workspaceConfigFilePath(input.userId, input.workspace, input.target);
  const current = readYAML(configPath);
  if (!current) {
    throw new Error(`Workspace config '${path.relative(REPO_ROOT, configPath)}' was not found`);
  }

  const rawCredentials = typeof current.credentials === "object" && current.credentials
    ? { ...(current.credentials as Record<string, unknown>) }
    : {};
  const rawBindings = Array.isArray(rawCredentials.bindings)
    ? rawCredentials.bindings as Array<Record<string, unknown>>
    : [];
  const preservedBindings = rawBindings
    .map((binding) => ({
      purpose: String(binding.purpose ?? "").trim(),
      credentialId: String(binding.credentialId ?? "").trim(),
      required: binding.required !== false,
    }))
    .filter((binding) => binding.purpose && binding.credentialId && binding.purpose !== "agent-auth");

  const credentialBindings = input.enabled
    ? [
        {
          purpose: "agent-auth",
          credentialId: requirePortalAgentCredential(input.userId, input.credentialId),
          required: true,
        },
        ...preservedBindings,
      ]
    : preservedBindings;

  const next = {
    ...current,
    credentials: {
      ...rawCredentials,
      bindings: credentialBindings,
    },
  };
  writeYAML(configPath, next);

  return {
    configPath,
    credentialBindings,
  };
}

function requirePortalAgentCredential(userId: string, credentialId?: string): string {
  const trimmedCredentialId = String(credentialId ?? "").trim();
  if (!trimmedCredentialId) {
    throw new Error("credentialId is required");
  }
  const registry = readYAML(credentialRegistryPath(userId, trimmedCredentialId));
  if (!registry) {
    throw new Error(`Credential '${trimmedCredentialId}' was not found for user '${userId}'`);
  }
  const purposes = Array.isArray(registry.purposes)
    ? registry.purposes.map((value) => String(value))
    : [];
  if (!purposes.includes("agent-auth")) {
    throw new Error(`Credential '${trimmedCredentialId}' is not an agent-auth credential`);
  }
  return trimmedCredentialId;
}
