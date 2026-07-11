import { LOCAL_DEPLOY_ACTIONS, type LocalDeployAction } from "../../local-deploy/types.js";
import { runLocalDeployAction } from "../../local-deploy/control.js";
import { startLocalDeployGui } from "../../local-deploy/desktop.js";

function usage(): never {
  throw new Error(
    `Usage: pnpm --dir apps/polaris run polaris -- local-deploy <${LOCAL_DEPLOY_ACTIONS.join("|")}>`,
  );
}

export async function localDeployCommand(argv: string[]): Promise<void> {
  const action = argv[0]?.trim() as LocalDeployAction | undefined;
  if (!action || !LOCAL_DEPLOY_ACTIONS.includes(action)) {
    usage();
  }
  if (action === "desktop") {
    const { url } = await startLocalDeployGui(import.meta.url);
    process.stdout.write(`Polaris desktop launcher listening on ${url}\n`);
    process.stdout.write("Keep this command running while you use the desktop launcher.\n");
    return new Promise(() => {});
  }
  const result = await runLocalDeployAction(action, import.meta.url);
  process.stdout.write(`${result.message}\n`);
  for (const detail of result.details ?? []) {
    process.stdout.write(`${detail}\n`);
  }
}
