import { scaffoldUserProfileById } from "../../config/scaffold.js";
import { ensureRequiredProfileCredentials } from "../../config/credentials.js";
import { logInfo } from "../../utils/log.js";
import {
  type PolarisPlan,
  type PolarisRole,
  upsertUserMapEntry,
  upsertUserMapUserId,
} from "../../portal/user-map.js";

function bootstrapAdminTokens(): Set<string> {
  return new Set(
    String(process.env.POLARIS_BOOTSTRAP_ADMIN_USERS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function resolveDefaultRole(args: {
  userProfileId: string;
  clerkUsername?: string;
  clerkUserId?: string;
  role?: PolarisRole;
}): PolarisRole {
  if (args.role) {
    return args.role;
  }
  const overrides = bootstrapAdminTokens();
  const matches = [
    args.userProfileId,
    args.clerkUsername ?? "",
    args.clerkUserId ?? "",
  ].some((value) => overrides.has(value.trim().toLowerCase()));
  return matches ? "admin" : "user";
}

function parseCreateUserArgs(argv: string[]): {
  userProfileId: string;
  name?: string;
  email?: string;
  clerkUsername?: string;
  clerkUserId?: string;
  role?: PolarisRole;
  plan?: PolarisPlan;
} {
  const userProfileId = argv[0]?.trim();
  const nameFlagIndex = argv.findIndex((value) => value === "--name");
  const emailFlagIndex = argv.findIndex((value) => value === "--email");
  const clerkFlagIndex = argv.findIndex((value) => value === "--clerk");
  const clerkUserIdFlagIndex = argv.findIndex((value) => value === "--clerk-user-id");
  const roleFlagIndex = argv.findIndex((value) => value === "--role");
  const planFlagIndex = argv.findIndex((value) => value === "--plan");
  if (!userProfileId) {
    throw new Error("Usage: pnpm --dir apps/polaris run polaris -- user create <userProfileId> [--name <name>] [--email <email>] [--clerk <username>] [--clerk-user-id <id>] [--role <admin|user>] [--plan <free|pro>]");
  }
  return {
    userProfileId,
    ...(nameFlagIndex >= 0 && argv[nameFlagIndex + 1]?.trim() ? { name: argv[nameFlagIndex + 1].trim() } : {}),
    ...(emailFlagIndex >= 0 && argv[emailFlagIndex + 1]?.trim() ? { email: argv[emailFlagIndex + 1].trim() } : {}),
    ...(clerkFlagIndex >= 0 && argv[clerkFlagIndex + 1]?.trim() ? { clerkUsername: argv[clerkFlagIndex + 1].trim().toLowerCase() } : {}),
    ...(clerkUserIdFlagIndex >= 0 && argv[clerkUserIdFlagIndex + 1]?.trim() ? { clerkUserId: argv[clerkUserIdFlagIndex + 1].trim() } : {}),
    ...(roleFlagIndex >= 0 && (argv[roleFlagIndex + 1] === "admin" || argv[roleFlagIndex + 1] === "user")
      ? { role: argv[roleFlagIndex + 1] as PolarisRole }
      : {}),
    ...(planFlagIndex >= 0 && (argv[planFlagIndex + 1] === "free" || argv[planFlagIndex + 1] === "pro")
      ? { plan: argv[planFlagIndex + 1] as PolarisPlan }
      : {}),
  };
}

export async function createUserCommand(argv: string[]): Promise<void> {
  const { userProfileId, name, email, clerkUsername, clerkUserId, role, plan } = parseCreateUserArgs(argv);
  const resolvedRole = resolveDefaultRole({
    userProfileId,
    clerkUsername,
    clerkUserId,
    role,
  });
  const created = scaffoldUserProfileById({
    id: userProfileId,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
  });
  const defaultCredentials = ensureRequiredProfileCredentials(created.id);
  if (clerkUsername) {
    await upsertUserMapEntry(clerkUsername, {
      polarisUserId: created.id,
      role: resolvedRole,
      plan: plan ?? "free",
    });
  }
  if (clerkUserId) {
    await upsertUserMapUserId(clerkUserId, {
      polarisUserId: created.id,
      role: resolvedRole,
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
      defaults: defaultCredentials.map((credential) => credential.id),
    },
  }, null, 2)}\n`);
}
