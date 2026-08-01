import {
  readUserWorkspaceDefaults,
  setUserWorkspaceDefaults,
  userProfileExists,
} from "../../config/scaffold.js";
import { withUserMutationLock } from "../../utils/user-mutation-lock.js";

function usage(): never {
  throw new Error(
    "Usage: pnpm --dir apps/polaris run polaris -- user defaults <read|set> <userProfileId> [--docker-base-image <image> | --clear-docker-base-image]",
  );
}

function requireUserProfile(userProfileId: string): void {
  if (!userProfileExists(userProfileId)) {
    throw new Error(`User profile '${userProfileId}' was not found. Create it first with user create.`);
  }
}

function renderDefaultsPayload(userProfileId: string): string {
  const defaults = readUserWorkspaceDefaults(userProfileId);
  return `${JSON.stringify({
    userProfile: {
      id: userProfileId,
      profilePath: `config/users/profiles/${userProfileId}.yaml`,
    },
    workspaceDefaults: {
      docker: {
        runtime: {
          baseImage: defaults.dockerBaseImage,
        },
      },
    },
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
  dockerBaseImage: string | null;
} {
  const userProfileId = argv[0]?.trim();
  const baseImageFlagIndex = argv.findIndex((value) => value === "--docker-base-image");
  const clearBaseImage = argv.includes("--clear-docker-base-image");
  if (!userProfileId) {
    usage();
  }
  const dockerBaseImage =
    baseImageFlagIndex >= 0 && argv[baseImageFlagIndex + 1]?.trim()
      ? argv[baseImageFlagIndex + 1].trim()
      : null;
  if (dockerBaseImage && clearBaseImage) {
    throw new Error("Choose either --docker-base-image or --clear-docker-base-image, not both.");
  }
  if (!dockerBaseImage && !clearBaseImage) {
    throw new Error("Set requires --docker-base-image <image> or --clear-docker-base-image.");
  }
  return {
    userProfileId,
    dockerBaseImage,
  };
}

export async function setUserDefaultsCommand(argv: string[]): Promise<void> {
  const { userProfileId, dockerBaseImage } = parseSetArgs(argv);
  requireUserProfile(userProfileId);
  await withUserMutationLock(import.meta.url, userProfileId, async () => {
    setUserWorkspaceDefaults(userProfileId, {
      dockerBaseImage,
    });
    process.stdout.write(renderDefaultsPayload(userProfileId));
  });
}
