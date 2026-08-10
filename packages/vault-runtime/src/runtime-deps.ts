import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { RuntimeDriverDependencies, VaultRuntimeSpec } from "./types.js";

function writeManifest(spec: VaultRuntimeSpec, yamlText: string): string {
  const outputPath = spec.manifestPath?.trim();
  if (!outputPath) {
    throw new Error("VaultRuntimeSpec.manifestPath is required to write a manifest");
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(outputPath), 0o700);
  fs.writeFileSync(outputPath, yamlText, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(outputPath, 0o600);
  return outputPath;
}

function runCommand(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`Failed to execute '${command} ${args.join(" ")}': ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status ?? 1}): ${command} ${args.join(" ")}`);
  }
}

export function defaultRuntimeDriverDependencies(): RuntimeDriverDependencies {
  return {
    writeManifest,
    runCommand,
    logInfo: (scope, message, details) => {
      const suffix = details ? ` ${JSON.stringify(details)}` : "";
      process.stderr.write(`[vault-runtime] [${scope}] ${message}${suffix}\n`);
    },
    withDockerCapacity: async (_spec, operation) => operation(),
  };
}
