import { createUserCommand } from "./create-user.js";
import { deleteUserCommand } from "./delete-user.js";
import {
  createUserCredentialCommand,
  deleteUserCredentialCommand,
} from "./user-credential.js";

function usage(): never {
  throw new Error(
    "Usage: pnpm --dir apps/polaris run polaris -- user <create|delete|credential> ...",
  );
}

export async function userCommand(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "create") {
    await createUserCommand(rest);
    return;
  }
  if (subcommand === "delete") {
    await deleteUserCommand(rest);
    return;
  }
  if (subcommand === "credential") {
    const [credentialAction, ...credentialRest] = rest;
    if (credentialAction === "create") {
      await createUserCredentialCommand(credentialRest);
      return;
    }
    if (credentialAction === "delete") {
      await deleteUserCredentialCommand(credentialRest);
      return;
    }
  }
  usage();
}
