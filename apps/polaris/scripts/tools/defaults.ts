import fs from "node:fs";
import { polarisCacheRoot } from "../utils/paths.js";

export const HOST_CACHE_ALIASES = [
  "POLARIS_LITERATURE_CACHE_ROOT",
] as const;

export const HOST_ENV_ALIASES = {
  POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY: ["SEMANTIC_SCHOLAR_API_KEY"],
  POLARIS_LITERATURE_DEEPSEC_API_URL: ["DEEPSEC_API_URL"],
  POLARIS_LITERATURE_CROSSREF_API_URL: ["CROSSREF_API_URL"],
  POLARIS_LITERATURE_CODEX_BIN: ["CODEX_BIN"],
} as const;

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
  for (const [key, aliases] of Object.entries(HOST_ENV_ALIASES)) {
    if (present(environment, key)) continue;
    const alias = aliases.find((name) => present(environment, name));
    if (alias) environment[key] = environment[alias];
  }
  // Polaristool may invent only PATH `codex`. It does not invent other tool hosts or keys.
  if (!present(environment, "POLARIS_LITERATURE_CODEX_BIN")) {
    const pathValue = environment.PATH ?? process.env.PATH ?? "";
    const found = pathValue.split(":").find((directory) => {
      try {
        const candidate = `${directory.replace(/\/$/u, "")}/codex`;
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    if (found) environment.POLARIS_LITERATURE_CODEX_BIN = `${found.replace(/\/$/u, "")}/codex`;
  }
  return environment;
}
