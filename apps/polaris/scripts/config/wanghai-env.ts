import path from "node:path";
import type { AuthFile } from "../core/workspace.js";
import {
  WANGHAI_BACKUP_RUNTIME_ROOT,
  WANGHAI_PROFILE_ENV_FILE_KEY,
  WANGHAI_PROFILE_ENV_MOUNT_PATH,
  WANGHAI_PROFILE_ENV_SOURCE_PATH,
  WANGHAI_WORKSPACES_RUNTIME_ROOT,
} from "./scaffold.js";

export interface WanghaiProfileDataRoots {
  backupRoot: string | null;
  workspacesRoot: string | null;
}

function findWanghaiProfileEnvFile(authFiles: readonly AuthFile[]): AuthFile | null {
  return authFiles.find((file) =>
    file.key === WANGHAI_PROFILE_ENV_FILE_KEY
    || file.mountPath === WANGHAI_PROFILE_ENV_MOUNT_PATH
    || file.sourcePath === WANGHAI_PROFILE_ENV_SOURCE_PATH
  ) ?? null;
}

function readEnvValue(content: string, key: string): string | null {
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    if (line.slice(0, separatorIndex).trim() !== key) {
      continue;
    }
    const rawValue = line.slice(separatorIndex + 1).trim();
    const normalized = rawValue.replace(/^['"]|['"]$/gu, "").trim();
    return normalized || null;
  }
  return null;
}

function normalizeHostRoot(value: string | null, runtimeRoot: string): string | null {
  if (!value || !path.isAbsolute(value)) {
    return null;
  }
  const resolved = path.resolve(value);
  return resolved === runtimeRoot ? null : resolved;
}

export function resolveWanghaiProfileDataRoots(
  authFiles: readonly AuthFile[],
): WanghaiProfileDataRoots {
  const envFile = findWanghaiProfileEnvFile(authFiles);
  const content = envFile?.content ?? "";
  return {
    workspacesRoot: normalizeHostRoot(
      readEnvValue(content, "WANGHAI_WORKSPACES_ROOT"),
      WANGHAI_WORKSPACES_RUNTIME_ROOT,
    ),
    backupRoot: normalizeHostRoot(
      readEnvValue(content, "WANGHAI_BACKUP_ROOT"),
      WANGHAI_BACKUP_RUNTIME_ROOT,
    ),
  };
}
