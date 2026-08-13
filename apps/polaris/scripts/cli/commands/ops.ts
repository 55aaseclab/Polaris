import fs from "node:fs";
import path from "node:path";
import { listPortalProfiles, listOwnedVaults, vaultRefFromTarget } from "../../core/portal.js";
import type { VaultStatus } from "../../core/vault.js";
import { rebuildCommand } from "./rebuild.js";
import { synthesizeAndWriteVaultStatus } from "./status.js";
import {
  normalizeVaultStatus,
  vaultSelectionPath,
  vaultStatusPath,
  writeVaultStatus,
} from "../../output/state-store.js";
import { getPolarisControlStore } from "../../portal/control-store.js";
import { logInfo } from "../../utils/log.js";
import { polarisStateRoot } from "../../utils/paths.js";
import { workflowSmokeCommand } from "./workflow-smoke.js";

type ReconcileOptions = {
  dryRun: boolean;
  json: boolean;
  refreshStatusOnly: boolean;
  userId?: string;
  vault?: string;
};

type VaultReconcileResult = {
  userId: string;
  vault: string;
  migratedStatusFile: boolean;
  removedSelectionFile: boolean;
  refreshedDriverStatus: VaultStatus["driver"] extends infer T
    ? T extends { status?: infer S }
      ? S | null
      : null
    : null;
  refreshedDriverTarget: VaultStatus["driver"] extends infer T
    ? T extends { selected?: infer S }
      ? S | null
      : null
    : null;
  rebuiltRunningDocker: boolean;
  finalDriverStatus: VaultStatus["driver"] extends infer T
    ? T extends { status?: infer S }
      ? S | null
      : null
    : null;
  statusFile: string;
  error?: string;
};

type AuditOptions = {
  limit: number;
  json: boolean;
  verify: boolean;
};

function usage(): never {
  throw new Error(
    "Usage: pnpm --dir apps/polaris run polaris -- ops reconcile-vaults [--user <userId>] [--vault <vault>] [--dry-run] [--refresh-status-only] [--json]\n       pnpm --dir apps/polaris run polaris -- ops audit [--limit <1-1000>] [--verify] [--json]\n       pnpm --dir apps/polaris run polaris -- ops workflow-smoke [--json]",
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
    if (value === "--vault") {
      const vault = argv[index + 1]?.trim();
      if (!vault) {
        usage();
      }
      options.vault = vault;
      index += 1;
      continue;
    }
    usage();
  }
  return options;
}

function parseAuditOptions(argv: string[]): AuditOptions {
  const options: AuditOptions = { limit: 100, json: false, verify: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") {
      options.json = true;
      continue;
    }
    if (value === "--verify") {
      options.verify = true;
      continue;
    }
    if (value === "--limit") {
      const limit = Number(argv[index + 1]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error("ops audit --limit must be an integer between 1 and 1000");
      }
      options.limit = limit;
      index += 1;
      continue;
    }
    usage();
  }
  return options;
}

function readRawVaultStatus(filePath: string): VaultStatus | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as VaultStatus;
  } catch {
    return null;
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function migrateVaultStatusFile(
  userId: string,
  vault: string,
  dryRun: boolean,
): {
  migratedStatusFile: boolean;
  removedSelectionFile: boolean;
  statusFile: string;
} {
  const statusFile = vaultStatusPath(vault, userId);
  const selectionFile = vaultSelectionPath(vault, userId);
  const legacySelectionFile = path.join(polarisStateRoot(import.meta.url), `${vault}.selection.json`);
  const removedSelectionFile = fs.existsSync(selectionFile) || fs.existsSync(legacySelectionFile);
  const rawStatus = readRawVaultStatus(statusFile);
  let migratedStatusFile = false;
  if (rawStatus) {
    const normalized = normalizeVaultStatus(rawStatus);
    migratedStatusFile = stableJson(rawStatus) !== stableJson(normalized);
    if (!dryRun) {
      writeVaultStatus(rawStatus, userId);
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

async function reconcileVault(
  userId: string,
  vault: string,
  options: ReconcileOptions,
): Promise<VaultReconcileResult> {
  const migration = migrateVaultStatusFile(userId, vault, options.dryRun);
  const refreshed = await synthesizeAndWriteVaultStatus(vault, userId, {
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
      await rebuildCommand(vaultRefFromTarget(vault, driverTarget), userId);
      finalStatus = (await synthesizeAndWriteVaultStatus(vault, userId)).status;
    }
  }

  return {
    userId,
    vault,
    migratedStatusFile: migration.migratedStatusFile,
    removedSelectionFile: migration.removedSelectionFile,
    refreshedDriverStatus: driverStatus,
    refreshedDriverTarget: driverTarget,
    rebuiltRunningDocker: rebuiltRunningDocker && !options.dryRun ? true : rebuiltRunningDocker,
    finalDriverStatus: finalStatus.driver?.status ?? null,
    statusFile: migration.statusFile,
  };
}

async function reconcileVaultsCommand(argv: string[]): Promise<void> {
  const options = parseReconcileOptions(argv);
  const userIds = options.userId
    ? [options.userId]
    : listPortalProfiles().map((profile) => profile.id);
  const results: VaultReconcileResult[] = [];

  for (const userId of userIds) {
    const vaults = listOwnedVaults(userId)
      .filter((vault) => !options.vault || vault === options.vault);
    for (const vault of vaults) {
      try {
        logInfo("cli", "ops-reconcile-vault", {
          userId,
          vault,
          dryRun: options.dryRun,
          refreshStatusOnly: options.refreshStatusOnly,
        });
        results.push(await reconcileVault(userId, vault, options));
      } catch (error) {
        results.push({
          userId,
          vault,
          migratedStatusFile: false,
          removedSelectionFile: false,
          refreshedDriverStatus: null,
          refreshedDriverTarget: null,
          rebuiltRunningDocker: false,
          finalDriverStatus: null,
          statusFile: vaultStatusPath(vault, userId),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const summary = {
    dryRun: options.dryRun,
    refreshStatusOnly: options.refreshStatusOnly,
    vaultCount: results.length,
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
      `${result.userId}/${result.vault}`,
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
    `summary vaults=${summary.vaultCount} migrated=${summary.migratedCount} selection-removed=${summary.removedSelectionCount} rebuilt=${summary.rebuiltCount} errors=${summary.errorCount}\n`,
  );
}

function auditCommand(argv: string[]): void {
  const options = parseAuditOptions(argv);
  const store = getPolarisControlStore(import.meta.url);
  const events = store.listAuditEvents(options.limit);
  const integrity = options.verify ? store.verifyAuditChain() : undefined;
  const result = { events, ...(integrity ? { integrity } : {}) };

  logInfo("cli", "ops-audit", {
    limit: options.limit,
    verify: options.verify,
    eventCount: events.length,
    chainValid: integrity?.valid,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const event of events) {
      const fields = [
        event.occurredAt,
        event.outcome,
        `action=${event.action}`,
        `tenant=${event.tenantId ?? "-"}`,
        `vault=${event.vaultId ?? "-"}`,
        `actor=${event.actorId ?? "-"}`,
        `request=${event.requestId ?? "-"}`,
        `event=${event.id}`,
        `hash=${event.eventHash}`,
      ];
      process.stdout.write(`${fields.join(" ")}\n`);
    }
    if (integrity) {
      process.stdout.write(
        `integrity valid=${integrity.valid ? "yes" : "no"} checked=${integrity.checked}${integrity.failedEventId ? ` failed-event=${integrity.failedEventId}` : ""}${integrity.reason ? ` reason=${integrity.reason}` : ""}\n`,
      );
    }
  }

  if (integrity && !integrity.valid) {
    throw new Error(
      `Audit chain verification failed${integrity.failedEventId ? ` for event ${integrity.failedEventId}` : ""}${integrity.reason ? ` (${integrity.reason})` : ""}`,
    );
  }
}

export async function opsCommand(action: string | undefined, argv: string[]): Promise<void> {
  if (!action) {
    usage();
  }
  if (action === "reconcile-vaults") {
    await reconcileVaultsCommand(argv);
    return;
  }
  if (action === "audit") {
    auditCommand(argv);
    return;
  }
  if (action === "workflow-smoke") {
    await workflowSmokeCommand(argv);
    return;
  }
  usage();
}
