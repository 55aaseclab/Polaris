import { scaffoldUserProfileById } from "../../config/scaffold.js";
import { logInfo } from "../../utils/log.js";
import {
  type PolarisPlan,
  type PolarisRole,
  upsertUserMapEntry,
} from "../../portal/user-map.js";

function parseCreateUserArgs(argv: string[]): {
  userProfileId: string;
  name?: string;
  email?: string;
  clerkUsername?: string;
  role?: PolarisRole;
  plan?: PolarisPlan;
} {
  const userProfileId = argv[0]?.trim();
  const nameFlagIndex = argv.findIndex((value) => value === "--name");
  const emailFlagIndex = argv.findIndex((value) => value === "--email");
  const clerkFlagIndex = argv.findIndex((value) => value === "--clerk");
  const roleFlagIndex = argv.findIndex((value) => value === "--role");
  const planFlagIndex = argv.findIndex((value) => value === "--plan");
  if (!userProfileId) {
    throw new Error("Usage: pnpm --dir apps/polaris run polaris -- create-user <userProfileId> [--name <name>] [--email <email>] [--clerk <username>] [--role <admin|user>] [--plan <free|pro>]");
  }
  return {
    userProfileId,
    ...(nameFlagIndex >= 0 && argv[nameFlagIndex + 1]?.trim() ? { name: argv[nameFlagIndex + 1].trim() } : {}),
    ...(emailFlagIndex >= 0 && argv[emailFlagIndex + 1]?.trim() ? { email: argv[emailFlagIndex + 1].trim() } : {}),
    ...(clerkFlagIndex >= 0 && argv[clerkFlagIndex + 1]?.trim() ? { clerkUsername: argv[clerkFlagIndex + 1].trim().toLowerCase() } : {}),
    ...(roleFlagIndex >= 0 && (argv[roleFlagIndex + 1] === "admin" || argv[roleFlagIndex + 1] === "user")
      ? { role: argv[roleFlagIndex + 1] as PolarisRole }
      : {}),
    ...(planFlagIndex >= 0 && (argv[planFlagIndex + 1] === "free" || argv[planFlagIndex + 1] === "pro")
      ? { plan: argv[planFlagIndex + 1] as PolarisPlan }
      : {}),
  };
}

export async function createUserCommand(argv: string[]): Promise<void> {
  const { userProfileId, name, email, clerkUsername, role, plan } = parseCreateUserArgs(argv);
  const created = scaffoldUserProfileById({
    id: userProfileId,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
  });
  if (clerkUsername) {
    upsertUserMapEntry(clerkUsername, {
      polarisUserId: created.id,
      role: role ?? "user",
      plan: plan ?? "free",
    });
  }
  logInfo("cli", "user-profile-scaffolded", {
    userProfileId: created.id,
    created: created.created,
  });
  process.stdout.write(`${JSON.stringify({
    userProfile: {
      id: created.id,
      created: created.created,
      profilePath: created.profilePath,
      secretsRoot: created.secretsRoot,
      name: created.name,
      email: created.email,
    },
    credentials: {
      registryRoot: `config/users/${created.id}/credentials`,
      defaults: ["codex-default", "github-ssh"],
    },
  }, null, 2)}\n`);
}
