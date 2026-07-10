import fs from "node:fs";
import path from "node:path";
import { listPortalProfiles, listOwnedWorkspaces, workspaceRefFromTarget } from "../../core/portal.js";
import type { WorkspaceStatus } from "../../core/workspace.js";
import { rebuildCommand } from "./rebuild.js";
import { synthesizeAndWriteWorkspaceStatus } from "./status.js";
import {
  normalizeWorkspaceStatus,
  workspaceSelectionPath,
  workspaceStatusPath,
  writeWorkspaceStatus,
} from "../../output/state-store.js";
import { logInfo } from "../../utils/log.js";
import { polarisStateRoot } from "../../utils/paths.js";

type ReconcileOptions = {
  dryRun: boolean;
  json: boolean;
  refreshStatusOnly: boolean;
  userId?: string;
  workspace?: string;
};

type WorkspaceReconcileResult = {
  userId: string;
  workspace: string;
  migratedStatusFile: boolean;
  removedSelectionFile: boolean;
  refreshedDriverStatus: WorkspaceStatus["driver"] extends infer T
    ? T extends { status?: infer S }
      ? S | null
      : null
    : null;
  refreshedDriverTarget: WorkspaceStatus["driver"] extends infer T
    ? T extends { selected?: infer S }
      ? S | null
      : null
    : null;
  rebuiltRunningDocker: boolean;
  finalDriverStatus: WorkspaceStatus["driver"] extends infer T
    ? T extends { status?: infer S }
      ? S | null
      : null
    : null;
  statusFile: string;
  error?: string;
};

function usage(): never {
  throw new Error(
    "Usage: pnpm --dir apps/polaris run polaris -- ops reconcile-workspaces [--user <userId>] [--workspace <workspace>] [--dry-run] [--refresh-status-only] [--json]",
  );
}

function parseReconcileOptions(argv: string[]): ReconcileOptions {
  const options: ReconcileOptions = {
    dryRun: false,
    json: false,
    refreshStatusOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (value === "--json") {
      options.json = true;
      continue;
    }
    if (value === "--refresh-status-only") {
      options.refreshStatusOnly = true;
      continue;
    }
    if (value === "--user") {
      const userId = argv[index + 1]?.trim();
      if (!userId) {
        usage();
      }
      options.userId = userId;
      index += 1;
      continue;
    }
    if (value === "--workspace") {
      const workspace = argv[index + 1]?.trim();
      if (!workspace) {
        usage();
      }
      options.workspace = workspace;
      index += 1;
      continue;
    }
    usage();
  }
  return options;
}

function readRawWorkspaceStatus(filePath: string): WorkspaceStatus | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as WorkspaceStatus;
  } catch {
    return null;
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function migrateWorkspaceStatusFile(
  userId: string,
  workspace: string,
  dryRun: boolean,
): {
  migratedStatusFile: boolean;
  removedSelectionFile: boolean;
  statusFile: string;
} {
  const statusFile = workspaceStatusPath(workspace, userId);
  const selectionFile = workspaceSelectionPath(workspace, userId);
  const legacySelectionFile = path.join(polarisStateRoot(import.meta.url), `${workspace}.selection.json`);
  const removedSelectionFile = fs.existsSync(selectionFile) || fs.existsSync(legacySelectionFile);
  const rawStatus = readRawWorkspaceStatus(statusFile);
  let migratedStatusFile = false;
  if (rawStatus) {
    const normalized = normalizeWorkspaceStatus(rawStatus);
    migratedStatusFile = stableJson(rawStatus) !== stableJson(normalized);
    if (!dryRun) {
      writeWorkspaceStatus(rawStatus, userId);
    }
  }
  if (removedSelectionFile && !dryRun) {
    fs.rmSync(selectionFile, { force: true });
    fs.rmSync(legacySelectionFile, { force: true });
  }
  return {
    migratedStatusFile,
    removedSelectionFile,
    statusFile,
  };
}

async function reconcileWorkspace(
  userId: string,
  workspace: string,
  options: ReconcileOptions,
): Promise<WorkspaceReconcileResult> {
  const migration = migrateWorkspaceStatusFile(userId, workspace, options.dryRun);
  const refreshed = await synthesizeAndWriteWorkspaceStatus(workspace, userId, {
    write: !options.dryRun,
  });
  let rebuiltRunningDocker = false;
  let finalStatus = refreshed.status;

  const driverTarget = refreshed.status.driver?.selected ?? null;
  const driverStatus = refreshed.status.driver?.status ?? null;
  const shouldRebuild =
    !options.refreshStatusOnly
    && driverTarget?.backend === "docker"
    && driverStatus === "running";

  if (shouldRebuild) {
    rebuiltRunningDocker = true;
    if (!options.dryRun) {
      await rebuildCommand(workspaceRefFromTarget(workspace, driverTarget), userId);
      finalStatus = (await synthesizeAndWriteWorkspaceStatus(workspace, userId)).status;
    }
  }

  return {
    userId,
    workspace,
    migratedStatusFile: migration.migratedStatusFile,
    removedSelectionFile: migration.removedSelectionFile,
    refreshedDriverStatus: driverStatus,
    refreshedDriverTarget: driverTarget,
    rebuiltRunningDocker: rebuiltRunningDocker && !options.dryRun ? true : rebuiltRunningDocker,
    finalDriverStatus: finalStatus.driver?.status ?? null,
    statusFile: migration.statusFile,
  };
}

async function reconcileWorkspacesCommand(argv: string[]): Promise<void> {
  const options = parseReconcileOptions(argv);
  const userIds = options.userId
    ? [options.userId]
    : listPortalProfiles().map((profile) => profile.id);
  const results: WorkspaceReconcileResult[] = [];

  for (const userId of userIds) {
    const workspaces = listOwnedWorkspaces(userId)
      .filter((workspace) => !options.workspace || workspace === options.workspace);
    for (const workspace of workspaces) {
      try {
        logInfo("cli", "ops-reconcile-workspace", {
          userId,
          workspace,
          dryRun: options.dryRun,
          refreshStatusOnly: options.refreshStatusOnly,
        });
        results.push(await reconcileWorkspace(userId, workspace, options));
      } catch (error) {
        results.push({
          userId,
          workspace,
          migratedStatusFile: false,
          removedSelectionFile: false,
          refreshedDriverStatus: null,
          refreshedDriverTarget: null,
          rebuiltRunningDocker: false,
          finalDriverStatus: null,
          statusFile: workspaceStatusPath(workspace, userId),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const summary = {
    dryRun: options.dryRun,
    refreshStatusOnly: options.refreshStatusOnly,
    workspaceCount: results.length,
    migratedCount: results.filter((result) => result.migratedStatusFile).length,
    removedSelectionCount: results.filter((result) => result.removedSelectionFile).length,
    rebuiltCount: results.filter((result) => result.rebuiltRunningDocker).length,
    errorCount: results.filter((result) => result.error).length,
    results,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  for (const result of results) {
    const parts = [
      `${result.userId}/${result.workspace}`,
      `migrated=${result.migratedStatusFile ? "yes" : "no"}`,
      `selection-removed=${result.removedSelectionFile ? "yes" : "no"}`,
      `refreshed=${result.refreshedDriverStatus ?? "unknown"}`,
      `rebuilt=${result.rebuiltRunningDocker ? "yes" : "no"}`,
      `final=${result.finalDriverStatus ?? "unknown"}`,
    ];
    if (result.error) {
      parts.push(`error=${result.error}`);
    }
    process.stdout.write(`${parts.join(" ")}\n`);
  }
  process.stdout.write(
    `summary workspaces=${summary.workspaceCount} migrated=${summary.migratedCount} selection-removed=${summary.removedSelectionCount} rebuilt=${summary.rebuiltCount} errors=${summary.errorCount}\n`,
  );
}

export async function opsCommand(action: string | undefined, argv: string[]): Promise<void> {
  if (!action) {
    usage();
  }
  if (action === "reconcile-workspaces") {
    await reconcileWorkspacesCommand(argv);
    return;
  }
  usage();
}
