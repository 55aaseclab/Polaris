import { createCommand } from "./commands/create.js";
import { createUserCommand } from "./commands/create-user.js";
import { deleteUserCommand } from "./commands/delete-user.js";
import { userCommand } from "./commands/user.js";
import { workspaceCommand } from "./commands/workspace.js";
import { applyCommand } from "./commands/apply.js";
import { renderCommand } from "./commands/render.js";
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { restartCommand } from "./commands/restart.js";
import { rebuildCommand } from "./commands/rebuild.js";
import { statusCommand } from "./commands/status.js";
import { reconcileCommand } from "./commands/reconcile.js";
import { logsCommand } from "./commands/logs.js";
import { liveSwitchCommand } from "./commands/live-switch.js";
import { switchCommand } from "./commands/switch.js";
import { portalCommand } from "./commands/portal.js";
import { deleteCommand } from "./commands/delete.js";
import { executorCommand } from "./commands/executor.js";
import { opsCommand } from "./commands/ops.js";
import {
  skillInstallCommand,
  skillListCommand,
  skillSyncCommand,
  skillUninstallCommand,
} from "./commands/skill.js";
import { logInfo } from "../utils/log.js";

const COMMANDS = new Set(["create", "create-user", "delete-user", "user", "workspace", "skill-list", "skill-install", "skill-uninstall", "skill-sync", "start", "stop", "restart", "rebuild", "apply", "render", "status", "reconcile", "logs", "live-switch", "switch", "delete", "portal", "server", "executor", "ops"]);

function usage(): never {
  throw new Error("Usage: pnpm --dir apps/polaris run polaris -- <user|workspace|skill-list|skill-install|skill-uninstall|skill-sync|create-user|delete-user|create|status|start|stop|restart|rebuild|apply|render|reconcile|logs|live-switch|switch|delete|portal|server|executor|ops> ...");
}

function extractUserProfileId(argv: string[]): string | undefined {
  const userFlagIndex = argv.findIndex((value) => value === "--user");
  if (userFlagIndex === -1) {
    return undefined;
  }
  const userProfileId = argv[userFlagIndex + 1]?.trim();
  if (!userProfileId) {
    throw new Error("Usage: pnpm --dir apps/polaris run polaris -- <command> <project> --user <userProfileId>");
  }
  return userProfileId;
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
  if (first === "executor") {
    await executorCommand(second, argv[2]);
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
  if (first === "workspace") {
    await workspaceCommand(argv.slice(1));
    return;
  }
  if (first === "create-user") {
    await createUserCommand(argv.slice(1));
    return;
  }
  if (first === "delete-user") {
    await deleteUserCommand(argv.slice(1));
    return;
  }
  if (first === "create") {
    await createCommand(argv.slice(1));
    return;
  }
  const command = COMMANDS.has(first) ? first : "status";
  const project = COMMANDS.has(first) ? second : first;
  const userProfileId = extractUserProfileId(argv);
  if (!project) {
    usage();
  }
  logInfo("cli", "dispatch", { argv, command, project, userProfileId });

  if (command === "start") {
    await startCommand(project, userProfileId);
    return;
  }
  if (command === "stop") {
    await stopCommand(project, userProfileId);
    return;
  }
  if (command === "restart") {
    await restartCommand(project, userProfileId);
    return;
  }
  if (command === "rebuild") {
    await rebuildCommand(project, userProfileId);
    return;
  }
  if (command === "apply") {
    await applyCommand(project, userProfileId);
    return;
  }
  if (command === "render") {
    await renderCommand(project, userProfileId);
    return;
  }
  if (command === "status") {
    await statusCommand(project, userProfileId);
    return;
  }
  if (command === "reconcile") {
    await reconcileCommand(project, userProfileId);
    return;
  }
  if (command === "logs") {
    await logsCommand(project, userProfileId);
    return;
  }
  if (command === "live-switch") {
    await liveSwitchCommand(argv.slice(1));
    return;
  }
  if (command === "switch") {
    await switchCommand(project);
    return;
  }
  if (command === "skill-list") {
    await skillListCommand(project, argv.slice(2));
    return;
  }
  if (command === "skill-install") {
    await skillInstallCommand(project, argv.slice(2));
    return;
  }
  if (command === "skill-uninstall") {
    await skillUninstallCommand(project, argv.slice(2));
    return;
  }
  if (command === "skill-sync") {
    await skillSyncCommand(project, argv.slice(2));
    return;
  }
  if (command === "delete") {
    await deleteCommand(project, userProfileId);
    return;
  }

  usage();
}
