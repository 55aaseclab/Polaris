import { getBackendDriver } from "../../backends/index.js";
import { spawnSync } from "node:child_process";
import { loadVaultFromConfigPath, resolveVaultConfigPath } from "../../config/load.js";
import { ensureProvisionedVault, ensureVaultConfig } from "../../config/provision.js";
import { computeVaultDrift, synthesizeVaultStatus } from "../../core/runtime-controller.js";
import type { VaultCommandKind, VaultSpec, VaultStatus } from "../../core/vault.js";
import { vaultRuntimeScopeName } from "../../core/vault-name.js";
import { readKubevirtPersistedPaseoState } from "../../backends/kubevirt/driver.js";
import {
  appendEvolutionEvent,
  createEvolutionSessionId,
  finalizeEvolutionSession,
  prepareEvolutionMemorySnapshot,
} from "../../evolution/runtime.js";
import { writeVaultPaseoPairing, writeVaultPaseoServerId } from "../../output/state-store.js";
import { logDebug, logInfo, logWarn } from "../../utils/log.js";
import { logVaultEvent } from "../../utils/vault-log.js";

function runCheckedCapture(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    const stdout = String(result.stdout || "").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? "unknown"})${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ""}`,
    );
  }
  return String(result.stdout || "");
}

function isStoppedContainerExecError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message;
  return (
    message.includes("cannot exec in a stopped state") ||
    message.includes("is not running") ||
    message.includes("container") && message.includes("not running")
  );
}

function readJsonObject(raw: string): (Record<string, unknown> & { url: string }) | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.url === "string" && parsed.url.trim() ? { ...parsed, url: parsed.url.trim() } : null;
  } catch {
    return null;
  }
}

export async function persistVaultPaseoState(
  vault: VaultSpec,
): Promise<"persisted" | "skipped" | "stopped"> {
  if (!vault.agent.enabled) {
    return "skipped";
  }
  const startedAt = Date.now();
  let serverId = "";
  let pairing: (Record<string, unknown> & { url: string }) | null = null;
  const serverIdPath = `${vault.agent.runtime.stateRoot}/server-id`;
  const pairingPath = vault.agent.runtime.pairingFile ?? `${vault.agent.runtime.stateRoot}/pairing.json`;

  if (vault.backend.kind === "docker") {
    const scope = vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName);
    try {
      serverId = runCheckedCapture(
        "docker",
        ["exec", `${scope}-docker`, "sh", "-lc", `cat ${serverIdPath} 2>/dev/null || true`],
      ).trim();
      pairing = readJsonObject(
        runCheckedCapture(
          "docker",
          ["exec", `${scope}-docker`, "sh", "-lc", `cat ${pairingPath} 2>/dev/null || true`],
        ),
      );
    } catch (error) {
      if (!isStoppedContainerExecError(error)) {
        throw error;
      }
      logWarn("cli", "vault-paseo-state-persist-skipped", {
        project: vault.identity.projectName,
        backend: vault.backend.kind,
        reason: "container-stopped-during-paseo-state-read",
      });
      return "stopped";
    }
  } else if (vault.backend.kind === "pod") {
    const scope = vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName);
    serverId = runCheckedCapture(
      "kubectl",
      ["-n", scope, "exec", `deployment/${scope}`, "--", "sh", "-lc", `cat ${serverIdPath} 2>/dev/null || true`],
    ).trim();
    pairing = readJsonObject(
      runCheckedCapture(
        "kubectl",
        ["-n", scope, "exec", `deployment/${scope}`, "--", "sh", "-lc", `cat ${pairingPath} 2>/dev/null || true`],
      ),
    );
  } else if (vault.backend.kind === "kubevirt-vm") {
    const snapshot = await readKubevirtPersistedPaseoState(vault);
    serverId = snapshot?.serverId ?? "";
    pairing = snapshot?.pairing ?? null;
  }

  if (!serverId || !pairing) {
    logWarn("cli", "vault-paseo-state-persist-skipped", {
      project: vault.identity.projectName,
      backend: vault.backend.kind,
      hasServerId: Boolean(serverId),
      hasPairing: Boolean(pairing),
      elapsedMs: Date.now() - startedAt,
    });
    return "skipped";
  }

  writeVaultPaseoServerId(vault.identity.projectName, serverId, vault.userProfile.id);
  writeVaultPaseoPairing(vault.identity.projectName, pairing, vault.userProfile.id);
  logInfo("cli", "vault-paseo-state-persisted", {
    project: vault.identity.projectName,
    backend: vault.backend.kind,
    serverId,
    elapsedMs: Date.now() - startedAt,
  });
  return "persisted";
}

export function loadVaultForProjectRef(
  projectRef: string,
  userProfileId?: string,
): VaultSpec {
  const resolved = resolveVaultConfigPath(projectRef, userProfileId);
  return loadVaultFromConfigPath(
    resolved.configPath,
    resolved.project,
    resolved.backendHint,
    resolved.profileHint,
  );
}

export function loadVaultForCommand(
  command: VaultCommandKind,
  projectRef: string,
  userProfileId?: string,
): {
  vault: VaultSpec;
  driver: ReturnType<typeof getBackendDriver>;
} {
  logInfo("cli", "load-vault", { command, projectRef, userProfileId });
  ensureVaultConfig(projectRef, userProfileId);
  const vault = loadVaultForProjectRef(projectRef, userProfileId);
  const driver = getBackendDriver(vault.backend.kind);
  logDebug("cli", "vault-loaded", {
    command,
    project: vault.identity.projectName,
    backend: vault.backend.kind,
    profile: vault.backend.profile,
  });
  return { vault, driver };
}

export async function loadExecutableVaultForCommand(
  command: VaultCommandKind,
  projectRef: string,
  userProfileId?: string,
): Promise<{
  vault: VaultSpec;
  driver: ReturnType<typeof getBackendDriver>;
}> {
  ensureProvisionedVault(projectRef, userProfileId);
  const { vault, driver } = loadVaultForCommand(command, projectRef, userProfileId);
  const preparedVault = await prepareEvolutionMemorySnapshot(vault);
  return { vault: preparedVault, driver };
}

export async function loadPreparedVaultForCommand(
  command: VaultCommandKind,
  projectRef: string,
  userProfileId?: string,
): Promise<{
  vault: VaultSpec;
  driver: ReturnType<typeof getBackendDriver>;
}> {
  const { vault, driver } = loadVaultForCommand(command, projectRef, userProfileId);
  const preparedVault = await prepareEvolutionMemorySnapshot(vault);
  return { vault: preparedVault, driver };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForVaultReady(
  vault: VaultSpec,
  timeoutMs = 120000,
  intervalMs = 1500,
): Promise<void> {
  const driver = getBackendDriver(vault.backend.kind);
  const startedAt = Date.now();
  let lastStatus: VaultStatus | null = null;
  let probe = 0;

  while (Date.now() - startedAt < timeoutMs) {
    probe += 1;
    const inspectStartedAt = Date.now();
    const observation = await driver.inspect(vault);
    const inspectElapsedMs = Date.now() - inspectStartedAt;
    let effectiveObservation = observation;
    let persistResult: "persisted" | "skipped" | "stopped" | "not-needed" = "not-needed";
    let persistElapsedMs = 0;
    if (vault.agent.enabled && observation.backend.exists && observation.backend.running) {
      const persistStartedAt = Date.now();
      persistResult = await persistVaultPaseoState(vault);
      persistElapsedMs = Date.now() - persistStartedAt;
      if (persistResult === "stopped") {
        effectiveObservation = {
          ...observation,
          backend: {
            ...observation.backend,
            running: false,
          },
        };
      }
    }
    const drift = computeVaultDrift(vault, effectiveObservation);
    const status = synthesizeVaultStatus(vault, effectiveObservation, drift);
    lastStatus = status;

    logDebug("cli", "start-probe", {
      project: vault.identity.projectName,
      backend: vault.backend.kind,
      runtimeLifecycle: status.driver?.status,
      paseoState: vault.agent.enabled ? persistResult : "disabled",
      reason: status.driver?.reason,
    });

    logVaultEvent("info", "readiness-probe", {
      userId: vault.userProfile.id,
      vault: vault.identity.projectName,
      ref: `${vault.identity.projectName}@${vault.backend.kind}`,
      backend: vault.backend.kind,
      profile: vault.backend.profile,
    }, {
      probe,
      elapsedMs: Date.now() - startedAt,
      inspectElapsedMs,
      persistElapsedMs,
      persistResult,
      backendExists: effectiveObservation.backend.exists,
      backendRunning: effectiveObservation.backend.running,
      runtimeLifecycle: status.driver?.status,
      paseoState: vault.agent.enabled ? persistResult : "disabled",
      reason: status.driver?.reason,
    });

    if (
      status.driver?.status === "running"
      && (!vault.agent.enabled || persistResult === "persisted")
    ) {
      logInfo("cli", "vault-ready", {
        project: vault.identity.projectName,
        backend: vault.backend.kind,
      });
      return;
    }

    await sleep(intervalMs);
  }

  logWarn("cli", "vault-not-ready-before-timeout", {
    project: vault.identity.projectName,
    backend: vault.backend.kind,
    runtimeLifecycle: lastStatus?.driver?.status,
    reason: lastStatus?.driver?.reason,
  });

  if (lastStatus) {
    throw new Error(
      `Vault '${vault.identity.projectName}' did not become ready within ${timeoutMs}ms (${lastStatus.driver?.selected?.backend ?? "unknown"}, runtimeLifecycle=${lastStatus.driver?.status ?? "unknown"}, reason=${lastStatus.driver?.reason ?? "unknown"})`,
    );
  }
  throw new Error(`Vault '${vault.identity.projectName}' did not become ready within ${timeoutMs}ms`);
}

export async function runVaultCommandWithEvolution<T>(params: {
  vault: VaultSpec;
  command: VaultCommandKind;
  execute: () => Promise<T>;
  onSuccessPayload?: (result: T) => Record<string, unknown>;
}): Promise<{ result: T; evolutionSessionId?: string }> {
  const { vault, command, execute, onSuccessPayload } = params;
  if (!vault.agent.enabled) {
    return { result: await execute() };
  }
  const sessionId = createEvolutionSessionId(command);
  await appendEvolutionEvent(vault, sessionId, "task-started", {
    command,
    backend: vault.backend.kind,
    project: vault.identity.projectName,
  });
  try {
    const result = await execute();
    await appendEvolutionEvent(vault, sessionId, "task-completed", {
      command,
      ...(onSuccessPayload ? onSuccessPayload(result) : {}),
    });
    await finalizeEvolutionSession(vault, sessionId);
    return { result, evolutionSessionId: sessionId };
  } catch (error) {
    await appendEvolutionEvent(vault, sessionId, "task-failed", {
      command,
      error: error instanceof Error ? error.message : String(error),
    });
    await finalizeEvolutionSession(vault, sessionId);
    throw error;
  }
}
