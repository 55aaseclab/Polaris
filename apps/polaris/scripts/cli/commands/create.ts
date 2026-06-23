import { loadWorkspace, parseWorkspaceReference } from "../../config/load.js";
import { assertProjectNameAvailable } from "../../config/project-ownership.js";
import { getBackendDriver } from "../../backends/index.js";
import {
  ensureScaffoldUserProfile,
  scaffoldDockerWorkspace,
  workspaceConfigExists,
} from "../../config/scaffold.js";
import { ensureWorkspaceConfig } from "../../config/provision.js";
import { logInfo } from "../../utils/log.js";

export async function createCommand(projectRef: string): Promise<void> {
  const { project, backendHint, profileHint } = parseWorkspaceReference(projectRef);
  assertProjectNameAvailable(project);
  if (!workspaceConfigExists(project)) {
    const scaffoldBackend = backendHint === "pod" || backendHint === "kubevirt-vm" ? backendHint : "docker";
    const userProfile = ensureScaffoldUserProfile();
    const outputPath = scaffoldDockerWorkspace(project, userProfile.id);
    const requestedRef = scaffoldBackend === "pod" && profileHint
      ? `${project}@${scaffoldBackend}:${profileHint}`
      : `${project}@${scaffoldBackend}`;
    const backendConfigPath = scaffoldBackend === "docker"
      ? outputPath
      : ensureWorkspaceConfig(requestedRef)?.configPath ?? outputPath;
    logInfo("cli", "workspace-scaffolded", {
      project,
      backend: scaffoldBackend,
      configPath: backendConfigPath,
      userProfileId: userProfile.id,
      userProfileCreated: userProfile.created,
    });
    process.stdout.write(`${JSON.stringify({
      project,
      backend: scaffoldBackend,
      created: "saved-spec",
      configPath: backendConfigPath,
      userProfile: {
        id: userProfile.id,
        created: userProfile.created,
        profilePath: userProfile.profilePath,
        secretsRoot: userProfile.secretsRoot,
      },
      credentials: {
        registryRoot: `config/users/${userProfile.id}/credentials`,
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
