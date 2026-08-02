import {
  normalizeVaultStatus,
  vaultStatusPath,
  writeVaultStatus,
} from "../../output/state-store.js";
import { computeVaultDrift, synthesizeVaultStatus } from "../../core/runtime-controller.js";
import { buildStatusAssets } from "../../core/status-assets.js";
import type { VaultStatus } from "../../core/vault.js";
import { appendEvolutionEvent, createEvolutionSessionId, finalizeEvolutionSession, getEvolutionSummary } from "../../evolution/runtime.js";
import { loadVaultForCommand, persistVaultPaseoState } from "./shared.js";
import { logInfo } from "../../utils/log.js";
import { measureVaultPhase } from "../../utils/vault-log.js";

export async function synthesizeAndWriteVaultStatus(
  project: string,
  userProfileId?: string,
  options?: {
    write?: boolean;
  },
): Promise<{
  outputPath: string;
  status: VaultStatus;
}> {
  const { vault, driver } = loadVaultForCommand("status", project, userProfileId);
  const evolutionSessionId = vault.agent.enabled ? createEvolutionSessionId("status") : undefined;
  const observation = await measureVaultPhase({
    context: {
      userId: vault.userProfile.id,
      vault: vault.identity.projectName,
      backend: vault.backend.kind,
      profile: vault.backend.profile,
    },
    phase: "inspect-vault",
    execute: () => driver.inspect(vault),
  });
  let effectiveObservation = observation;
  if (vault.agent.enabled && observation.backend.exists && observation.backend.running) {
    const persistResult = await persistVaultPaseoState(vault);
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
  status.assets = buildStatusAssets(vault);
  if (evolutionSessionId) {
    await appendEvolutionEvent(vault, evolutionSessionId, "task-completed", {
      command: "status",
      runtimeLifecycle: status.driver?.status,
      reason: status.driver?.reason,
    });
    await finalizeEvolutionSession(vault, evolutionSessionId);
    status.evolution = {
      ...(await getEvolutionSummary(vault)),
      lastSessionId: evolutionSessionId,
    };
  }
  const outputPath = vaultStatusPath(status.project, vault.userProfile.id);
  if (options?.write === false) {
    return {
      outputPath,
      status: normalizeVaultStatus(status),
    };
  }
  writeVaultStatus(status, vault.userProfile.id);
  return {
    outputPath,
    status: normalizeVaultStatus(status),
  };
}

export async function statusCommand(project: string, userProfileId?: string): Promise<void> {
  const { outputPath, status } = await synthesizeAndWriteVaultStatus(project, userProfileId);
  logInfo("cli", "status-synthesized", {
    project: status.project,
    backend: status.driver?.selected?.backend,
    runtimeLifecycle: status.driver?.status,
    statusFile: outputPath,
  });
  process.stdout.write(`${JSON.stringify({ ...status, statusFile: outputPath }, null, 2)}\n`);
}
