import { writeVaultStatus } from "../../output/state-store.js";
import { buildReconcilePlan, computeVaultDrift, synthesizeVaultStatus } from "../../core/runtime-controller.js";
import { getEvolutionSummary } from "../../evolution/runtime.js";
import { loadExecutableVaultForCommand, runVaultCommandWithEvolution } from "./shared.js";
import { logInfo } from "../../utils/log.js";

export async function reconcileCommand(project: string, userProfileId?: string): Promise<void> {
  const { vault, driver } = await loadExecutableVaultForCommand("reconcile", project, userProfileId);
  const observation = await driver.inspect(vault);
  const drift = computeVaultDrift(vault, observation);
  const plan = buildReconcilePlan(vault, drift);
  logInfo("cli", "reconcile-plan", {
    project: vault.identity.projectName,
    backend: vault.backend.kind,
    actions: plan.actions.map((action) => action.kind),
    safe: plan.safe,
  });
  const { evolutionSessionId } = await runVaultCommandWithEvolution({
    vault,
    command: "reconcile",
    execute: async () => {
      await driver.executeReconcilePlan(vault, plan);
    },
    onSuccessPayload: () => ({
      reconcileActions: plan.actions.map((action) => action.kind),
    }),
  });
  const postObservation = await driver.inspect(vault);
  const postDrift = computeVaultDrift(vault, postObservation);
  const status = synthesizeVaultStatus(vault, postObservation, postDrift);
  status.evolution = {
    ...(await getEvolutionSummary(vault)),
    ...(evolutionSessionId ? { lastSessionId: evolutionSessionId } : {}),
  };
  const outputPath = writeVaultStatus(status, vault.userProfile.id);
  process.stdout.write(`${JSON.stringify({ ...status, reconcilePlan: plan, statusFile: outputPath }, null, 2)}\n`);
}
