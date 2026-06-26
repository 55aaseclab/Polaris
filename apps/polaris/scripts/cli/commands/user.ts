import { createUserCommand } from "./create-user.js";
import { deleteUserCommand } from "./delete-user.js";

function usage(): never {
  throw new Error(
    "Usage: pnpm --dir apps/polaris run polaris -- user <create|delete> ...",
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
  usage();
}
