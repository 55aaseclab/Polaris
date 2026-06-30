import fs from "node:fs";
import path from "node:path";
import { deleteAllManagedCredentialsForUser } from "../../config/credentials.js";
import { deleteUserMapEntriesForPolarisUserId } from "../../portal/user-map.js";
import { logInfo } from "../../utils/log.js";
import { polarisUsersRoot } from "../../utils/paths.js";

const USER_ROOT = polarisUsersRoot(import.meta.url);

function profilePathFor(userProfileId: string): string {
  return path.join(USER_ROOT, "profiles", `${userProfileId}.yaml`);
}

function userRootFor(userProfileId: string): string {
  return path.join(USER_ROOT, userProfileId);
}

function activeWorkspacesRootFor(userProfileId: string): string {
  return path.join(USER_ROOT, userProfileId, "workspaces");
}

function archivedWorkspacesRootFor(userProfileId: string): string {
  return path.join(USER_ROOT, userProfileId, "archives", "workspaces");
}

function listChildDirectories(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function parseDeleteUserArgs(argv: string[]): { userProfileId: string } {
  const userProfileId = argv[0]?.trim();
  if (!userProfileId) {
    throw new Error(
      "Usage: pnpm --dir apps/polaris run polaris -- user delete <userProfileId>",
    );
  }
  return { userProfileId };
}

export async function deleteUserCommand(argv: string[]): Promise<void> {
  const { userProfileId } = parseDeleteUserArgs(argv);
  const profilePath = profilePathFor(userProfileId);
  const userRoot = userRootFor(userProfileId);
  const activeWorkspaces = listChildDirectories(activeWorkspacesRootFor(userProfileId));
  const archivedWorkspaces = listChildDirectories(archivedWorkspacesRootFor(userProfileId));
  if (activeWorkspaces.length > 0 || archivedWorkspaces.length > 0) {
    throw new Error(
      [
        `User '${userProfileId}' cannot be deleted while workspace data still exists.`,
        activeWorkspaces.length > 0
          ? `Active workspaces: ${activeWorkspaces.join(", ")}`
          : null,
        archivedWorkspaces.length > 0
          ? `Archived workspaces: ${archivedWorkspaces.join(", ")}`
          : null,
        "Archive or delete active workspaces first, then clear archived workspaces explicitly.",
      ].filter(Boolean).join(" "),
    );
  }
  const removedProfile = fs.existsSync(profilePath);
  const removedUserRoot = fs.existsSync(userRoot);
  if (removedUserRoot) {
    deleteAllManagedCredentialsForUser(userProfileId);
  }
  const removedMappings = deleteUserMapEntriesForPolarisUserId(userProfileId);

  fs.rmSync(profilePath, { force: true });
  fs.rmSync(userRoot, { recursive: true, force: true });

  logInfo("cli", "user-profile-deleted", {
    userProfileId,
    removedProfile,
    removedUserRoot,
    removedMappings,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        userProfile: {
          id: userProfileId,
          removed: removedProfile || removedUserRoot || removedMappings.length > 0,
          profilePath: `config/users/profiles/${userProfileId}.yaml`,
          secretsRoot: `config/users/${userProfileId}`,
        },
        mappings: {
          removedClerkUsernames: removedMappings,
        },
      },
      null,
      2,
    )}\n`,
  );
}
