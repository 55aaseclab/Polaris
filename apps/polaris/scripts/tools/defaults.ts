import { polarisCacheRoot } from "../utils/paths.js";

export const HOST_CACHE_ALIASES = [
  "POLARIS_LITERATURE_CACHE_ROOT",
] as const;

function present(environment: NodeJS.ProcessEnv, key: string): boolean {
  return Boolean(environment[key]?.trim());
}

export function applyHostToolDefaults(
  importMetaUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const cacheRoot = polarisCacheRoot(importMetaUrl, environment);
  for (const key of HOST_CACHE_ALIASES) {
    if (!present(environment, key)) {
      environment[key] = cacheRoot;
    }
  }
  return environment;
}
