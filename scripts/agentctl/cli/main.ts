import { createCommand } from "./commands/create.js";
import { applyCommand } from "./commands/apply.js";
import { renderCommand } from "./commands/render.js";
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { restartCommand } from "./commands/restart.js";
import { rebuildCommand } from "./commands/rebuild.js";
import { statusCommand } from "./commands/status.js";
import { reconcileCommand } from "./commands/reconcile.js";

const COMMANDS = new Set(["create", "start", "stop", "restart", "rebuild", "apply", "render", "status", "reconcile"]);

function usage(): never {
  throw new Error("Usage: pnpm exec tsx scripts/agentctl.ts <project> | <create|start|stop|restart|rebuild|apply|render|status|reconcile> <project>");
}

export async function runCli(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    usage();
  }

  const [first, second] = argv;
  const command = COMMANDS.has(first) ? first : "apply";
  const project = COMMANDS.has(first) ? second : first;
  if (!project) {
    usage();
  }

  if (command === "create") {
    await createCommand(project);
    return;
  }
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

  usage();
}
