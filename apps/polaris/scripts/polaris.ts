#!/usr/bin/env node

import { runCli } from "./cli/main.js";
import {
  captureTelemetryError,
  registerTelemetryProcessHandlers,
} from "./telemetry/client.js";

registerTelemetryProcessHandlers(import.meta.url);
try {
  await runCli(process.argv.slice(2));
} catch (error) {
  // Process handlers observe only genuinely unhandled faults. CLI command
  // failures must retain a nonzero exit status for scripts and operators.
  process.exitCode = 1;
  await captureTelemetryError(import.meta.url, error, {
    event: "cli-command-failed",
    properties: {
      error_domain: "cli",
      error_stage: "command",
    },
  });
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
}
