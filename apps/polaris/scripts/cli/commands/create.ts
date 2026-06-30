import path from "node:path";
import { parseWorkspaceReference } from "../../config/load.js";
import { assertProjectNameAvailableForUser } from "../../config/project-ownership.js";
import { getBackendDriver } from "../../backends/index.js";
import {
  listDefaultCredentialIds,
  scaffoldDockerWorkspace,
  userProfileExists,
  workspaceConfigExists,
} from "../../config/scaffold.js";
import { ensureWorkspaceConfig } from "../../config/provision.js";
import { logInfo } from "../../utils/log.js";
import { repoRoot } from "../../utils/paths.js";
import { loadWorkspaceForProjectRef } from "./shared.js";

const REPO_ROOT = repoRoot(import.meta.url);

function parseCreateArgs(argv: string[]): { projectRef: string; userProfileId: string } {
  const projectRef = argv[0]?.trim();
  const userFlagIndex = argv.findIndex((value) => value === "--user");
  const userProfileId = userFlagIndex >= 0 ? argv[userFlagIndex + 1]?.trim() : "";
  if (!projectRef || !userProfileId) {
    throw new Error("Usage: pnpm --dir apps/polaris run polaris -- create <project> --user <userProfileId>");
  }
  return { projectRef, userProfileId };
}

export async function createCommand(argv: string[]): Promise<void> {
  const { projectRef, userProfileId } = parseCreateArgs(argv);
  const { project, backendHint, profileHint } = parseWorkspaceReference(projectRef);
  assertProjectNameAvailableForUser(project, userProfileId);
  if (!userProfileExists(userProfileId)) {
    throw new Error(`User profile '${userProfileId}' was not found. Create it first with user create.`);
  }
  if (!workspaceConfigExists(project, userProfileId)) {
    const scaffoldBackend = backendHint === "pod" || backendHint === "kubevirt-vm" ? backendHint : "docker";
    const outputPath = scaffoldDockerWorkspace(project, userProfileId);
    const defaultCredentialIds = listDefaultCredentialIds(userProfileId);
    const requestedRef = scaffoldBackend === "pod" && profileHint
      ? `${project}@${scaffoldBackend}:${profileHint}`
      : `${project}@${scaffoldBackend}`;
    const backendConfigPath = scaffoldBackend === "docker"
      ? outputPath
      : ensureWorkspaceConfig(requestedRef, userProfileId)?.configPath ?? outputPath;
    const displayConfigPath = path.isAbsolute(backendConfigPath)
      ? backendConfigPath.replace(/\\/g, "/")
      : path.resolve(REPO_ROOT, backendConfigPath).replace(/\\/g, "/");
    logInfo("cli", "workspace-scaffolded", {
      project,
      backend: scaffoldBackend,
      configPath: displayConfigPath,
      userProfileId,
    });
    process.stdout.write(`${JSON.stringify({
      project,
      backend: scaffoldBackend,
      created: "saved-spec",
      configPath: displayConfigPath,
      userProfile: {
        id: userProfileId,
        created: false,
        profilePath: `config/users/profiles/${userProfileId}.yaml`,
        secretsRoot: `config/users/${userProfileId}`,
      },
      credentials: {
        registryRoot: `config/users/${userProfileId}/credentials`,
        defaults: defaultCredentialIds,
      },
      nextSteps: [
        `Stage credentials under config/users/${userProfileId}/`,
        `pnpm --dir apps/polaris run polaris -- render ${project}@${scaffoldBackend}`,
        `pnpm --dir apps/polaris run polaris -- start ${project}@${scaffoldBackend}`,
      ],
    }, null, 2)}\n`);
    return;
  }
  const workspace = loadWorkspaceForProjectRef(projectRef, userProfileId);
  logInfo("cli", "workspace-create-dispatch", {
    project: workspace.identity.projectName,
    backend: workspace.backend.kind,
  });
  await getBackendDriver(workspace.backend.kind).create(workspace);
}
