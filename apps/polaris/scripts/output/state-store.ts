import fs from "node:fs";
import path from "node:path";
import {
  WORKSPACE_STATUS_SCHEMA_VERSION_V1,
  WORKSPACE_STATUS_SCHEMA_VERSION_V1_1,
  WORKSPACE_STATUS_SCHEMA_VERSION,
  type WorkspaceStatusSchemaVersion,
  type WorkspaceStatus,
} from "../core/workspace.js";
import { assertNoProjectNameCollision } from "../config/project-ownership.js";
import { polarisStateRoot, polarisUsersRoot } from "../utils/paths.js";

const LEGACY_STATE_DIR = polarisStateRoot(import.meta.url);
const USER_ROOT = polarisUsersRoot(import.meta.url);

export interface WorkspaceDriverSelection {
  backend: "docker" | "pod" | "kubevirt-vm";
  profile?: string;
}

export interface WorkspaceLiveCredentialSelectionState {
  harness: string;
  credentialId: string;
  updatedAt: string;
}

function projectRoot(project: string, userProfileId?: string): string | null {
  if (userProfileId?.trim()) {
    const candidate = path.join(
      USER_ROOT,
      userProfileId.trim(),
      "workspaces",
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
    .map((entry) => path.join(USER_ROOT, entry.name, "workspaces", project))
    .filter((candidate) => fs.existsSync(candidate))
    .sort();

  return matches[0] ?? null;
}

export function workspaceStateDir(project: string, userProfileId?: string): string {
  const root = projectRoot(project, userProfileId);
  return root ? path.join(root, "state") : LEGACY_STATE_DIR;
}

export function workspaceStatusPath(project: string, userProfileId?: string): string {
  const stateDir = workspaceStateDir(project, userProfileId);
  if (stateDir === LEGACY_STATE_DIR) {
    return path.join(stateDir, `${project}.status.json`);
  }
  return path.join(stateDir, "status.json");
}

export function workspaceSelectionPath(project: string, userProfileId?: string): string {
  const stateDir = workspaceStateDir(project, userProfileId);
  if (stateDir === LEGACY_STATE_DIR) {
    return path.join(stateDir, `${project}.selection.json`);
  }
  return path.join(stateDir, "selection.json");
}

export function workspaceLiveCredentialsPath(
  project: string,
  userProfileId?: string,
): string {
  const stateDir = workspaceStateDir(project, userProfileId);
  if (stateDir === LEGACY_STATE_DIR) {
    return path.join(stateDir, `${project}.live-credentials.json`);
  }
  return path.join(stateDir, "live-credentials.json");
}

function legacyWorkspaceStatusPath(project: string): string {
  return path.join(LEGACY_STATE_DIR, `${project}.status.json`);
}

function legacyWorkspaceSelectionPath(project: string): string {
  return path.join(LEGACY_STATE_DIR, `${project}.selection.json`);
}

function legacyWorkspaceLiveCredentialsPath(project: string): string {
  return path.join(LEGACY_STATE_DIR, `${project}.live-credentials.json`);
}

export function workspaceEvolutionStateDir(project: string, userProfileId?: string): string {
  return path.join(workspaceStateDir(project, userProfileId), "evolution");
}

export function workspacePaseoStateDir(project: string, userProfileId?: string): string {
  return path.join(workspaceStateDir(project, userProfileId), "paseo");
}

function readWorkspaceStatusFile(filePath: string): WorkspaceStatus | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return normalizeWorkspaceStatus(
      JSON.parse(fs.readFileSync(filePath, "utf8")) as WorkspaceStatus,
    );
  } catch {
    return null;
  }
}

function readStoredWorkspaceStatus(project: string, userProfileId?: string): WorkspaceStatus | null {
  const candidates = [
    workspaceStatusPath(project, userProfileId),
    legacyWorkspaceStatusPath(project),
  ].filter((candidate, index, entries) => entries.indexOf(candidate) === index);

  for (const filePath of candidates) {
    const status = readWorkspaceStatusFile(filePath);
    if (status) {
      return status;
    }
  }
  return null;
}

type WorkspaceStatusV1Driver = NonNullable<WorkspaceStatus["driver"]> & {
  backend?: "docker" | "pod" | "kubevirt-vm";
  profile?: string;
};

type WorkspaceStatusV1 = Omit<WorkspaceStatus, "schemaVersion" | "driver"> & {
  schemaVersion?: typeof WORKSPACE_STATUS_SCHEMA_VERSION_V1;
  driver?: WorkspaceStatusV1Driver;
  operation?: {
    kind: "create" | "start" | "stop" | "rebuild" | "archive" | "delete";
    updatedAt: string;
  };
  runtime: {
    selectedDriver: {
      backend: "docker" | "pod" | "kubevirt-vm";
      profile?: string;
    } | null;
    lifecycle: "absent" | "running" | "stopped" | "unknown";
    reason?: string;
  };
};

function upgradeDriverStatus(status: WorkspaceStatusV1): NonNullable<WorkspaceStatus["driver"]>["status"] {
  switch (status.operation?.kind) {
    case "create":
      return "creating";
    case "start":
      return "starting";
    case "stop":
      return "stopping";
    case "rebuild":
      return "rebuilding";
    case "archive":
      return "archiving";
    case "delete":
      return "deleting";
    default:
      break;
  }
  switch (status.runtime.lifecycle) {
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

function downgradeDriverStatus(status: NonNullable<WorkspaceStatus["driver"]>["status"]): {
  runtimeLifecycle: WorkspaceStatusV1["runtime"]["lifecycle"];
  operation?: WorkspaceStatusV1["operation"];
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
    case "archiving":
      return { runtimeLifecycle: "stopped", operation: { kind: "archive", updatedAt: new Date().toISOString() } };
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

function upgradeWorkspaceStatusV1ToV1_1(status: WorkspaceStatusV1): WorkspaceStatus {
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
  const driverReason = status.runtime?.reason;
  return {
    ...status,
    schemaVersion: WORKSPACE_STATUS_SCHEMA_VERSION_V1_1,
    driver: {
      ...(status.driver ?? {}),
      selected: selectedDriver,
      status: driverStatus,
      ...(driverReason ? { reason: driverReason } : {}),
    },
  };
}

function isWorkspaceStatusV1_1Shape(status: WorkspaceStatus): boolean {
  if ((status.schemaVersion ?? null) === WORKSPACE_STATUS_SCHEMA_VERSION_V1_1) {
    return true;
  }
  if ((status.schemaVersion ?? null) === WORKSPACE_STATUS_SCHEMA_VERSION_V1) {
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

function downgradeWorkspaceStatusV1_1ToV1(status: WorkspaceStatus): WorkspaceStatusV1 {
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
    schemaVersion: WORKSPACE_STATUS_SCHEMA_VERSION_V1,
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

export function normalizeWorkspaceStatus(
  status: WorkspaceStatus,
  targetSchemaVersion: WorkspaceStatusSchemaVersion = WORKSPACE_STATUS_SCHEMA_VERSION,
): WorkspaceStatus {
  const upgraded =
    !isWorkspaceStatusV1_1Shape(status)
      ? upgradeWorkspaceStatusV1ToV1_1(status as WorkspaceStatusV1)
      : status;
  if (targetSchemaVersion === WORKSPACE_STATUS_SCHEMA_VERSION_V1) {
    return downgradeWorkspaceStatusV1_1ToV1(upgraded) as WorkspaceStatus;
  }
  const legacyDriver = (upgraded as WorkspaceStatus & {
    driver?: WorkspaceStatusV1Driver;
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
    schemaVersion: WORKSPACE_STATUS_SCHEMA_VERSION_V1_1,
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
  } as WorkspaceStatus & Record<string, unknown>;
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

export function writeWorkspaceStatus(
  status: WorkspaceStatus,
  userProfileId?: string,
  targetSchemaVersion: WorkspaceStatusSchemaVersion = WORKSPACE_STATUS_SCHEMA_VERSION,
): string {
  const outputPath = workspaceStatusPath(status.project, userProfileId);
  const next = normalizeWorkspaceStatus(status, targetSchemaVersion);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  if (outputPath !== legacyWorkspaceStatusPath(status.project)) {
    fs.rmSync(legacyWorkspaceStatusPath(status.project), { force: true });
  }
  return outputPath;
}

export function writeWorkspacePaseoServerId(
  project: string,
  serverId: string,
  userProfileId?: string,
): string {
  const outputPath = path.join(
    workspacePaseoStateDir(project, userProfileId),
    "server-id",
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${serverId.trim()}\n`, "utf8");
  return outputPath;
}

export function writeWorkspacePaseoPairing(
  project: string,
  pairing: Record<string, unknown> & { url: string },
  userProfileId?: string,
): string {
  const outputPath = path.join(
    workspacePaseoStateDir(project, userProfileId),
    "pairing.json",
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(pairing, null, 2)}\n`, "utf8");
  return outputPath;
}

export function readWorkspaceDriverSelection(project: string, userProfileId?: string): WorkspaceDriverSelection | null {
  const selected = readStoredWorkspaceStatus(project, userProfileId)?.driver?.selected;
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

export function writeWorkspaceDriverSelection(
  project: string,
  selection: WorkspaceDriverSelection,
  userProfileId?: string,
): string {
  const current = readStoredWorkspaceStatus(project, userProfileId);
  const outputPath = writeWorkspaceStatus({
    schemaVersion: WORKSPACE_STATUS_SCHEMA_VERSION,
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
  fs.rmSync(workspaceSelectionPath(project, userProfileId), { force: true });
  fs.rmSync(legacyWorkspaceSelectionPath(project), { force: true });
  return outputPath;
}

export function readWorkspaceLiveCredentialSelections(
  project: string,
  userProfileId?: string,
): Record<string, WorkspaceLiveCredentialSelectionState> {
  const candidates = [
    workspaceLiveCredentialsPath(project, userProfileId),
    legacyWorkspaceLiveCredentialsPath(project),
  ].filter((candidate, index, entries) => entries.indexOf(candidate) === index);

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(
        fs.readFileSync(filePath, "utf8"),
      ) as Record<string, WorkspaceLiveCredentialSelectionState>;
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

export function writeWorkspaceLiveCredentialSelection(
  project: string,
  harness: string,
  credentialId: string,
  userProfileId?: string,
): string {
  const outputPath = workspaceLiveCredentialsPath(project, userProfileId);
  const current = readWorkspaceLiveCredentialSelections(project, userProfileId);
  current[harness] = {
    harness,
    credentialId,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  if (outputPath !== legacyWorkspaceLiveCredentialsPath(project)) {
    fs.rmSync(legacyWorkspaceLiveCredentialsPath(project), { force: true });
  }
  return outputPath;
}

export function clearWorkspaceLiveCredentialSelection(
  project: string,
  harness: string,
  userProfileId?: string,
): void {
  const outputPath = workspaceLiveCredentialsPath(project, userProfileId);
  const current = readWorkspaceLiveCredentialSelections(project, userProfileId);
  delete current[harness];
  if (Object.keys(current).length === 0) {
    fs.rmSync(outputPath, { force: true });
    if (outputPath !== legacyWorkspaceLiveCredentialsPath(project)) {
      fs.rmSync(legacyWorkspaceLiveCredentialsPath(project), { force: true });
    }
    return;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}
