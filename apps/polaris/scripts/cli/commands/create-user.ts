import fs from "node:fs";
import path from "node:path";
import { scaffoldUserProfileById } from "../../config/scaffold.js";
import { ensureRequiredProfileCredentials } from "../../config/credentials.js";
import { logInfo } from "../../utils/log.js";
import {
  type PolarisPlan,
  type PolarisRole,
  type PolarisSubscriptionLine,
  upsertUserMapEntries,
} from "../../portal/user-map.js";
import { polarisUsersRoot, repoRelativePath } from "../../utils/paths.js";
import { withUserMutationLock } from "../../utils/user-mutation-lock.js";

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
  authingUsername?: string;
  authingUserId?: string;
  role?: PolarisRole;
}): PolarisRole {
  if (args.role) {
    return args.role;
  }
  const overrides = bootstrapAdminTokens();
  const matches = [
    args.userProfileId,
    args.authingUsername ?? "",
    args.authingUserId ?? "",
  ].some((value) => overrides.has(value.trim().toLowerCase()));
  return matches ? "admin" : "user";
}

function parseCreateUserArgs(argv: string[]): {
  userProfileId: string;
  name?: string;
  email?: string;
  authingUsername?: string;
  authingUserId?: string;
  referredByCode?: string;
  role?: PolarisRole;
  plan?: PolarisPlan;
  line?: PolarisSubscriptionLine;
} {
  const userProfileId = argv[0]?.trim();
  const nameFlagIndex = argv.findIndex((value) => value === "--name");
  const emailFlagIndex = argv.findIndex((value) => value === "--email");
  const authingFlagIndex = argv.findIndex((value) => value === "--authing");
  const clerkFlagIndex = argv.findIndex((value) => value === "--clerk");
  const authingUserIdFlagIndex = argv.findIndex((value) => value === "--authing-user-id");
  const clerkUserIdFlagIndex = argv.findIndex((value) => value === "--clerk-user-id");
  const referredByCodeFlagIndex = argv.findIndex((value) => value === "--referred-by-code");
  const roleFlagIndex = argv.findIndex((value) => value === "--role");
  const planFlagIndex = argv.findIndex((value) => value === "--plan");
  const lineFlagIndex = argv.findIndex((value) => value === "--line");
  if (!userProfileId) {
    throw new Error("Usage: pnpm --dir apps/polaris run polaris -- user create <userProfileId> [--name <name>] [--email <email>] [--authing <username>] [--authing-user-id <id>] [--referred-by-code <code>] [--role <admin|user>] [--plan <free|pro>] [--line <coding|vertical|both>]");
  }
  return {
    userProfileId,
    ...(nameFlagIndex >= 0 && argv[nameFlagIndex + 1]?.trim() ? { name: argv[nameFlagIndex + 1].trim() } : {}),
    ...(emailFlagIndex >= 0 && argv[emailFlagIndex + 1]?.trim() ? { email: argv[emailFlagIndex + 1].trim() } : {}),
    ...((authingFlagIndex >= 0 && argv[authingFlagIndex + 1]?.trim())
      || (clerkFlagIndex >= 0 && argv[clerkFlagIndex + 1]?.trim())
      ? {
        authingUsername: String(
          authingFlagIndex >= 0 && argv[authingFlagIndex + 1]?.trim()
            ? argv[authingFlagIndex + 1]
            : argv[clerkFlagIndex + 1],
        ).trim().toLowerCase(),
      }
      : {}),
    ...((authingUserIdFlagIndex >= 0 && argv[authingUserIdFlagIndex + 1]?.trim())
      || (clerkUserIdFlagIndex >= 0 && argv[clerkUserIdFlagIndex + 1]?.trim())
      ? {
        authingUserId: String(
          authingUserIdFlagIndex >= 0 && argv[authingUserIdFlagIndex + 1]?.trim()
            ? argv[authingUserIdFlagIndex + 1]
            : argv[clerkUserIdFlagIndex + 1],
        ).trim(),
      }
      : {}),
    ...(referredByCodeFlagIndex >= 0 && argv[referredByCodeFlagIndex + 1]?.trim()
      ? { referredByCode: argv[referredByCodeFlagIndex + 1].trim() }
      : {}),
    ...(roleFlagIndex >= 0 && (argv[roleFlagIndex + 1] === "admin" || argv[roleFlagIndex + 1] === "user")
      ? { role: argv[roleFlagIndex + 1] as PolarisRole }
      : {}),
    ...(planFlagIndex >= 0 && (argv[planFlagIndex + 1] === "free" || argv[planFlagIndex + 1] === "pro")
      ? { plan: argv[planFlagIndex + 1] as PolarisPlan }
      : {}),
    ...(lineFlagIndex >= 0 && (
      argv[lineFlagIndex + 1] === "coding"
      || argv[lineFlagIndex + 1] === "vertical"
      || argv[lineFlagIndex + 1] === "both"
    )
      ? { line: argv[lineFlagIndex + 1] as PolarisSubscriptionLine }
      : {}),
  };
}

export async function createUserCommand(argv: string[]): Promise<void> {
  const {
    userProfileId,
    name,
    email,
    authingUsername,
    authingUserId,
    referredByCode,
    role,
    plan,
    line,
  } = parseCreateUserArgs(argv);
  const resolvedRole = resolveDefaultRole({
    userProfileId,
    authingUsername,
    authingUserId,
    role,
  });
  await withUserMutationLock(import.meta.url, userProfileId, async () => {
    const usersRoot = polarisUsersRoot(import.meta.url);
    const created = scaffoldUserProfileById({
      id: userProfileId,
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
      ...(referredByCode ? { referredByCode } : {}),
    });
    let defaultCredentials: Array<{ id: string }> = [];
    try {
      defaultCredentials = ensureRequiredProfileCredentials(created.id);
      if (authingUsername || authingUserId) {
        await upsertUserMapEntries({
          ...(authingUsername ? { authingUsername } : {}),
          ...(authingUserId ? { authingUserId } : {}),
          entry: {
            polarisUserId: created.id,
            role: resolvedRole,
            plan: plan ?? "free",
            line: line ?? "coding",
          },
        });
      }
    } catch (error) {
      if (created.created) {
        fs.rmSync(path.join(usersRoot, "profiles", `${created.id}.yaml`), { force: true });
        fs.rmSync(path.join(usersRoot, created.id), { recursive: true, force: true });
      }
      throw error;
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
        registryRoot: repoRelativePath(import.meta.url, path.join(usersRoot, created.id, "credentials")),
        defaults: defaultCredentials.map((credential) => credential.id),
      },
    }, null, 2)}\n`);
  });
}
