import type { AuthFile, PlainEnvVar } from "../core/vault.js";
import {
  WANGHAI_PROFILE_ENV_FILE_KEY,
  WANGHAI_PROFILE_ENV_MOUNT_PATH,
} from "../config/scaffold.js";

const RESTRICTED_INTEGRATED_WANGHAI_ENV_PREFIXES = [
  "OUTREACH_",
  "SMTP_",
  "WANGHAI_",
] as const;

const RESTRICTED_INTEGRATED_WANGHAI_ENV_NAMES = new Set([
  "PORTAL_PROFILE_AUTH",
]);

const ENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u;

/**
 * Polaris owns integrated action credentials and Wanghai runtime settings.
 * Standalone Wanghai can still use these values from its explicit data root.
 */
export function isRestrictedIntegratedWanghaiEnvName(value: string): boolean {
  const name = value.trim();
  return RESTRICTED_INTEGRATED_WANGHAI_ENV_NAMES.has(name)
    || RESTRICTED_INTEGRATED_WANGHAI_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function isWanghaiProfileEnvFile(file: Pick<AuthFile, "key" | "mountPath">): boolean {
  return file.key === WANGHAI_PROFILE_ENV_FILE_KEY
    || file.mountPath === WANGHAI_PROFILE_ENV_MOUNT_PATH;
}

export function sanitizeIntegratedWanghaiEnv(content: string): string {
  const kept: string[] = [];
  let continuation: "line" | "quote" | null = null;
  let quote = "";

  for (const line of content.split(/\r?\n/u)) {
    if (continuation === "line") {
      if (!endsWithUnescapedBackslash(line)) continuation = null;
      continue;
    }
    if (continuation === "quote") {
      if (hasClosingQuote(line, quote)) continuation = null;
      continue;
    }

    const match = line.match(ENV_ASSIGNMENT);
    if (!match || !isRestrictedIntegratedWanghaiEnvName(match[1])) {
      kept.push(line);
      continue;
    }

    const value = line.slice(line.indexOf("=") + 1).trimStart();
    const openingQuote = value.at(0);
    if ((openingQuote === "\"" || openingQuote === "'") && !hasClosingQuote(value.slice(1), openingQuote)) {
      continuation = "quote";
      quote = openingQuote;
    } else if (endsWithUnescapedBackslash(line)) {
      continuation = "line";
    }
  }

  return kept.join("\n");
}

export function sanitizeIntegratedWanghaiAuthFiles(authFiles: AuthFile[]): AuthFile[] {
  return authFiles.map((file) => {
    if (!isWanghaiProfileEnvFile(file) || !file.content) {
      return file;
    }
    return {
      ...file,
      content: sanitizeIntegratedWanghaiEnv(file.content),
    };
  });
}

export function filterIntegratedWanghaiPlainEnvVars(envVars: PlainEnvVar[]): PlainEnvVar[] {
  return envVars.filter((envVar) => !isRestrictedIntegratedWanghaiEnvName(envVar.name));
}

function hasClosingQuote(value: string, quote: string): boolean {
  let escaped = false;
  for (const character of value) {
    if (character === "\\") {
      escaped = !escaped;
      continue;
    }
    if (character === quote && !escaped) {
      return true;
    }
    escaped = false;
  }
  return false;
}

function endsWithUnescapedBackslash(value: string): boolean {
  let count = 0;
  for (let index = value.length - 1; index >= 0 && value[index] === "\\"; index -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}
