import { loadWorkspace } from "../../config/load.js";
import { getBackendDriver } from "../../backends/index.js";
import { writeWorkspaceStatus } from "../../output/state-store.js";
import { buildReconcilePlan, computeWorkspaceDrift, synthesizeWorkspaceStatus } from "../../core/runtime-controller.js";

export async function reconcileCommand(project: string): Promise<void> {
  const workspace = loadWorkspace(project);
  const driver = getBackendDriver(workspace.backend.kind);
  const observation = await driver.inspect(workspace);
  const drift = computeWorkspaceDrift(workspace, observation);
  const plan = buildReconcilePlan(workspace, drift);
  await driver.executeReconcilePlan(workspace, plan);
  const postObservation = await driver.inspect(workspace);
  const postDrift = computeWorkspaceDrift(workspace, postObservation);
  const status = synthesizeWorkspaceStatus(workspace, postObservation, postDrift, "reconcile");
  const outputPath = writeWorkspaceStatus(status);
  process.stdout.write(`${JSON.stringify({ ...status, reconcilePlan: plan, statusFile: outputPath }, null, 2)}\n`);
}
