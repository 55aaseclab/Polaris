import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../utils/paths.js";
import { toolEntrypointDirectory } from "./entrypoint.js";

export type ToolPrerequisiteKind = "required" | "recommended";

export type ToolEnvPrerequisite = {
  key: string;
  kind: ToolPrerequisiteKind;
  reason: string;
};

export type ToolCommandPrerequisite = {
  name: string;
  kind: ToolPrerequisiteKind;
  reason: string;
};

export type ToolFilePrerequisite = {
  path: string;
  kind: ToolPrerequisiteKind;
  reason: string;
};

export type ToolPythonPrerequisite = {
  minimum_version: string;
  requirements: string[];
};

export type ToolPrerequisites = {
  env: ToolEnvPrerequisite[];
  commands: ToolCommandPrerequisite[];
  files: ToolFilePrerequisite[];
  python?: ToolPythonPrerequisite;
};

export type ToolInventoryEntry = {
  id: string;
  entrypoint: string;
  commands: string[];
  capabilities: string[];
  directory: string;
  lockPath: string;
};

export type ToolBackendLock = {
  toolId: string;
  lockPath: string;
  checkSetupPath: string;
  prerequisites: ToolPrerequisites;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function kindOf(value: unknown): ToolPrerequisiteKind {
  return value === "required" ? "required" : "recommended";
}

function readEnvList(value: unknown): ToolEnvPrerequisite[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.key !== "string" || typeof item.reason !== "string") {
      return [];
    }
    return [{ key: item.key, kind: kindOf(item.kind), reason: item.reason }];
  });
}

function readCommandList(value: unknown): ToolCommandPrerequisite[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.reason !== "string") {
      return [];
    }
    return [{ name: item.name, kind: kindOf(item.kind), reason: item.reason }];
  });
}

function readFileList(value: unknown): ToolFilePrerequisite[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.reason !== "string") {
      return [];
    }
    return [{ path: item.path, kind: kindOf(item.kind), reason: item.reason }];
  });
}

function readPython(value: unknown): ToolPythonPrerequisite | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.minimum_version !== "string" || !Array.isArray(value.requirements)) {
    throw new Error("Python tools must declare prerequisites.python.minimum_version and prerequisites.python.requirements");
  }
  return {
    minimum_version: value.minimum_version,
    requirements: value.requirements.filter((item): item is string => typeof item === "string"),
  };
}

export function readToolInventory(importMetaUrl: string): ToolInventoryEntry[] {
  const root = repoRoot(importMetaUrl);
  const file = path.join(root, "tools", "tool-inventory.json");
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.tools)) {
    throw new Error("tool inventory is invalid");
  }
  return parsed.tools.flatMap((item) => {
    if (!isRecord(item)
      || typeof item.id !== "string"
      || typeof item.entrypoint !== "string"
      || !Array.isArray(item.commands)) {
      return [];
    }
    const directory = toolEntrypointDirectory(root, item.entrypoint);
    return [{
      id: item.id,
      entrypoint: item.entrypoint,
      commands: item.commands.filter((command): command is string => typeof command === "string"),
      capabilities: Array.isArray(item.capabilities)
        ? item.capabilities.filter((capability): capability is string => typeof capability === "string")
        : [],
      directory,
      lockPath: path.join(directory, "backend.lock.json"),
    }];
  });
}

export function readToolBackendLock(entry: ToolInventoryEntry): ToolBackendLock {
  if (!fs.existsSync(entry.lockPath)) {
    throw new Error(`${entry.id} is missing ${entry.lockPath}`);
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(entry.lockPath, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.prerequisites)) {
    throw new Error(`${entry.id} backend.lock.json must declare prerequisites`);
  }
  const python = readPython(parsed.prerequisites.python);
  return {
    toolId: entry.id,
    lockPath: entry.lockPath,
    checkSetupPath: path.join(entry.directory, "check-setup"),
    prerequisites: {
      env: readEnvList(parsed.prerequisites.env),
      commands: readCommandList(parsed.prerequisites.commands),
      files: readFileList(parsed.prerequisites.files),
      ...(python ? { python } : {}),
    },
  };
}

export function readHostToolBackendLocks(importMetaUrl: string): ToolBackendLock[] {
  return readToolInventory(importMetaUrl).map(readToolBackendLock);
}
