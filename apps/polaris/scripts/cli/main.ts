import { createCommand } from "./commands/create.js";
import { createUserCommand } from "./commands/create-user.js";
import { deleteUserCommand } from "./commands/delete-user.js";
import { userCommand } from "./commands/user.js";
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
import { archiveCommand } from "./commands/archive.js";
import { deleteCommand } from "./commands/delete.js";
import { executorCommand } from "./commands/executor.js";
import { logInfo } from "../utils/log.js";

const COMMANDS = new Set(["create", "create-user", "delete-user", "user", "start", "stop", "restart", "rebuild", "apply", "render", "status", "reconcile", "logs", "live-switch", "switch", "archive", "delete", "portal", "server", "executor"]);

function usage(): never {
  throw new Error("Usage: pnpm --dir apps/polaris run polaris -- <user|create-user|delete-user|create|status|start|stop|restart|rebuild|apply|render|reconcile|logs|live-switch|switch|archive|delete|portal|server|executor> ...");
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
  if (first === "user") {
    await userCommand(argv.slice(1));
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
  if (!project) {
    usage();
  }
  logInfo("cli", "dispatch", { argv, command, project });

  if (command === "start") {
    await startCommand(project);
    return;
  }
  if (command === "stop") {
    await stopCommand(project);
    return;
  }
  if (command === "restart") {
    await restartCommand(project);
    return;
  }
  if (command === "rebuild") {
    await rebuildCommand(project);
    return;
  }
  if (command === "apply") {
    await applyCommand(project);
    return;
  }
  if (command === "render") {
    await renderCommand(project);
    return;
  }
  if (command === "status") {
    await statusCommand(project);
    return;
  }
  if (command === "reconcile") {
    await reconcileCommand(project);
    return;
  }
  if (command === "logs") {
    await logsCommand(project);
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
  if (command === "archive") {
    await archiveCommand(project);
    return;
  }
  if (command === "delete") {
    await deleteCommand(project);
    return;
  }

  usage();
}
