import { userCommand } from "./commands/user.js";
import { vaultCommand } from "./commands/vault.js";
import { portalCommand } from "./commands/portal.js";
import { opsCommand } from "./commands/ops.js";
import { packCommand } from "./commands/pack.js";

function usage(): never {
  throw new Error("Usage: pnpm --dir apps/polaris run polaris -- <user|vault|pack|portal|server|ops> ...");
}

export async function runCli(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    usage();
  }

  const [first, second] = argv;
  if (first === "portal" || first === "server") {
    await portalCommand(second, argv[2]);
    return;
  }
  if (first === "ops") {
    await opsCommand(second, argv.slice(2));
    return;
  }
  if (first === "user") {
    await userCommand(argv.slice(1));
    return;
  }
  if (first === "vault") {
    await vaultCommand(argv.slice(1));
    return;
  }
  if (first === "pack") {
    await packCommand(argv.slice(1));
    return;
  }
  usage();
}
