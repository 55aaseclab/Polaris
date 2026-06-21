import { writeWorkspaceStatus } from "../../output/state-store.js";
import { buildReconcilePlan, computeWorkspaceDrift, synthesizeWorkspaceStatus } from "../../core/runtime-controller.js";
import { getEvolutionSummary } from "../../evolution/runtime.js";
import { loadExecutableWorkspaceForCommand, runWorkspaceCommandWithEvolution } from "./shared.js";
import { logInfo } from "../../utils/log.js";

export async function reconcileCommand(project: string): Promise<void> {
  const { workspace, driver } = await loadExecutableWorkspaceForCommand("reconcile", project);
  const observation = await driver.inspect(workspace);
  const drift = computeWorkspaceDrift(workspace, observation);
  const plan = buildReconcilePlan(workspace, drift);
  logInfo("cli", "reconcile-plan", {
    project: workspace.identity.projectName,
    backend: workspace.backend.kind,
    actions: plan.actions.map((action) => action.kind),
    safe: plan.safe,
  });
  const { evolutionSessionId } = await runWorkspaceCommandWithEvolution({
    workspace,
    command: "reconcile",
    execute: async () => {
      await driver.executeReconcilePlan(workspace, plan);
    },
    onSuccessPayload: () => ({
      reconcileActions: plan.actions.map((action) => action.kind),
    }),
  });
  const postObservation = await driver.inspect(workspace);
  const postDrift = computeWorkspaceDrift(workspace, postObservation);
  const status = synthesizeWorkspaceStatus(workspace, postObservation, postDrift, "reconcile");
  status.evolution = {
    ...(await getEvolutionSummary(workspace)),
    ...(evolutionSessionId ? { lastSessionId: evolutionSessionId } : {}),
  };
  const outputPath = writeWorkspaceStatus(status);
  process.stdout.write(`${JSON.stringify({ ...status, reconcilePlan: plan, statusFile: outputPath }, null, 2)}\n`);
}
