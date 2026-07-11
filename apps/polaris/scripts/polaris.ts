#!/usr/bin/env node

import { runCli } from "./cli/main.js";
import { registerTelemetryProcessHandlers } from "./telemetry/client.js";

registerTelemetryProcessHandlers(import.meta.url);
await runCli(process.argv.slice(2));
