import { loadWorkspace, parseWorkspaceReference } from "../../config/load.js";
import { getBackendDriver } from "../../backends/index.js";
import {
  ensureScaffoldUserProfile,
  scaffoldDockerWorkspace,
  workspaceConfigExists,
} from "../../config/scaffold.js";
import { logInfo } from "../../utils/log.js";

export async function createCommand(projectRef: string): Promise<void> {
  const { project, backendHint } = parseWorkspaceReference(projectRef);
  if (!workspaceConfigExists(project)) {
    const scaffoldBackend = backendHint === "pod" || backendHint === "kubevirt-vm" ? backendHint : "docker";
    if (scaffoldBackend !== "docker") {
      throw new Error(`Scaffolding for backend '${scaffoldBackend}' is not implemented yet; use '${project}@docker' or omit the backend selector`);
    }
    const userProfile = ensureScaffoldUserProfile();
    const outputPath = scaffoldDockerWorkspace(project, userProfile.id);
    logInfo("cli", "workspace-scaffolded", {
      project,
      backend: scaffoldBackend,
      configPath: outputPath,
      userProfileId: userProfile.id,
      userProfileCreated: userProfile.created,
    });
    process.stdout.write(`${JSON.stringify({
      project,
      backend: scaffoldBackend,
      created: "saved-spec",
      configPath: outputPath,
      userProfile: {
        id: userProfile.id,
        created: userProfile.created,
        profilePath: userProfile.profilePath,
        secretsRoot: userProfile.secretsRoot,
      },
      credentials: {
        registryRoot: `config/users/credentials/${userProfile.id}`,
        defaults: ["codex-default", "github-ssh"],
      },
      nextSteps: [
        `Stage credentials under ${userProfile.secretsRoot}/`,
        `pnpm --dir apps/polaris run polaris -- render ${project}@${scaffoldBackend}`,
        `pnpm --dir apps/polaris run polaris -- start ${project}@${scaffoldBackend}`,
      ],
    }, null, 2)}\n`);
    return;
  }
  const workspace = loadWorkspace(projectRef);
  logInfo("cli", "workspace-create-dispatch", {
    project: workspace.identity.projectName,
    backend: workspace.backend.kind,
  });
  await getBackendDriver(workspace.backend.kind).create(workspace);
}
