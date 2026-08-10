import path from "node:path";
import type { AuthFile } from "../types.js";

export function userIdentityBootstrapDirs(identityRoot: string): string[] {
  return [
    "codex",
    "claude",
    "copilot",
    "pi",
    "opencode/config",
    "opencode/data",
    "ssh",
    "polaris/credentials",
    "codex-xdg/config",
    "codex-xdg/data",
    "codex-xdg/state",
  ].map((entry) => path.join(identityRoot, entry));
}

export function stateStoragePathForMountPath(args: {
  mountPath: string;
  runtimeHome: string;
  identityRoot: string;
}): string | null {
  const { mountPath, runtimeHome, identityRoot } = args;
  const normalizedMountPath = path.posix.normalize(mountPath);
  const mappings: Array<[string, string]> = [
    [`${runtimeHome}/.codex`, `${identityRoot}/codex`],
    [`${runtimeHome}/.claude`, `${identityRoot}/claude`],
    [`${runtimeHome}/.copilot`, `${identityRoot}/copilot`],
    [`${runtimeHome}/.pi`, `${identityRoot}/pi`],
    [`${runtimeHome}/.config/opencode`, `${identityRoot}/opencode/config`],
    [`${runtimeHome}/.local/share/opencode`, `${identityRoot}/opencode/data`],
    [`${runtimeHome}/.ssh`, `${identityRoot}/ssh`],
  ];
  for (const [runtimePrefix, statePrefix] of mappings) {
    const normalizedPrefix = path.posix.normalize(runtimePrefix);
    if (normalizedMountPath === normalizedPrefix) {
      return statePrefix;
    }
    if (normalizedMountPath.startsWith(`${normalizedPrefix}/`)) {
      return `${statePrefix}${normalizedMountPath.slice(normalizedPrefix.length)}`;
    }
  }
  return null;
}

export function authFileStorageTarget(file: AuthFile, args: {
  runtimeHome: string;
  identityRoot: string;
}): string {
  return stateStoragePathForMountPath({
    mountPath: file.mountPath,
    runtimeHome: args.runtimeHome,
    identityRoot: args.identityRoot,
  }) ?? file.mountPath;
}
