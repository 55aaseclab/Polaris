import { spawnSync } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

export function runCommand(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
  }
}
