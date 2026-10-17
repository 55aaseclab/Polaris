import path from "node:path";

/**
 * Common-tool entrypoint resolution (PRD 3.11.8): pack-local entrypoints
 * start with `packs/` and resolve straight from the repository root; every
 * other entrypoint keeps the global `tools/` prefix.
 */
export function resolveToolEntrypointPath(repoRoot: string, entrypoint: string): string {
  return entrypoint.startsWith("packs/")
    ? path.join(repoRoot, entrypoint)
    : path.join(repoRoot, "tools", entrypoint);
}

export function toolEntrypointDirectory(repoRoot: string, entrypoint: string): string {
  return path.dirname(resolveToolEntrypointPath(repoRoot, entrypoint));
}
