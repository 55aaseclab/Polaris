#!/usr/bin/env node

import { startLocalDeployGui } from "./local-deploy/desktop.js";
import { openExternalUrl } from "./local-deploy/control.js";

void (async () => {
  const { url } = await startLocalDeployGui("file:///");
  process.stdout.write(`Polaris desktop launcher listening on ${url}\n`);
  openExternalUrl(url);
  await new Promise(() => {});
})();
