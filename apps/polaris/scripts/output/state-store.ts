import fs from "node:fs";
import path from "node:path";
import {
  VAULT_STATUS_SCHEMA_VERSION_V1,
  VAULT_STATUS_SCHEMA_VERSION_V1_1,
  VAULT_STATUS_SCHEMA_VERSION,
  type VaultStatusSchemaVersion,
  type VaultStatus,
} from "../core/vault.js";
import { assertNoProjectNameCollision } from "../config/project-ownership.js";
import { polarisStateRoot, polarisUsersRoot } from "../utils/paths.js";

const LEGACY_STATE_DIR = polarisStateRoot(import.meta.url);
const USER_ROOT = polarisUsersRoot(import.meta.url);

export interface VaultDriverSelection {
  backend: "docker" | "pod" | "kubevirt-vm";
  profile?: string;
}

export interface VaultLiveCredentialSelectionState {
  harness: string;
  credentialId: string;
  updatedAt: string;
}

function projectRoot(project: string, userProfileId?: string): string | null {
  if (userProfileId?.trim()) {
    const candidate = path.join(
      USER_ROOT,
      userProfileId.trim(),
      "vaults",
      project,
    );
    return fs.existsSync(candidate) ? candidate : null;
  }

  if (!fs.existsSync(USER_ROOT)) {
    return null;
  }
  assertNoProjectNameCollision(project);

  const matches = fs
    .readdirSync(USER_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(USER_ROOT, entry.name, "vaults", project))
    .filter((candidate) => fs.existsSync(candidate))
    .sort();

  return matches[0] ?? null;
}

export function vaultStateDir(project: string, userProfileId?: string): string {
  const root = projectRoot(project, userProfileId);
  return root ? path.join(root, "state") : LEGACY_STATE_DIR;
}

export function vaultStatusPath(project: string, userProfileId?: string): string {
  const stateDir = vaultStateDir(project, userProfileId);
  if (stateDir === LEGACY_STATE_DIR) {
    return path.join(stateDir, `${project}.status.json`);
  }
  return path.join(stateDir, "status.json");
}

export function vaultSelectionPath(project: string, userProfileId?: string): string {
  const stateDir = vaultStateDir(project, userProfileId);
  if (stateDir === LEGACY_STATE_DIR) {
    return path.join(stateDir, `${project}.selection.json`);
  }
  return path.join(stateDir, "selection.json");
}

export function vaultLiveCredentialsPath(
  project: string,
  userProfileId?: string,
): string {
  const stateDir = vaultStateDir(project, userProfileId);
  if (stateDir === LEGACY_STATE_DIR) {
    return path.join(stateDir, `${project}.live-credentials.json`);
  }
  return path.join(stateDir, "live-credentials.json");
}

function legacyVaultStatusPath(project: string): string {
  return path.join(LEGACY_STATE_DIR, `${project}.status.json`);
}

function legacyVaultSelectionPath(project: string): string {
  return path.join(LEGACY_STATE_DIR, `${project}.selection.json`);
}

function legacyVaultLiveCredentialsPath(project: string): string {
  return path.join(LEGACY_STATE_DIR, `${project}.live-credentials.json`);
}

export function vaultEvolutionStateDir(project: string, userProfileId?: string): string {
  return path.join(vaultStateDir(project, userProfileId), "evolution");
}

export function vaultPaseoStateDir(project: string, userProfileId?: string): string {
  return path.join(vaultStateDir(project, userProfileId), "paseo");
}

function readVaultStatusFile(filePath: string): VaultStatus | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return normalizeVaultStatus(
      JSON.parse(fs.readFileSync(filePath, "utf8")) as VaultStatus,
    );
  } catch {
    return null;
  }
}

export function readStoredVaultStatus(project: string, userProfileId?: string): VaultStatus | null {
  const candidates = [
    vaultStatusPath(project, userProfileId),
    legacyVaultStatusPath(project),
  ].filter((candidate, index, entries) => entries.indexOf(candidate) === index);

  for (const filePath of candidates) {
    const status = readVaultStatusFile(filePath);
    if (status) {
      return status;
    }
  }
  return null;
}

type VaultStatusV1Driver = NonNullable<VaultStatus["driver"]> & {
  backend?: "docker" | "pod" | "kubevirt-vm";
  profile?: string;
};

type VaultStatusV1 = Omit<VaultStatus, "schemaVersion" | "driver"> & {
  schemaVersion?: typeof VAULT_STATUS_SCHEMA_VERSION_V1;
  driver?: VaultStatusV1Driver;
  operation?: {
    kind: "create" | "start" | "stop" | "rebuild" | "delete";
    updatedAt: string;
  };
  runtime?: {
    selectedDriver: {
      backend: "docker" | "pod" | "kubevirt-vm";
      profile?: string;
    } | null;
    lifecycle: "absent" | "running" | "stopped" | "unknown";
    reason?: string;
  };
  health?: {
    backendLiveness?: "absent" | "running" | "stopped" | "unknown";
    reason?: string;
  };
};

function upgradeLegacyRuntimeLifecycle(
  status: VaultStatusV1,
): NonNullable<VaultStatusV1["runtime"]>["lifecycle"] {
  if (status.runtime?.lifecycle) {
    return status.runtime.lifecycle;
  }
  switch (status.health?.backendLiveness) {
    case "absent":
      return "absent";
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    default:
      return "unknown";
  }
}

function upgradeDriverStatus(status: VaultStatusV1): NonNullable<VaultStatus["driver"]>["status"] {
  switch (status.operation?.kind) {
    case "create":
      return "creating";
    case "start":
      return "starting";
    case "stop":
      return "stopping";
    case "rebuild":
      return "rebuilding";
    case "delete":
      return "deleting";
    default:
      break;
  }
  switch (upgradeLegacyRuntimeLifecycle(status)) {
    case "absent":
      return "absent";
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    default:
      return "unknown";
  }
}

function downgradeDriverStatus(status: NonNullable<VaultStatus["driver"]>["status"]): {
  runtimeLifecycle: NonNullable<VaultStatusV1["runtime"]>["lifecycle"];
  operation?: VaultStatusV1["operation"];
} {
  switch (status) {
    case "creating":
      return { runtimeLifecycle: "absent", operation: { kind: "create", updatedAt: new Date().toISOString() } };
    case "starting":
      return { runtimeLifecycle: "stopped", operation: { kind: "start", updatedAt: new Date().toISOString() } };
    case "stopping":
      return { runtimeLifecycle: "running", operation: { kind: "stop", updatedAt: new Date().toISOString() } };
    case "rebuilding":
      return { runtimeLifecycle: "running", operation: { kind: "rebuild", updatedAt: new Date().toISOString() } };
    case "deleting":
      return { runtimeLifecycle: "stopped", operation: { kind: "delete", updatedAt: new Date().toISOString() } };
    case "running":
      return { runtimeLifecycle: "running" };
    case "stopped":
      return { runtimeLifecycle: "stopped" };
    case "absent":
      return { runtimeLifecycle: "absent" };
    case "failed":
    case "unknown":
    default:
      return { runtimeLifecycle: "unknown" };
  }
}

function upgradeVaultStatusV1ToV1_1(status: VaultStatusV1): VaultStatus {
  const legacyDriver = status.driver;
  const selectedDriver =
    (legacyDriver?.backend
      ? {
          backend: legacyDriver.backend,
          ...(legacyDriver.profile ? { profile: legacyDriver.profile } : {}),
        }
      : null)
    ?? status.runtime?.selectedDriver
    ?? null;
  const driverStatus = upgradeDriverStatus(status);
  const driverReason = status.runtime?.reason ?? status.health?.reason;
  return {
    ...status,
    schemaVersion: VAULT_STATUS_SCHEMA_VERSION_V1_1,
    driver: {
      ...(status.driver ?? {}),
      selected: selectedDriver,
      status: driverStatus,
      ...(driverReason ? { reason: driverReason } : {}),
    },
  };
}

function isVaultStatusV1_1Shape(status: VaultStatus): boolean {
  if ((status.schemaVersion ?? null) === VAULT_STATUS_SCHEMA_VERSION_V1_1) {
    return true;
  }
  if ((status.schemaVersion ?? null) === VAULT_STATUS_SCHEMA_VERSION_V1) {
    return false;
  }
  const driver = status.driver as Record<string, unknown> | undefined;
  if (!driver) {
    return false;
  }
  if ("selected" in driver || "status" in driver) {
    return true;
  }
  if (!("runtime" in (status as unknown as Record<string, unknown>))) {
    return true;
  }
  return false;
}

function downgradeVaultStatusV1_1ToV1(status: VaultStatus): VaultStatusV1 {
  const selectedDriver = status.driver?.selected ?? null;
  const downgradedStatus = downgradeDriverStatus(status.driver?.status ?? "unknown");
  const driver = status.driver
    ? {
        ...status.driver,
        ...(selectedDriver
          ? {
              backend: selectedDriver.backend,
              ...(selectedDriver.profile ? { profile: selectedDriver.profile } : {}),
            }
          : {}),
      }
    : undefined;
  if (driver && "selected" in driver) {
    delete (driver as Record<string, unknown>).selected;
  }
  if (driver && "status" in driver) {
    delete (driver as Record<string, unknown>).status;
  }
  if (driver && "reason" in driver) {
    delete (driver as Record<string, unknown>).reason;
  }
  return {
    ...status,
    schemaVersion: VAULT_STATUS_SCHEMA_VERSION_V1,
    ...(driver ? { driver } : {}),
    ...(downgradedStatus.operation ? { operation: downgradedStatus.operation } : {}),
    runtime: {
      selectedDriver,
      lifecycle: downgradedStatus.runtimeLifecycle,
      ...(status.driver?.reason
        ? { reason: status.driver.reason }
        : {}),
    },
  };
}

export function normalizeVaultStatus(
  status: VaultStatus,
  targetSchemaVersion: VaultStatusSchemaVersion = VAULT_STATUS_SCHEMA_VERSION,
): VaultStatus {
  const upgraded =
    !isVaultStatusV1_1Shape(status)
      ? upgradeVaultStatusV1ToV1_1(status as VaultStatusV1)
      : status;
  if (targetSchemaVersion === VAULT_STATUS_SCHEMA_VERSION_V1) {
    return downgradeVaultStatusV1_1ToV1(upgraded) as VaultStatus;
  }
  const legacyDriver = (upgraded as VaultStatus & {
    driver?: VaultStatusV1Driver;
  }).driver;
  const selectedDriver =
    upgraded.driver?.selected
    ?? (legacyDriver?.backend
      ? {
          backend: legacyDriver.backend,
          ...(legacyDriver.profile ? { profile: legacyDriver.profile } : {}),
        }
      : null)
    ?? null;
  const driverLifecycle =
    upgraded.driver?.status ?? "unknown";
  const driverReason =
    Object.prototype.hasOwnProperty.call(upgraded.driver ?? {}, "reason")
      ? upgraded.driver?.reason
      : undefined;
  const next = {
    ...upgraded,
    schemaVersion: VAULT_STATUS_SCHEMA_VERSION_V1_1,
    ...(upgraded.driver
      ? {
          driver: {
            ...upgraded.driver,
            selected: selectedDriver,
            status: driverLifecycle,
            ...(driverReason ? { reason: driverReason } : {}),
          },
        }
      : {}),
    details: upgraded.details ?? {},
  } as VaultStatus & Record<string, unknown>;
  if (next.driver && "backend" in (next.driver as Record<string, unknown>)) {
    delete (next.driver as Record<string, unknown>).backend;
  }
  if (next.driver && "profile" in (next.driver as Record<string, unknown>)) {
    delete (next.driver as Record<string, unknown>).profile;
  }
  if ("operation" in next) {
    delete (next as Record<string, unknown>).operation;
  }
  delete (next as Record<string, unknown>).daemon;
  delete (next as Record<string, unknown>).ssh;
  delete (next as Record<string, unknown>).drift;
  return next;
}

export function writeVaultStatus(
  status: VaultStatus,
  userProfileId?: string,
  targetSchemaVersion: VaultStatusSchemaVersion = VAULT_STATUS_SCHEMA_VERSION,
): string {
  const outputPath = vaultStatusPath(status.project, userProfileId);
  const next = normalizeVaultStatus(status, targetSchemaVersion);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.rmSync(vaultSelectionPath(status.project, userProfileId), { force: true });
  fs.rmSync(legacyVaultSelectionPath(status.project), { force: true });
  if (outputPath !== legacyVaultStatusPath(status.project)) {
    fs.rmSync(legacyVaultStatusPath(status.project), { force: true });
  }
  return outputPath;
}

export function writeVaultPaseoServerId(
  project: string,
  serverId: string,
  userProfileId?: string,
): string {
  const outputPath = path.join(
    vaultPaseoStateDir(project, userProfileId),
    "server-id",
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${serverId.trim()}\n`, "utf8");
  return outputPath;
}

export function writeVaultPaseoPairing(
  project: string,
  pairing: Record<string, unknown> & { url: string },
  userProfileId?: string,
): string {
  const outputPath = path.join(
    vaultPaseoStateDir(project, userProfileId),
    "pairing.json",
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(pairing, null, 2)}\n`, "utf8");
  return outputPath;
}

export function readVaultDriverSelection(project: string, userProfileId?: string): VaultDriverSelection | null {
  const selected = readStoredVaultStatus(project, userProfileId)?.driver?.selected;
  if (!selected) {
    return null;
  }
  if (selected.backend !== "docker" && selected.backend !== "pod" && selected.backend !== "kubevirt-vm") {
    return null;
  }
  if (selected.profile !== undefined && typeof selected.profile !== "string") {
    return null;
  }
  return selected;
}

export function writeVaultDriverSelection(
  project: string,
  selection: VaultDriverSelection,
  userProfileId?: string,
): string {
  const current = readStoredVaultStatus(project, userProfileId);
  const outputPath = writeVaultStatus({
    schemaVersion: VAULT_STATUS_SCHEMA_VERSION,
    project,
    paseo: current?.paseo ?? {
      daemon: "unknown",
      web: "unavailable",
      reconnectMode: "unknown",
      liveTarget: null,
      reconnectTarget: null,
    },
    details: current?.details ?? {},
    driver: {
      ...(current?.driver ?? {}),
      status: current?.driver?.status ?? "unknown",
      selected: selection,
    },
  }, userProfileId);
  fs.rmSync(vaultSelectionPath(project, userProfileId), { force: true });
  fs.rmSync(legacyVaultSelectionPath(project), { force: true });
  return outputPath;
}

export function readVaultLiveCredentialSelections(
  project: string,
  userProfileId?: string,
): Record<string, VaultLiveCredentialSelectionState> {
  const candidates = [
    vaultLiveCredentialsPath(project, userProfileId),
    legacyVaultLiveCredentialsPath(project),
  ].filter((candidate, index, entries) => entries.indexOf(candidate) === index);

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(
        fs.readFileSync(filePath, "utf8"),
      ) as Record<string, VaultLiveCredentialSelectionState>;
      return Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => {
          return Boolean(
            value &&
            typeof value.harness === "string" &&
            typeof value.credentialId === "string" &&
            typeof value.updatedAt === "string",
          );
        }),
      );
    } catch {
      return {};
    }
  }
  return {};
}

export function writeVaultLiveCredentialSelection(
  project: string,
  harness: string,
  credentialId: string,
  userProfileId?: string,
): string {
  const outputPath = vaultLiveCredentialsPath(project, userProfileId);
  const current = readVaultLiveCredentialSelections(project, userProfileId);
  current[harness] = {
    harness,
    credentialId,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  if (outputPath !== legacyVaultLiveCredentialsPath(project)) {
    fs.rmSync(legacyVaultLiveCredentialsPath(project), { force: true });
  }
  return outputPath;
}

export function clearVaultLiveCredentialSelection(
  project: string,
  harness: string,
  userProfileId?: string,
): void {
  const outputPath = vaultLiveCredentialsPath(project, userProfileId);
  const current = readVaultLiveCredentialSelections(project, userProfileId);
  delete current[harness];
  if (Object.keys(current).length === 0) {
    fs.rmSync(outputPath, { force: true });
    if (outputPath !== legacyVaultLiveCredentialsPath(project)) {
      fs.rmSync(legacyVaultLiveCredentialsPath(project), { force: true });
    }
    return;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}
