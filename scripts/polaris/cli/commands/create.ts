import { loadWorkspace, parseWorkspaceReference } from "../../config/load.js";
import { getBackendDriver } from "../../backends/index.js";
import { scaffoldDockerWorkspace, workspaceConfigExists } from "../../config/scaffold.js";

export async function createCommand(projectRef: string): Promise<void> {
  const { project, backendHint } = parseWorkspaceReference(projectRef);
  if (!workspaceConfigExists(project)) {
    const scaffoldBackend = backendHint === "pod" || backendHint === "kubevirt-vm" ? backendHint : "docker";
    if (scaffoldBackend !== "docker") {
      throw new Error(`Scaffolding for backend '${scaffoldBackend}' is not implemented yet; use '${project}@docker' or omit the backend selector`);
    }
    const outputPath = scaffoldDockerWorkspace(project);
    process.stdout.write(`${JSON.stringify({
      project,
      backend: scaffoldBackend,
      created: "saved-spec",
      configPath: outputPath,
      nextSteps: [
        `Stage credentials under secrets/polaris/`,
        `pnpm exec tsx scripts/polaris.ts render ${project}@${scaffoldBackend}`,
        `pnpm exec tsx scripts/polaris.ts start ${project}@${scaffoldBackend}`,
      ],
    }, null, 2)}\n`);
    return;
  }
  const workspace = loadWorkspace(projectRef);
  await getBackendDriver(workspace.backend.kind).create(workspace);
}
