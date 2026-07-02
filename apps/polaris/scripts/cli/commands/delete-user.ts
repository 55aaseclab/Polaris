import fs from "node:fs";
import path from "node:path";
import { withDeletedUserMapEntries } from "../../portal/user-map.js";
import { logInfo } from "../../utils/log.js";
import { polarisUsersRoot } from "../../utils/paths.js";
import { withUserMutationLock } from "../../utils/user-mutation-lock.js";

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

function copyIfExists(source: string, destination: string): boolean {
  if (!fs.existsSync(source)) {
    return false;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    force: true,
  });
  return true;
}

function restorePath(backupPath: string, targetPath: string): void {
  if (!fs.existsSync(backupPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return;
  }
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.cpSync(backupPath, targetPath, {
    recursive: true,
    force: true,
  });
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
  await withUserMutationLock(import.meta.url, userProfileId, async () => {
    const activeWorkspaces = listChildDirectories(activeWorkspacesRootFor(userProfileId));
    const archivedWorkspaces = listChildDirectories(archivedWorkspacesRootFor(userProfileId));
    if (
      activeWorkspaces.length > 0
      || archivedWorkspaces.length > 0
    ) {
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
    const rollbackRoot = fs.mkdtempSync(
      path.join(path.dirname(userRoot), `.delete-user-${userProfileId}-`),
    );
    const profileBackupPath = path.join(rollbackRoot, "profile.yaml");
    const userRootBackupPath = path.join(rollbackRoot, "user-root");
    const hadProfile = copyIfExists(profilePath, profileBackupPath);
    const hadUserRoot = copyIfExists(userRoot, userRootBackupPath);
    let removedMappings: {
      clerkUsernames: string[];
      clerkUserIds: string[];
    } = {
      clerkUsernames: [],
      clerkUserIds: [],
    };
    try {
      await withDeletedUserMapEntries(userProfileId, async (snapshot) => {
        removedMappings = {
          clerkUsernames: Object.keys(snapshot.clerkUsernameEntries),
          clerkUserIds: Object.keys(snapshot.clerkUserIdEntries),
        };
        fs.rmSync(profilePath, { force: true });
        fs.rmSync(userRoot, { recursive: true, force: true });
      });
    } catch (error) {
      if (hadProfile) {
        restorePath(profileBackupPath, profilePath);
      } else {
        fs.rmSync(profilePath, { force: true });
      }
      if (hadUserRoot) {
        restorePath(userRootBackupPath, userRoot);
      } else {
        fs.rmSync(userRoot, { recursive: true, force: true });
      }
      throw error;
    } finally {
      fs.rmSync(rollbackRoot, { recursive: true, force: true });
    }

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
            removed:
              removedProfile
              || removedUserRoot
              || removedMappings.clerkUsernames.length > 0
              || removedMappings.clerkUserIds.length > 0,
            profilePath: `config/users/profiles/${userProfileId}.yaml`,
            secretsRoot: `config/users/${userProfileId}`,
          },
          mappings: {
            removedClerkUsernames: removedMappings.clerkUsernames,
            removedClerkUserIds: removedMappings.clerkUserIds,
          },
        },
        null,
        2,
      )}\n`,
    );
  });
}
