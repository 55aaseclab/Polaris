#!/usr/bin/env node

import { runCli } from "./agentctl/cli/main.js";

await runCli(process.argv.slice(2));
