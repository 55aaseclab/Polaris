import { writeWorkspaceStatus } from "../../output/state-store.js";
import { buildReconcilePlan, computeWorkspaceDrift, synthesizeWorkspaceStatus } from "../../core/runtime-controller.js";
import { loadWorkspaceForCommand } from "./shared.js";
import { logInfo } from "../../utils/log.js";

export async function reconcileCommand(project: string): Promise<void> {
  const { workspace, driver } = loadWorkspaceForCommand("reconcile", project);
  const observation = await driver.inspect(workspace);
  const drift = computeWorkspaceDrift(workspace, observation);
  const plan = buildReconcilePlan(workspace, drift);
  logInfo("cli", "reconcile-plan", {
    project: workspace.identity.projectName,
    backend: workspace.backend.kind,
    actions: plan.actions.map((action) => action.kind),
    safe: plan.safe,
  });
  await driver.executeReconcilePlan(workspace, plan);
  const postObservation = await driver.inspect(workspace);
  const postDrift = computeWorkspaceDrift(workspace, postObservation);
  const status = synthesizeWorkspaceStatus(workspace, postObservation, postDrift, "reconcile");
  const outputPath = writeWorkspaceStatus(status);
  process.stdout.write(`${JSON.stringify({ ...status, reconcilePlan: plan, statusFile: outputPath }, null, 2)}\n`);
}
