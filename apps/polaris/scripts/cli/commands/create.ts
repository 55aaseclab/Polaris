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
import { readUserAccessSummary } from "../../portal/user-map.js";
import { ensureWorkspaceConfig } from "../../config/provision.js";
import { logInfo } from "../../utils/log.js";
import { polarisUsersRoot, repoRelativePath, repoRoot } from "../../utils/paths.js";
import { withWorkspaceMutationLock } from "../../utils/workspace-lifecycle-lock.js";
import { loadWorkspaceForProjectRef } from "./shared.js";

const REPO_ROOT = repoRoot(import.meta.url);
const USER_ROOT = polarisUsersRoot(import.meta.url);

function parseCreateArgs(argv: string[]): {
  projectRef: string;
  userProfileId: string;
  baseImage?: string;
} {
  const projectRef = argv[0]?.trim();
  const userFlagIndex = argv.findIndex((value) => value === "--user");
  const baseImageFlagIndex = argv.findIndex((value) => value === "--base-image");
  const userProfileId = userFlagIndex >= 0 ? argv[userFlagIndex + 1]?.trim() : "";
  if (!projectRef || !userProfileId) {
    throw new Error("Usage: pnpm --dir apps/polaris run polaris -- create <project> --user <userProfileId> [--base-image <image>]");
  }
  if (baseImageFlagIndex >= 0 && !argv[baseImageFlagIndex + 1]?.trim()) {
    throw new Error("--base-image requires an image reference");
  }
  return {
    projectRef,
    userProfileId,
    ...(baseImageFlagIndex >= 0 && argv[baseImageFlagIndex + 1]?.trim()
      ? { baseImage: argv[baseImageFlagIndex + 1].trim() }
      : {}),
  };
}

export async function createWorkspaceForUser(
  projectRef: string,
  userProfileId: string,
  options?: {
    baseImage?: string;
    line?: "coding" | "vertical";
  },
): Promise<void> {
  const { project, backendHint, profileHint } = parseWorkspaceReference(projectRef);
  assertProjectNameAvailableForUser(project, userProfileId);
  if (!userProfileExists(userProfileId)) {
    throw new Error(
      `User profile '${userProfileId}' was not found. Create it first with user create.`,
    );
  }
  if (workspaceConfigExists(project, userProfileId) && options?.baseImage) {
    throw new Error(
      `Workspace '${project}' already has saved specs for user '${userProfileId}'. --base-image applies only while scaffolding a new workspace.`,
    );
  }
  if (!workspaceConfigExists(project, userProfileId)) {
    const accessLine =
      options?.line
      ?? (readUserAccessSummary(userProfileId)?.line === "vertical" ? "vertical" : "coding");
    const scaffoldBackend =
      backendHint === "pod" || backendHint === "kubevirt-vm"
        ? backendHint
        : "docker";
    const outputPath = scaffoldDockerWorkspace(project, userProfileId, {
      baseImage: options?.baseImage,
      line: accessLine,
    });
    const defaultCredentialIds = listDefaultCredentialIds(userProfileId);
    const requestedRef =
      scaffoldBackend === "pod" && profileHint
        ? `${project}@${scaffoldBackend}:${profileHint}`
        : `${project}@${scaffoldBackend}`;
    const backendConfigPath =
      scaffoldBackend === "docker"
        ? outputPath
        : ensureWorkspaceConfig(requestedRef, userProfileId)?.configPath ??
          outputPath;
    const displayConfigPath = path.isAbsolute(backendConfigPath)
      ? backendConfigPath.replace(/\\/g, "/")
      : path.resolve(REPO_ROOT, backendConfigPath).replace(/\\/g, "/");
    logInfo("cli", "workspace-scaffolded", {
      project,
      backend: scaffoldBackend,
      configPath: displayConfigPath,
      userProfileId,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          project,
          backend: scaffoldBackend,
          created: "saved-spec",
          ...(options?.baseImage ? { baseImage: options.baseImage } : {}),
          configPath: displayConfigPath,
          userProfile: {
            id: userProfileId,
            created: false,
            profilePath: repoRelativePath(import.meta.url, path.join(USER_ROOT, "profiles", `${userProfileId}.yaml`)),
            secretsRoot: repoRelativePath(import.meta.url, path.join(USER_ROOT, userProfileId)),
          },
          credentials: {
            registryRoot: repoRelativePath(import.meta.url, path.join(USER_ROOT, userProfileId, "credentials")),
            defaults: defaultCredentialIds,
          },
          nextSteps: [
            `Stage credentials under ${repoRelativePath(import.meta.url, path.join(USER_ROOT, userProfileId))}/`,
            `pnpm --dir apps/polaris run polaris -- render ${project}@${scaffoldBackend}`,
            `pnpm --dir apps/polaris run polaris -- start ${project}@${scaffoldBackend}`,
          ],
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const workspace = loadWorkspaceForProjectRef(projectRef, userProfileId);
  logInfo("cli", "workspace-create-dispatch", {
    project: workspace.identity.projectName,
    backend: workspace.backend.kind,
  });
  await getBackendDriver(workspace.backend.kind).create(workspace);
}

export async function createCommand(argv: string[]): Promise<void> {
  const { projectRef, userProfileId, baseImage } = parseCreateArgs(argv);
  const { project } = parseWorkspaceReference(projectRef);
  await withWorkspaceMutationLock(
    import.meta.url,
    userProfileId,
    project,
    async () => createWorkspaceForUser(projectRef, userProfileId, { baseImage }),
  );
}
