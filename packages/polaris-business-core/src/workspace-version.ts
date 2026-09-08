import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const VERSION_FILE = ".wanghai-workspace-version.json";
const MUTATION_INTENT_FILE = ".wanghai-workspace-mutation-intent.json";
const MUTATION_LOCK_DIRECTORY = ".wanghai-workspace-mutation-lock";
const LOCK_OWNER_FILE = "owner.json";
const VERSION_SCHEMA = "wanghai.workspace-version.v1";
const MUTATION_SCHEMA = "wanghai.workspace-mutation.v1";
const LOCK_SCHEMA = "wanghai.workspace-mutation-lock.v1";
const LOCK_RECOVERY_AGE_MS = 5 * 60 * 1_000;
const LOCK_INSTANCE_ID = randomUUID();

type WorkspaceVersionState = {
  schema: typeof VERSION_SCHEMA;
  version: number;
};

type WorkspaceMutationIntent = {
  schema: typeof MUTATION_SCHEMA;
  base_version: number;
  next_version: number;
};

type WorkspaceMutationLock = {
  schema: typeof LOCK_SCHEMA;
  instance_id: string;
  pid: number;
};

export class WorkspaceVersionConflictError extends Error {
  readonly statusCode = 409;

  constructor(
    message: string,
    readonly currentVersion?: number,
  ) {
    super(message);
    this.name = "WorkspaceVersionConflictError";
  }
}

export type WorkspaceMutationResult<T> = {
  result: T;
  workspaceVersion: number;
};

/**
 * Reads the local workspace version. Missing metadata represents a legacy
 * workspace at version zero until its first admitted mutation.
 */
export function readWorkspaceVersion(workspaceRoot: string): number {
  const root = assertWorkspaceRoot(workspaceRoot);
  const versionPath = path.join(root, VERSION_FILE);
  if (!fs.existsSync(versionPath)) return 0;
  const state = readJsonFile(versionPath, "workspace version");
  if (
    !isExactObject(state, ["schema", "version"])
    || state.schema !== VERSION_SCHEMA
    || !isWorkspaceVersion(state.version)
  ) {
    throw new Error("Workspace version metadata is invalid");
  }
  return state.version;
}

/** Creates version metadata for a newly created workspace. */
export function initializeWorkspaceVersion(
  workspaceRoot: string,
  initialVersion = 0,
): number {
  const root = assertWorkspaceRoot(workspaceRoot);
  assertWorkspaceVersion(initialVersion, "Initial workspace version");
  const versionPath = path.join(root, VERSION_FILE);
  if (fs.existsSync(versionPath)) return readWorkspaceVersion(root);
  writeJsonFileAtomic(versionPath, {
    schema: VERSION_SCHEMA,
    version: initialVersion,
  } satisfies WorkspaceVersionState);
  return initialVersion;
}

/**
 * Executes one local workspace mutation under an atomic lock and advances the
 * version only after the callback succeeds. A durable intent remains after a
 * process crash so recovery consumes the version rather than replaying an
 * uncertain write with the old precondition.
 */
export async function withWorkspaceVersion<T>(input: {
  expectedVersion: number;
  mutate: () => Promise<T> | T;
  workspaceRoot: string;
}): Promise<WorkspaceMutationResult<T>> {
  const root = assertWorkspaceRoot(input.workspaceRoot);
  assertWorkspaceVersion(input.expectedVersion, "Expected workspace version");
  const release = acquireWorkspaceMutationLock(root);

  try {
    recoverWorkspaceMutationIntent(root);
    const currentVersion = readWorkspaceVersion(root);
    if (currentVersion !== input.expectedVersion) {
      throw new WorkspaceVersionConflictError(
        "Workspace version is stale",
        currentVersion,
      );
    }

    const nextVersion = currentVersion + 1;
    writeWorkspaceMutationIntent(root, currentVersion, nextVersion);

    let result: T;
    try {
      result = await input.mutate();
    } catch (error) {
      // A normal handler failure did not produce a successful semantic result.
      // If removal fails, recovery conservatively consumes the version.
      removeWorkspaceMutationIntent(root);
      throw error;
    }

    writeWorkspaceVersion(root, nextVersion);
    removeWorkspaceMutationIntent(root);
    return { result, workspaceVersion: nextVersion };
  } finally {
    release();
  }
}

function assertWorkspaceRoot(value: string): string {
  const root = path.resolve(value);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root);
  } catch {
    throw new Error("Workspace root is unavailable");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Workspace root must be a directory");
  }
  return root;
}

function isWorkspaceVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertWorkspaceVersion(value: number, name: string): void {
  if (!isWorkspaceVersion(value)) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function readJsonFile(filePath: string, description: string): unknown {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_096) {
    throw new Error(`${description} metadata is invalid`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    throw new Error(`${description} metadata is invalid`);
  }
}

function isExactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function writeWorkspaceVersion(root: string, version: number): void {
  assertWorkspaceVersion(version, "Workspace version");
  writeJsonFileAtomic(path.join(root, VERSION_FILE), {
    schema: VERSION_SCHEMA,
    version,
  } satisfies WorkspaceVersionState);
}

function writeWorkspaceMutationIntent(
  root: string,
  baseVersion: number,
  nextVersion: number,
): void {
  const intentPath = path.join(root, MUTATION_INTENT_FILE);
  if (fs.existsSync(intentPath)) {
    throw new Error("Workspace mutation recovery is required before a new write");
  }
  writeJsonFileAtomic(intentPath, {
    schema: MUTATION_SCHEMA,
    base_version: baseVersion,
    next_version: nextVersion,
  } satisfies WorkspaceMutationIntent);
}

function recoverWorkspaceMutationIntent(root: string): void {
  const intentPath = path.join(root, MUTATION_INTENT_FILE);
  if (!fs.existsSync(intentPath)) return;
  const intent = readJsonFile(intentPath, "workspace mutation") as unknown;
  if (
    !isExactObject(intent, ["schema", "base_version", "next_version"])
    || intent.schema !== MUTATION_SCHEMA
    || !isWorkspaceVersion(intent.base_version)
    || !isWorkspaceVersion(intent.next_version)
    || intent.next_version !== intent.base_version + 1
  ) {
    throw new Error("Workspace mutation recovery metadata is invalid");
  }

  const currentVersion = readWorkspaceVersion(root);
  if (currentVersion === intent.base_version) {
    writeWorkspaceVersion(root, intent.next_version);
  } else if (currentVersion !== intent.next_version) {
    throw new Error("Workspace mutation recovery version is inconsistent");
  }
  removeWorkspaceMutationIntent(root);
}

function removeWorkspaceMutationIntent(root: string): void {
  const intentPath = path.join(root, MUTATION_INTENT_FILE);
  if (!fs.existsSync(intentPath)) return;
  const stat = fs.lstatSync(intentPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Workspace mutation metadata is invalid");
  }
  fs.unlinkSync(intentPath);
}

function acquireWorkspaceMutationLock(workspaceRoot: string): () => void {
  const lockPath = path.join(workspaceRoot, MUTATION_LOCK_DIRECTORY);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeJsonFileAtomic(path.join(lockPath, LOCK_OWNER_FILE), {
          schema: LOCK_SCHEMA,
          instance_id: LOCK_INSTANCE_ID,
          pid: process.pid,
        } satisfies WorkspaceMutationLock);
      } catch (error) {
        fs.rmSync(lockPath, { force: true, recursive: true });
        throw error;
      }
      return () => releaseWorkspaceMutationLock(lockPath);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      if (attempt > 0 || !reclaimDeadWorkspaceMutationLock(lockPath)) {
        throw new WorkspaceVersionConflictError(
          "Another Wanghai workspace mutation is already in progress",
        readWorkspaceVersion(workspaceRoot),
        );
      }
    }
  }
  throw new WorkspaceVersionConflictError(
    "Another Wanghai workspace mutation is already in progress",
    readWorkspaceVersion(workspaceRoot),
  );
}

function releaseWorkspaceMutationLock(lockPath: string): void {
  if (!fs.existsSync(lockPath)) {
    throw new Error("Workspace mutation lock disappeared before release");
  }
  const ownerPath = path.join(lockPath, LOCK_OWNER_FILE);
  const owner = readWorkspaceMutationLock(ownerPath);
  if (owner?.instance_id !== LOCK_INSTANCE_ID || owner.pid !== process.pid) {
    throw new Error("Workspace mutation lock ownership changed before release");
  }
  fs.rmSync(lockPath, { force: true, recursive: true });
}

function reclaimDeadWorkspaceMutationLock(lockPath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(lockPath);
  } catch {
    return false;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Workspace mutation lock is invalid");
  }

  const owner = readWorkspaceMutationLock(path.join(lockPath, LOCK_OWNER_FILE));
  if (owner && lockOwnerIsRunning(owner)) return false;
  if (!owner && Date.now() - stat.mtimeMs < LOCK_RECOVERY_AGE_MS) return false;

  fs.rmSync(lockPath, { force: true, recursive: true });
  return true;
}

function readWorkspaceMutationLock(lockOwnerPath: string): WorkspaceMutationLock | null {
  if (!fs.existsSync(lockOwnerPath)) return null;
  let value: unknown;
  try {
    value = readJsonFile(lockOwnerPath, "workspace mutation lock");
  } catch {
    return null;
  }
  if (
    !isExactObject(value, ["schema", "instance_id", "pid"])
    || value.schema !== LOCK_SCHEMA
    || typeof value.instance_id !== "string"
    || value.instance_id.length === 0
    || typeof value.pid !== "number"
    || !Number.isSafeInteger(value.pid)
    || value.pid <= 0
  ) {
    return null;
  }
  return value as WorkspaceMutationLock;
}

function lockOwnerIsRunning(owner: WorkspaceMutationLock): boolean {
  if (owner.pid === process.pid) return owner.instance_id === LOCK_INSTANCE_ID;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function writeJsonFileAtomic(filePath: string, value: object): void {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}
