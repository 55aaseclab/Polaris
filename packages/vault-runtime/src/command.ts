import { spawnSync } from "node:child_process";

export function runCommand(command: string, args: string[]): void {
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
