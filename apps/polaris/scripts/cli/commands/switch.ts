import { getBackendDriver } from "../../backends/index.js";
import { loadWorkspace, parseWorkspaceReference } from "../../config/load.js";
import type { WorkspaceSpec } from "../../core/workspace.js";
import { readWorkspaceDriverSelection, writeWorkspaceDriverSelection } from "../../output/state-store.js";
import { logInfo } from "../../utils/log.js";
import { loadExecutableWorkspaceForCommand, waitForWorkspaceReady } from "./shared.js";

const SUPPORTED_BACKENDS: Array<WorkspaceSpec["backend"]["kind"]> = [
  "docker",
  "pod",
  "kubevirt-vm",
];

function loadWorkspaceForBackend(project: string, backend: WorkspaceSpec["backend"]["kind"]): WorkspaceSpec | null {
  try {
    return loadWorkspace(`${project}@${backend}`);
  } catch (error) {
    if (error instanceof Error && /Config not found/.test(error.message)) {
      return null;
    }
    throw error;
  }
}

async function stopCompetingBackends(project: string, targetBackend: WorkspaceSpec["backend"]["kind"]): Promise<WorkspaceSpec["backend"]["kind"][]> {
  const stopped: WorkspaceSpec["backend"]["kind"][] = [];
  for (const backend of SUPPORTED_BACKENDS) {
    if (backend === targetBackend) {
      continue;
    }
    const workspace = loadWorkspaceForBackend(project, backend);
    if (!workspace) {
      continue;
    }
    const driver = getBackendDriver(workspace.backend.kind);
    const observation = await driver.inspect(workspace);
    if (!observation.backend.exists && !observation.backend.running) {
      continue;
    }
    logInfo("cli", "switch-stop-previous-backend", {
      project,
      fromBackend: backend,
      toBackend: targetBackend,
    });
    await driver.stop(workspace);
    stopped.push(backend);
  }
  return stopped;
}

export async function switchCommand(projectRef: string): Promise<void> {
  const { project, backendHint, profileHint } = parseWorkspaceReference(projectRef);
  if (!backendHint || !SUPPORTED_BACKENDS.includes(backendHint)) {
    throw new Error("Usage: pnpm --dir apps/polaris run polaris -- switch <project>@<docker|pod|kubevirt-vm>[:driver]");
  }

  const previousSelection = readWorkspaceDriverSelection(project);
  const previousBackend = previousSelection?.backend;
  const stoppedBackends = await stopCompetingBackends(project, backendHint);
  const selectionFile = writeWorkspaceDriverSelection(project, {
    backend: backendHint,
    profile: backendHint === "pod" ? profileHint : undefined,
  });
  const targetRef = backendHint === "pod" && profileHint
    ? `${project}@${backendHint}:${profileHint}`
    : `${project}@${backendHint}`;
  const { workspace, driver } = await loadExecutableWorkspaceForCommand("start", targetRef);
  await driver.start(workspace);
  await waitForWorkspaceReady(workspace);

  process.stdout.write(`${JSON.stringify({
    project,
    previousBackend: previousBackend ?? null,
    previousProfile: previousSelection?.profile ?? null,
    selectedBackend: backendHint,
    selectedProfile: backendHint === "pod" ? (profileHint ?? workspace.backend.profile) : null,
    stoppedBackends,
    selectionFile,
  }, null, 2)}\n`);
}
