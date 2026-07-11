#!/usr/bin/env node

import { startLocalDeployGui } from "./local-deploy/desktop.js";
import { openExternalUrl } from "./local-deploy/control.js";

void (async () => {
  const { url } = await startLocalDeployGui(import.meta.url);
  process.stdout.write(`Polaris desktop launcher listening on ${url}\n`);
  openExternalUrl(url);
  await new Promise(() => {});
})();
