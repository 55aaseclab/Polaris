import fs from "node:fs";
import path from "node:path";
import { deleteAllManagedCredentialsForUser } from "../../config/credentials.js";
import { deleteUserMapEntriesForPolarisUserId } from "../../portal/user-map.js";
import { logInfo } from "../../utils/log.js";
import { resolveRepoRoot } from "../../utils/repo-root.js";

const REPO_ROOT = resolveRepoRoot(import.meta.url);

function profilePathFor(userProfileId: string): string {
  return path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
}

function userRootFor(userProfileId: string): string {
  return path.join(REPO_ROOT, "config", "users", userProfileId);
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
