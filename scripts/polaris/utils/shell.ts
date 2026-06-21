import { spawnSync } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

export function runCommand(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    encoding: "utf8",
  });
  if (result.error) {
    const reason = (result.error as Error).message || "unknown process error";
    throw new Error(`Failed to execute '${command} ${args.join(" ")}': ${reason}`);
  }
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status ?? 1}): ${command} ${args.join(" ")}`);
  }
}
