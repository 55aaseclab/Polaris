import path from "node:path";
import {
  readUserVaultDefaults,
  userProfileExists,
} from "../../config/scaffold.js";
import { polarisUsersRoot, repoRelativePath } from "../../utils/paths.js";

const USER_ROOT = polarisUsersRoot(import.meta.url);

function usage(): never {
  throw new Error(
    "Usage: pnpm --dir apps/polaris run polaris -- user defaults read <userProfileId>",
  );
}

function requireUserProfile(userProfileId: string): void {
  if (!userProfileExists(userProfileId)) {
    throw new Error(`User profile '${userProfileId}' was not found. Create it first with user create.`);
  }
}

function renderDefaultsPayload(userProfileId: string): string {
  const defaults = readUserVaultDefaults(userProfileId);
  return `${JSON.stringify({
    userProfile: {
      id: userProfileId,
      profilePath: repoRelativePath(import.meta.url, path.join(USER_ROOT, "profiles", `${userProfileId}.yaml`)),
    },
    vaultDefaults: defaults,
  }, null, 2)}\n`;
}

export async function readUserDefaultsCommand(argv: string[]): Promise<void> {
  const userProfileId = argv[0]?.trim();
  if (!userProfileId || argv.length !== 1) {
    usage();
  }
  requireUserProfile(userProfileId);
  process.stdout.write(renderDefaultsPayload(userProfileId));
}

function parseSetArgs(argv: string[]): {
  userProfileId: string;
} {
  const userProfileId = argv[0]?.trim();
  if (!userProfileId || argv.length !== 1) {
    usage();
  }
  return {
    userProfileId,
  };
}

export async function setUserDefaultsCommand(argv: string[]): Promise<void> {
  parseSetArgs(argv);
  throw new Error("Polaris no longer stores a user default docker base image.");
}
