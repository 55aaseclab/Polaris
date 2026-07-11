#!/usr/bin/env node

import { localDeployCommand } from "./cli/commands/local-deploy.js";

void (async () => {
  await localDeployCommand(process.argv.slice(2));
})();
