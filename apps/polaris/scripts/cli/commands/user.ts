import { createUserCommand } from "./create-user.js";
import { deleteUserCommand } from "./delete-user.js";
import { updateUserCommand } from "./update-user.js";
import { listPortalProfiles } from "../../core/portal.js";
import {
  activateUserCredentialCommand,
  addUserCredentialCommand,
  createUserCredentialCommand,
  deleteUserCredentialCommand,
  listUserCredentialCommand,
  readUserCredentialCommand,
  writeUserCredentialCommand,
} from "./user-credential.js";
import {
  addUserSkillCommand,
  listUserSkillCommand,
  removeUserSkillCommand,
} from "./user-skill.js";
import {
  readUserDefaultsCommand,
  setUserDefaultsCommand,
} from "./user-defaults.js";

function usage(): never {
  throw new Error(
    "Usage: pnpm --dir apps/polaris run polaris -- user <list|create|update|delete|defaults|credential|skill> ...",
  );
}

async function listUserCommand(argv: string[]): Promise<void> {
  if (argv.length > 0) {
    usage();
  }
  process.stdout.write(`${JSON.stringify({
    users: listPortalProfiles(),
  }, null, 2)}\n`);
}

export async function userCommand(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "list") {
    await listUserCommand(rest);
    return;
  }
  if (subcommand === "create") {
    await createUserCommand(rest);
    return;
  }
  if (subcommand === "update") {
    await updateUserCommand(rest);
    return;
  }
  if (subcommand === "delete") {
    await deleteUserCommand(rest);
    return;
  }
  if (subcommand === "defaults") {
    const [defaultsAction, ...defaultsRest] = rest;
    if (defaultsAction === "read") {
      await readUserDefaultsCommand(defaultsRest);
      return;
    }
    if (defaultsAction === "set") {
      await setUserDefaultsCommand(defaultsRest);
      return;
    }
  }
  if (subcommand === "credential") {
    const [credentialAction, ...credentialRest] = rest;
    if (credentialAction === "add") {
      await addUserCredentialCommand(credentialRest);
      return;
    }
    if (credentialAction === "create") {
      await createUserCredentialCommand(credentialRest);
      return;
    }
    if (credentialAction === "delete") {
      await deleteUserCredentialCommand(credentialRest);
      return;
    }
    if (credentialAction === "list") {
      await listUserCredentialCommand(credentialRest);
      return;
    }
    if (credentialAction === "activate") {
      await activateUserCredentialCommand(credentialRest);
      return;
    }
    if (credentialAction === "read") {
      await readUserCredentialCommand(credentialRest);
      return;
    }
    if (credentialAction === "write") {
      await writeUserCredentialCommand(credentialRest);
      return;
    }
  }
  if (subcommand === "skill") {
    const [skillAction, ...skillRest] = rest;
    if (skillAction === "add") {
      await addUserSkillCommand(skillRest);
      return;
    }
    if (skillAction === "list") {
      await listUserSkillCommand(skillRest);
      return;
    }
    if (skillAction === "remove") {
      await removeUserSkillCommand(skillRest);
      return;
    }
  }
  usage();
}
