import {
  readPortalProfile,
  updatePortalProfile,
} from "../../core/portal.js";
import {
  readUserAccessSummary,
  type PolarisPlan,
  type PolarisRole,
  type PolarisSubscriptionLine,
  updateUserAccessEntry,
} from "../../portal/user-map.js";
import { withUserMutationLock } from "../../utils/user-mutation-lock.js";

function usage(): never {
  throw new Error(
    "Usage: pnpm --dir apps/polaris run polaris -- user update <userProfileId> [--name <name>] [--email <email>] [--github-account <account>] [--ssh-comment <comment>] [--role <admin|user>] [--plan <free|pro>] [--line <coding|vertical|both>]",
  );
}

function parseUpdateUserArgs(argv: string[]): {
  userId: string;
  profilePatch: {
    name?: string;
    email?: string;
    githubAccount?: string;
    sshComment?: string;
  };
  accessPatch: {
    role?: PolarisRole;
    plan?: PolarisPlan;
    line?: PolarisSubscriptionLine;
  };
} {
  const userId = argv[0]?.trim();
  const nameFlagIndex = argv.findIndex((value) => value === "--name");
  const emailFlagIndex = argv.findIndex((value) => value === "--email");
  const githubAccountFlagIndex = argv.findIndex(
    (value) => value === "--github-account",
  );
  const sshCommentFlagIndex = argv.findIndex(
    (value) => value === "--ssh-comment",
  );
  const roleFlagIndex = argv.findIndex((value) => value === "--role");
  const planFlagIndex = argv.findIndex((value) => value === "--plan");
  const lineFlagIndex = argv.findIndex((value) => value === "--line");

  if (!userId) {
    usage();
  }

  const profilePatch = {
    ...(nameFlagIndex >= 0 && argv[nameFlagIndex + 1] !== undefined
      ? { name: argv[nameFlagIndex + 1].trim() }
      : {}),
    ...(emailFlagIndex >= 0 && argv[emailFlagIndex + 1] !== undefined
      ? { email: argv[emailFlagIndex + 1].trim() }
      : {}),
    ...(githubAccountFlagIndex >= 0
      && argv[githubAccountFlagIndex + 1] !== undefined
      ? { githubAccount: argv[githubAccountFlagIndex + 1].trim() }
      : {}),
    ...(sshCommentFlagIndex >= 0 && argv[sshCommentFlagIndex + 1] !== undefined
      ? { sshComment: argv[sshCommentFlagIndex + 1].trim() }
      : {}),
  };

  const accessPatch = {
    ...(roleFlagIndex >= 0
      && (argv[roleFlagIndex + 1] === "admin"
        || argv[roleFlagIndex + 1] === "user")
      ? { role: argv[roleFlagIndex + 1] as PolarisRole }
      : {}),
    ...(planFlagIndex >= 0
      && (argv[planFlagIndex + 1] === "free"
        || argv[planFlagIndex + 1] === "pro")
      ? { plan: argv[planFlagIndex + 1] as PolarisPlan }
      : {}),
    ...(lineFlagIndex >= 0
      && (argv[lineFlagIndex + 1] === "coding"
        || argv[lineFlagIndex + 1] === "vertical"
        || argv[lineFlagIndex + 1] === "both")
      ? { line: argv[lineFlagIndex + 1] as PolarisSubscriptionLine }
      : {}),
  };

  if (
    Object.keys(profilePatch).length === 0
    && Object.keys(accessPatch).length === 0
  ) {
    throw new Error("At least one profile or access field is required");
  }

  return {
    userId,
    profilePatch,
    accessPatch,
  };
}

export async function updateUserCommand(argv: string[]): Promise<void> {
  const { userId, profilePatch, accessPatch } = parseUpdateUserArgs(argv);
  await withUserMutationLock(import.meta.url, userId, async () => {
    const currentProfile = readPortalProfile(userId);
    if (!currentProfile) {
      throw new Error(`User profile '${userId}' was not found`);
    }

    const updatedProfile =
      Object.keys(profilePatch).length > 0
        ? updatePortalProfile(userId, profilePatch)
        : currentProfile;
    const updatedAccess =
      Object.keys(accessPatch).length > 0
        ? await updateUserAccessEntry(userId, accessPatch)
        : readUserAccessSummary(userId);

    process.stdout.write(
      `${JSON.stringify(
        {
          userProfile: updatedProfile,
          access: updatedAccess,
        },
        null,
        2,
      )}\n`,
    );
  });
}
