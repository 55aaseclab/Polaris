#!/usr/bin/env node

import { LOCAL_DEPLOY_ACTIONS, type LocalDeployAction } from "./local-deploy/types.js";
import { runLocalDeployAction } from "./local-deploy/control.js";

function usage(): never {
  throw new Error(
    `Usage: polaris <${LOCAL_DEPLOY_ACTIONS.filter((action) => action !== "desktop").join("|")}>`,
  );
}

void (async () => {
  const action = process.argv[2]?.trim() as LocalDeployAction | undefined;
  if (!action || action === "desktop" || !LOCAL_DEPLOY_ACTIONS.includes(action)) {
    usage();
  }
  const result = await runLocalDeployAction(action, "file:///");
  process.stdout.write(`${result.message}\n`);
  for (const detail of result.details ?? []) {
    process.stdout.write(`${detail}\n`);
  }
})();
