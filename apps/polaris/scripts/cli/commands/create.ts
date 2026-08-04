import path from "node:path";
import { parseVaultReference } from "../../config/load.js";
import { assertProjectNameAvailableForUser } from "../../config/project-ownership.js";
import { getBackendDriver } from "../../backends/index.js";
import {
  listDefaultCredentialIds,
  scaffoldDockerVault,
  userProfileExists,
  vaultConfigExists,
} from "../../config/scaffold.js";
import { readUserAccessSummary } from "../../portal/user-map.js";
import { ensureVaultConfig } from "../../config/provision.js";
import { logInfo } from "../../utils/log.js";
import { polarisUsersRoot, repoRelativePath, repoRoot } from "../../utils/paths.js";
import { withVaultMutationLock } from "../../utils/vault-lifecycle-lock.js";
import { loadVaultForProjectRef } from "./shared.js";

const REPO_ROOT = repoRoot(import.meta.url);
const USER_ROOT = polarisUsersRoot(import.meta.url);

function parseCreateArgs(argv: string[]): {
  projectRef: string;
  userProfileId: string;
  baseImage?: string;
  testWanghaiOnly: boolean;
} {
  const projectRef = argv[0]?.trim();
  const userFlagIndex = argv.findIndex((value) => value === "--user");
  const baseImageFlagIndex = argv.findIndex((value) => value === "--base-image");
  const testWanghaiOnly = argv.includes("--test-wanghai-only");
  const userProfileId = userFlagIndex >= 0 ? argv[userFlagIndex + 1]?.trim() : "";
  if (!projectRef || !userProfileId) {
    throw new Error("Usage: pnpm --dir apps/polaris run polaris -- create <project> --user <userProfileId> [--base-image <image>] [--test-wanghai-only]");
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
    testWanghaiOnly,
  };
}

export async function createVaultForUser(
  projectRef: string,
  userProfileId: string,
  options?: {
    baseImage?: string;
    line?: "coding" | "vertical";
    testWanghaiOnly?: boolean;
  },
): Promise<void> {
  const { project, backendHint, profileHint } = parseVaultReference(projectRef);
  assertProjectNameAvailableForUser(project, userProfileId);
  if (!userProfileExists(userProfileId)) {
    throw new Error(
      `User profile '${userProfileId}' was not found. Create it first with user create.`,
    );
  }
  if (vaultConfigExists(project, userProfileId) && (options?.baseImage || options?.testWanghaiOnly)) {
    throw new Error(
      `Vault '${project}' already has saved specs for user '${userProfileId}'. --base-image and --test-wanghai-only apply only while scaffolding a new vault.`,
    );
  }
  if (!vaultConfigExists(project, userProfileId)) {
    if (options?.testWanghaiOnly && backendHint && backendHint !== "docker") {
      throw new Error("--test-wanghai-only requires the Docker backend");
    }
    const accessLine =
      options?.testWanghaiOnly
        ? "vertical"
        : options?.line
      ?? (readUserAccessSummary(userProfileId)?.line === "vertical" ? "vertical" : "coding");
    const scaffoldBackend =
      options?.testWanghaiOnly
        ? "docker"
        : backendHint === "pod" || backendHint === "kubevirt-vm"
        ? backendHint
        : "docker";
    const outputPath = scaffoldDockerVault(project, userProfileId, {
      baseImage: options?.baseImage,
      line: accessLine,
      paseoFreeWanghaiTest: options?.testWanghaiOnly,
    });
    const defaultCredentialIds = listDefaultCredentialIds(userProfileId);
    const requestedRef =
      scaffoldBackend === "pod" && profileHint
        ? `${project}@${scaffoldBackend}:${profileHint}`
        : `${project}@${scaffoldBackend}`;
    const backendConfigPath =
      scaffoldBackend === "docker"
        ? outputPath
        : ensureVaultConfig(requestedRef, userProfileId)?.configPath ??
          outputPath;
    const displayConfigPath = path.isAbsolute(backendConfigPath)
      ? backendConfigPath.replace(/\\/g, "/")
      : path.resolve(REPO_ROOT, backendConfigPath).replace(/\\/g, "/");
    logInfo("cli", "vault-scaffolded", {
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
          ...(options?.testWanghaiOnly ? { testWanghaiOnly: true } : {}),
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
  const vault = loadVaultForProjectRef(projectRef, userProfileId);
  logInfo("cli", "vault-create-dispatch", {
    project: vault.identity.projectName,
    backend: vault.backend.kind,
  });
  await getBackendDriver(vault.backend.kind).create(vault);
}

export async function createCommand(argv: string[]): Promise<void> {
  const { projectRef, userProfileId, baseImage, testWanghaiOnly } = parseCreateArgs(argv);
  const { project } = parseVaultReference(projectRef);
  await withVaultMutationLock(
    import.meta.url,
    userProfileId,
    project,
    async () => createVaultForUser(projectRef, userProfileId, { baseImage, testWanghaiOnly }),
  );
}
