import { applyCommand } from "./apply.js";
import { createCommand } from "./create.js";
import { deleteCommand } from "./delete.js";
import { liveSwitchCommand } from "./live-switch.js";
import { listCommand } from "./list.js";
import { logsCommand } from "./logs.js";
import { rebuildCommand } from "./rebuild.js";
import { reconcileCommand } from "./reconcile.js";
import { renderCommand } from "./render.js";
import {
  skillInstallCommand,
  skillListCommand,
  skillSyncCommand,
  skillUninstallCommand,
} from "./skill.js";
import { restartCommand } from "./restart.js";
import { startCommand } from "./start.js";
import { statusCommand } from "./status.js";
import { stopCommand } from "./stop.js";
import { switchCommand } from "./switch.js";

function usage(): never {
  throw new Error(
    "Usage: pnpm --dir apps/polaris run polaris -- vault <list|create|apply|render|start|stop|restart|rebuild|status|reconcile|logs|live-switch|switch|delete|skill-list|skill-install|skill-uninstall|skill-sync> ...",
  );
}

function parseVaultRef(argv: string[]): string {
  const vaultRef = argv[0]?.trim();
  if (!vaultRef) {
    usage();
  }
  return vaultRef;
}

function parseUserProfileId(argv: string[]): string | undefined {
  const userFlagIndex = argv.findIndex((value) => value === "--user");
  if (userFlagIndex === -1) {
    return undefined;
  }
  const userProfileId = argv[userFlagIndex + 1]?.trim();
  if (!userProfileId) {
    usage();
  }
  return userProfileId;
}

export async function vaultCommand(argv: string[]): Promise<void> {
  const [action, ...rest] = argv;
  if (!action) {
    usage();
  }

  if (action === "create") {
    await createCommand(rest);
    return;
  }
  if (action === "list") {
    await listCommand(rest);
    return;
  }
  if (action === "apply") {
    await applyCommand(parseVaultRef(rest), parseUserProfileId(rest));
    return;
  }
  if (action === "render") {
    await renderCommand(parseVaultRef(rest), parseUserProfileId(rest));
    return;
  }
  if (action === "start") {
    await startCommand(parseVaultRef(rest), parseUserProfileId(rest));
    return;
  }
  if (action === "stop") {
    await stopCommand(parseVaultRef(rest), parseUserProfileId(rest));
    return;
  }
  if (action === "restart") {
    await restartCommand(parseVaultRef(rest), parseUserProfileId(rest));
    return;
  }
  if (action === "rebuild") {
    await rebuildCommand(parseVaultRef(rest), parseUserProfileId(rest));
    return;
  }
  if (action === "status") {
    await statusCommand(parseVaultRef(rest), parseUserProfileId(rest));
    return;
  }
  if (action === "reconcile") {
    await reconcileCommand(parseVaultRef(rest), parseUserProfileId(rest));
    return;
  }
  if (action === "logs") {
    await logsCommand(parseVaultRef(rest), parseUserProfileId(rest));
    return;
  }
  if (action === "live-switch") {
    await liveSwitchCommand(rest);
    return;
  }
  if (action === "switch") {
    await switchCommand(parseVaultRef(rest));
    return;
  }
  if (action === "delete") {
    await deleteCommand(parseVaultRef(rest), parseUserProfileId(rest));
    return;
  }
  if (action === "skill-list") {
    const vaultRef = parseVaultRef(rest);
    await skillListCommand(vaultRef, rest.slice(1));
    return;
  }
  if (action === "skill-install") {
    const vaultRef = parseVaultRef(rest);
    await skillInstallCommand(vaultRef, rest.slice(1));
    return;
  }
  if (action === "skill-uninstall") {
    const vaultRef = parseVaultRef(rest);
    await skillUninstallCommand(vaultRef, rest.slice(1));
    return;
  }
  if (action === "skill-sync") {
    const vaultRef = parseVaultRef(rest);
    await skillSyncCommand(vaultRef, rest.slice(1));
    return;
  }

  usage();
}
