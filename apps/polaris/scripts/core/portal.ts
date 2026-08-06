import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  loadVaultFromConfigPath,
  readUserProfileAuthFiles,
} from "../config/load.js";
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
  normalizeVaultStatus,
  vaultStateDir,
  vaultStatusPath,
} from "../output/state-store.js";
import type { Credential, VaultStatus } from "./vault.js";
import type { AuthFile } from "./vault.js";
import { WANGHAI_PROFILE_ENV_FILE_KEY } from "../config/scaffold.js";
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
  vaults: string[];
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
  readOnly?: boolean;
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

export interface PortalVaultAssetPreview {
  path: string;
  content: string;
  truncated: boolean;
}

export interface PortalVaultStaticSummary {
  name: string;
  availableDrivers: Array<PortalDriverTarget & { available: boolean }>;
}

export interface PortalVaultLiveStatus {
  schemaVersion?: VaultStatus["schemaVersion"];
  driver?: VaultStatus["driver"];
  paseo: VaultStatus["paseo"];
  credentials?: Pick<NonNullable<VaultStatus["credentials"]>, "live">;
  evolution?: VaultStatus["evolution"];
}

export interface PortalVaultLiveSummary {
  name: string;
  status: PortalVaultLiveStatus | null;
}

export interface PortalVaultSummary {
  name: string;
  /** Surface capabilities read from the vault's selected runtime spec. */
  surfaces: string[];
  /** Available once the in-container Paseo daemon finishes pairing. */
  serverId: string | null;
  /** Stable opaque route identity for the private Wanghai gateway. */
  wanghaiId: string | null;
  drivers: PortalDriverTarget[];
  status: VaultStatus | null;
}

export interface PortalVaultDetailStatic {
  name: string;
  availableDrivers: Array<PortalDriverTarget & { available: boolean }>;
  credentialBindings: Array<{
    purpose: string;
    credentialId: string;
    required: boolean;
  }>;
  assets?: VaultStatus["assets"];
  attachments?: VaultStatus["attachments"];
  vaultAssembly?: VaultStatus["vaultAssembly"];
}

export interface PortalVaultDetail extends PortalVaultSummary {
  resolvedVault: VaultStatus | null;
  availableDrivers: Array<PortalDriverTarget & { available: boolean }>;
  credentialBindings: Array<{
    purpose: string;
    credentialId: string;
    required: boolean;
  }>;
}

export interface PortalVaultAgentBindingResult {
  enabled: boolean;
  driver: string;
  restarted: boolean;
  credentialBindings: Array<{
    purpose: string;
    credentialId: string;
    required: boolean;
  }>;
}

export interface PortalVaultPaseoDiagnostic {
  daemonStatusRaw: string;
  daemonStatus: {
    serverId: string;
    localDaemon: string;
    connectedDaemon: string;
  } | null;
}

export type PortalVaultStreamEvent =
  | {
    type: "snapshot";
    staticVaults: PortalVaultStaticSummary[];
    liveVaults: PortalVaultLiveSummary[];
  }
  | {
    type: "static-upsert";
    vault: PortalVaultStaticSummary;
  }
  | {
    type: "static-remove";
    vault: string;
  }
  | {
    type: "live-upsert";
    vault: PortalVaultLiveSummary;
  }
  | {
    type: "live-remove";
    vault: string;
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

function userVaultsRoot(userId: string): string {
  return path.join(USER_ROOT, userId, "vaults");
}

function vaultRoot(userId: string, vault: string): string {
  return path.join(userVaultsRoot(userId), vault);
}

function vaultPaseoStateRoot(userId: string, vault: string): string {
  return path.join(vaultStateDir(vault, userId), "paseo");
}

function vaultProvisionProgressPath(userId: string, vault: string): string {
  return path.join(vaultRoot(userId, vault), "state", "provision.json");
}

function readPersistedPaseoServerId(userId: string, vault: string): string | null {
  const filePath = path.join(vaultPaseoStateRoot(userId, vault), "server-id");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }
  const value = fs.readFileSync(filePath, "utf8").trim();
  return value || null;
}

function readPersistedPaseoPairingUrl(userId: string, vault: string): string | null {
  const filePath = path.join(vaultPaseoStateRoot(userId, vault), "pairing.json");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { url?: unknown };
    const raw = typeof parsed.url === "string" ? parsed.url.trim() : "";
    return normalizePairingUrl(raw, process.env, vaultPaseoScope(userId, vault)) ?? null;
  } catch {
    return null;
  }
}

function credentialRegistryPath(userId: string, credentialId: string): string {
  return path.join(USER_ROOT, userId, "credentials", `${credentialId}.yaml`);
}

function vaultBackendFile(target: PortalDriverTarget): string {
  if (target.backend === "pod") {
    return "pod.agent.yaml";
  }
  if (target.backend === "kubevirt-vm") {
    return "kubevirt.agent.yaml";
  }
  return "docker.agent.yaml";
}

function vaultConfigFilePath(
  userId: string,
  vault: string,
  target: PortalDriverTarget,
): string {
  return path.join(vaultRoot(userId, vault), vaultBackendFile(target));
}

export function loadPortalVaultByTarget(
  userId: string,
  vault: string,
  target: PortalDriverTarget,
) {
  const configPath = vaultConfigFilePath(userId, vault, target);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Vault config '${path.relative(REPO_ROOT, configPath)}' was not found`);
  }
  return loadVaultFromConfigPath(
    configPath,
    vault,
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

export function readVaultProvisionProgress(
  userId: string,
  vault: string,
): Record<string, unknown> | null {
  return readJson<Record<string, unknown>>(vaultProvisionProgressPath(userId, vault));
}

export function writeVaultProvisionProgress(
  userId: string,
  vault: string,
  value: Record<string, unknown>,
): void {
  writeJson(vaultProvisionProgressPath(userId, vault), value);
}

export function clearVaultProvisionProgress(
  userId: string,
  vault: string,
): void {
  fs.rmSync(vaultProvisionProgressPath(userId, vault), { force: true });
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

export function vaultRefFromTarget(vault: string, target: PortalDriverTarget): string {
  return target.backend === "pod" && target.profile
    ? `${vault}@pod:${target.profile}`
    : `${vault}@${target.backend}`;
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
        vaults: listOwnedVaults(id),
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
    vaults: listOwnedVaults(userId),
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

export function listOwnedVaults(userId: string): string[] {
  const root = userVaultsRoot(userId);
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) =>
      PORTAL_DRIVER_TARGETS.some((target) =>
        fs.existsSync(path.join(root, entry.name, vaultBackendFile(target))),
      ),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Resolve the opaque gateway ID without loading every vault's status and YAML.
 * The caller still must validate the selected runtime and Wanghai surface.
 */
export function findOwnedVaultByWanghaiGatewayId(
  userId: string,
  requestedWanghaiId: string,
): string | null {
  const tenantId = userId.trim();
  const gatewayId = requestedWanghaiId.trim();
  const root = userVaultsRoot(tenantId);
  if (!tenantId || !gatewayId || !fs.existsSync(root)) {
    return null;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || wanghaiGatewayId(tenantId, entry.name) !== gatewayId) {
      continue;
    }
    const ownsVaultConfig = PORTAL_DRIVER_TARGETS.some((target) => (
      fs.existsSync(path.join(root, entry.name, vaultBackendFile(target)))
    ));
    return ownsVaultConfig ? entry.name : null;
  }
  return null;
}

export function listVaultDriverTargets(userId: string, vault: string): Array<PortalDriverTarget & { available: boolean }> {
  const root = vaultRoot(userId, vault);
  return PORTAL_DRIVER_TARGETS.map((target) => ({
    ...target,
    available: fs.existsSync(path.join(root, vaultBackendFile(target))),
  }));
}

export function readVaultStatus(userId: string, vault: string): VaultStatus | null {
  const status = readJson<VaultStatus>(vaultStatusPath(vault, userId));
  return status ? normalizeVaultStatus(status) : null;
}

export function projectPortalVaultLiveStatus(
  status: VaultStatus | null,
): PortalVaultLiveStatus | null {
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

export function readPortalVaultLiveSummary(
  userId: string,
  vault: string,
): PortalVaultLiveSummary {
  return {
    name: vault,
    status: projectPortalVaultLiveStatus(readVaultStatus(userId, vault)),
  };
}

export function listPortalVaultStaticSummaries(
  userId: string,
): PortalVaultStaticSummary[] {
  return listOwnedVaults(userId).map((vault) => ({
    name: vault,
    availableDrivers: listVaultDriverTargets(userId, vault),
  }));
}

export function listPortalVaultLiveSummaries(
  userId: string,
): PortalVaultLiveSummary[] {
  return listOwnedVaults(userId).map((vault) =>
    readPortalVaultLiveSummary(userId, vault)
  );
}

function vaultPaseoScope(userId: string, vault: string): string {
  return `${userId.trim()}:${vault.trim()}`;
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

const PROFILE_AUTH_CREDENTIAL_ID_PREFIX = "profile-auth:";

function profileAuthCredentialId(file: AuthFile): string {
  return `${PROFILE_AUTH_CREDENTIAL_ID_PREFIX}${file.key}`;
}

function portalRelativeUserPath(userId: string, filePath: string | undefined): string {
  const normalized = String(filePath ?? "").trim();
  if (!normalized) {
    return "";
  }
  const userRoot = path.resolve(USER_ROOT, userId);
  const absolute = path.resolve(normalized);
  if (absolute === userRoot || absolute.startsWith(`${userRoot}${path.sep}`)) {
    return path.relative(userRoot, absolute).replace(/\\/g, "/");
  }
  return normalized.replace(/\\/g, "/");
}

function inferPortalProfileAuthKind(file: AuthFile): Credential["kind"] {
  if (file.mountPath.includes("/.ssh/")) {
    return "ssh-key";
  }
  if (file.mountPath.includes("/.codex/") || file.key === "codex-auth.json") {
    return "codex-auth";
  }
  if (file.key.endsWith(".json")) {
    return "api-key";
  }
  return "cloud-token";
}

function portalProfileAuthLabel(file: AuthFile): string {
  if (file.key === WANGHAI_PROFILE_ENV_FILE_KEY) {
    return "Wanghai .env";
  }
  return file.key;
}

function summarizePortalProfileAuthFile(
  userId: string,
  file: AuthFile,
): PortalCredentialSummary {
  const kind = inferPortalProfileAuthKind(file);
  const harness = inferPortalCredentialHarness(kind, {});
  const sourcePath = portalRelativeUserPath(userId, file.sourcePath);
  const paths = [sourcePath || file.mountPath].filter(Boolean);
  return {
    id: profileAuthCredentialId(file),
    kind,
    label: portalProfileAuthLabel(file),
    purposes: ["profile-auth-file"],
    status: file.content !== undefined ? "ready" : "error",
    paths,
    harness,
    active: false,
    liveSwitchSupported: false,
    readOnly: true,
  };
}

function listPortalProfileAuthCredentials(userId: string): PortalCredentialSummary[] {
  return readUserProfileAuthFiles(userId).map((file) => summarizePortalProfileAuthFile(userId, file));
}

export function readPortalProfileAuthCredentialRecord(
  userId: string,
  credentialId: string,
): PortalCredentialRecord | null {
  const file = readUserProfileAuthFiles(userId).find((entry) => profileAuthCredentialId(entry) === credentialId);
  if (!file) {
    return null;
  }
  return {
    credential: summarizePortalProfileAuthFile(userId, file),
    files: [{
      key: file.key,
      sourcePath: portalRelativeUserPath(userId, file.sourcePath) || file.mountPath,
      mountPath: file.mountPath,
      content: file.content ?? "",
    }],
  };
}

export function listPortalCredentials(userId: string): PortalCredentialSummary[] {
  const credentialsRoot = path.join(USER_ROOT, userId, "credentials");
  const managed = !fs.existsSync(credentialsRoot)
    ? []
    : fs
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
      });
  return [...managed, ...listPortalProfileAuthCredentials(userId)]
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

function normalizeVaultAssets(
  assets: NonNullable<VaultStatus["assets"]> | undefined,
): NonNullable<VaultStatus["assets"]> | undefined {
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

function augmentVaultStatusAssets(
  userId: string,
  vault: string,
  status: VaultStatus | null,
): VaultStatus | null {
  if (!status) {
    return null;
  }
  const assets = status.assets as
    | (NonNullable<VaultStatus["assets"]> & { evolutionFiles?: Array<unknown> })
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
        const loaded = loadPortalVaultByTarget(userId, vault, target);
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
      assets: normalizeVaultAssets(nextStatus.assets),
    };
  }
  return nextStatus;
}

export function readPortalVaultAssetPreview(
  userId: string,
  vault: string,
  assetPath: string,
): PortalVaultAssetPreview {
  const trimmed = assetPath.trim();
  if (!trimmed) {
    throw new Error("vault asset path is required");
  }
  const userRoot = path.resolve(path.join(USER_ROOT, userId));
  const vaultDir = path.resolve(vaultRoot(userId, vault));
  if (!fs.existsSync(vaultDir) || !fs.statSync(vaultDir).isDirectory()) {
    throw new Error(`vault '${vault}' not found for user '${userId}'`);
  }
  const absolute = path.resolve(REPO_ROOT, trimmed);
  if (absolute !== userRoot && !absolute.startsWith(`${userRoot}${path.sep}`)) {
    throw new Error("vault asset path must stay within the user root");
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error("vault asset not found");
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

function portalVaultSummary(
  userId: string,
  vault: string,
  status: VaultStatus | null,
): PortalVaultSummary {
  const runtime = loadPortalVaultRuntimeSurface(userId, vault, status);
  return {
    name: vault,
    surfaces: runtime.surfaces,
    serverId: runtime.paseoEnabled ? readPersistedPaseoServerId(userId, vault) : null,
    wanghaiId: runtime.surfaces.includes("wanghai")
      ? wanghaiGatewayId(userId, vault)
      : null,
    drivers: PORTAL_DRIVER_TARGETS,
    status,
  };
}

/**
 * Host-list responses need current runtime state, but static asset discovery
 * belongs to the selected vault detail. Avoid rebuilding it for every vault.
 */
export function loadVaultListSummary(userId: string, vault: string): PortalVaultSummary {
  return portalVaultSummary(userId, vault, readVaultStatus(userId, vault));
}

export function loadVaultSummary(userId: string, vault: string): PortalVaultSummary {
  return portalVaultSummary(
    userId,
    vault,
    augmentVaultStatusAssets(userId, vault, readVaultStatus(userId, vault)),
  );
}

/**
 * Wanghai must not depend on a Paseo relay identifier. The route remains
 * tenant-scoped because every gateway request resolves this value against the
 * current Polaris user's vault summaries before it is proxied.
 */
export function wanghaiGatewayId(userId: string, vault: string): string {
  const tenantId = userId.trim();
  const vaultId = vault.trim();
  if (!tenantId || !vaultId) {
    throw new Error("Wanghai gateway IDs require a tenant and vault");
  }
  const digest = createHash("sha256")
    .update(tenantId, "utf8")
    .update("\0", "utf8")
    .update(vaultId, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `wg_${digest}`;
}

function loadPortalVaultRuntimeSurface(
  userId: string,
  vault: string,
  status: VaultStatus | null,
): {
  surfaces: string[];
  paseoEnabled: boolean;
} {
  // A surface belongs to the selected runtime, not any retained backend spec.
  // Falling back here can advertise a stale Wanghai instance after a driver
  // switch and lets the gateway resolve the wrong execution target.
  const target = status?.driver?.selected;
  if (!target) {
    return { surfaces: [], paseoEnabled: false };
  }
  try {
    const loaded = loadPortalVaultByTarget(userId, vault, target);
    const ports = loaded.connectivity.servicePorts;
    const wanghaiEnabled = ports.some((port) =>
      port.name?.toLowerCase() === "wanghai" || port.containerPort === "9090"
    );
    return {
      surfaces: wanghaiEnabled
        ? loaded.agent.enabled ? ["paseo", "wanghai"] : ["wanghai"]
        : loaded.agent.enabled ? ["paseo"] : [],
      paseoEnabled: loaded.agent.enabled,
    };
  } catch {
    return { surfaces: [], paseoEnabled: false };
  }
}

export function loadVaultDetailStatic(
  userId: string,
  vault: string,
): PortalVaultDetailStatic {
  const liveSummary = readPortalVaultLiveSummary(userId, vault);
  const statusWithAssets = augmentVaultStatusAssets(
    userId,
    vault,
    readVaultStatus(userId, vault),
  );
  let bindings: PortalVaultDetailStatic["credentialBindings"] = [];
  const preferredTargets = [
    liveSummary.status?.driver?.selected ?? null,
    { backend: "docker" as const },
    { backend: "pod" as const, profile: "gvisor" },
    { backend: "kubevirt-vm" as const },
  ].filter(Boolean) as PortalDriverTarget[];
  for (const target of preferredTargets) {
    try {
      const loaded = loadPortalVaultByTarget(userId, vault, target);
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
    name: vault,
    availableDrivers: listVaultDriverTargets(userId, vault),
    credentialBindings: bindings,
    ...(statusWithAssets?.assets ? { assets: statusWithAssets.assets } : {}),
    ...(statusWithAssets?.attachments ? { attachments: statusWithAssets.attachments } : {}),
    ...(statusWithAssets?.vaultAssembly
      ? { vaultAssembly: statusWithAssets.vaultAssembly }
      : {}),
  };
}

export function loadVaultDetail(userId: string, vault: string): PortalVaultDetail {
  const summary = loadVaultSummary(userId, vault);
  const staticDetail = loadVaultDetailStatic(userId, vault);
  return {
    ...summary,
    resolvedVault: summary.status,
    availableDrivers: staticDetail.availableDrivers,
    credentialBindings: staticDetail.credentialBindings,
  };
}

export function updatePortalVaultAgentBinding(input: {
  userId: string;
  vault: string;
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
  const configPath = vaultConfigFilePath(input.userId, input.vault, input.target);
  const current = readYAML(configPath);
  if (!current) {
    throw new Error(`Vault config '${path.relative(REPO_ROOT, configPath)}' was not found`);
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
