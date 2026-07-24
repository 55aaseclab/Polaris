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
    "Usage: pnpm --dir apps/polaris run polaris -- workspace <list|create|apply|render|start|stop|restart|rebuild|status|reconcile|logs|live-switch|switch|delete|skill-list|skill-install|skill-uninstall|skill-sync> ...",
  );
}

function parseWorkspaceRef(argv: string[]): string {
  const workspaceRef = argv[0]?.trim();
  if (!workspaceRef) {
    usage();
  }
  return workspaceRef;
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

export async function workspaceCommand(argv: string[]): Promise<void> {
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
    await applyCommand(parseWorkspaceRef(rest), parseUserProfileId(rest));
    return;
  }
  if (action === "render") {
    await renderCommand(parseWorkspaceRef(rest), parseUserProfileId(rest));
    return;
  }
  if (action === "start") {
    await startCommand(parseWorkspaceRef(rest), parseUserProfileId(rest));
    return;
  }
  if (action === "stop") {
    await stopCommand(parseWorkspaceRef(rest), parseUserProfileId(rest));
    return;
  }
  if (action === "restart") {
    await restartCommand(parseWorkspaceRef(rest), parseUserProfileId(rest));
    return;
  }
  if (action === "rebuild") {
    await rebuildCommand(parseWorkspaceRef(rest), parseUserProfileId(rest));
    return;
  }
  if (action === "status") {
    await statusCommand(parseWorkspaceRef(rest), parseUserProfileId(rest));
    return;
  }
  if (action === "reconcile") {
    await reconcileCommand(parseWorkspaceRef(rest), parseUserProfileId(rest));
    return;
  }
  if (action === "logs") {
    await logsCommand(parseWorkspaceRef(rest), parseUserProfileId(rest));
    return;
  }
  if (action === "live-switch") {
    await liveSwitchCommand(rest);
    return;
  }
  if (action === "switch") {
    await switchCommand(parseWorkspaceRef(rest));
    return;
  }
  if (action === "delete") {
    await deleteCommand(parseWorkspaceRef(rest), parseUserProfileId(rest));
    return;
  }
  if (action === "skill-list") {
    const workspaceRef = parseWorkspaceRef(rest);
    await skillListCommand(workspaceRef, rest.slice(1));
    return;
  }
  if (action === "skill-install") {
    const workspaceRef = parseWorkspaceRef(rest);
    await skillInstallCommand(workspaceRef, rest.slice(1));
    return;
  }
  if (action === "skill-uninstall") {
    const workspaceRef = parseWorkspaceRef(rest);
    await skillUninstallCommand(workspaceRef, rest.slice(1));
    return;
  }
  if (action === "skill-sync") {
    const workspaceRef = parseWorkspaceRef(rest);
    await skillSyncCommand(workspaceRef, rest.slice(1));
    return;
  }

  usage();
}
