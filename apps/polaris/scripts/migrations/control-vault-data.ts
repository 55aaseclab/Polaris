import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  VAULT_DATA_RUNTIME_ROOTS,
} from "../backends/vault-runtime-adapter.js";

const CONTROL_SOURCE_ROOTS = ["users", "state", "backup-keys"] as const;
const VAULT_SOURCE_PREFIX = "exports/vaults/tenants/";
const VAULT_TARGET_PREFIX = "vault-data/tenants/";
const REPORT_VERSION = 1;
const STAGING_DIRECTORY = ".polaris-control-vault-data-migrations";
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type MigrationPlane = "control" | "vault-data";

export interface ControlVaultDataManifestEntry {
  plane: MigrationPlane;
  source: string;
  target: string;
}

export interface ControlVaultDataManifest {
  version: 1;
  entries: ControlVaultDataManifestEntry[];
  specs: string[];
  ignoredSources?: string[];
}

interface TreeStats {
  files: number;
  directories: number;
  bytes: number;
}

interface TreeFingerprint extends TreeStats {
  sha256: string;
}

interface PlanEntry extends ControlVaultDataManifestEntry {
  sourcePath: string;
  targetPath: string;
  stats: TreeStats;
}

interface PlanRewrite {
  source: string;
  target: string;
  sourcePath: string;
  targetPath: string;
  expectedVaultSuffix: string;
  sourceSha256: string;
  targetSha256: string;
}

export interface ControlVaultDataMigrationPlan {
  formatVersion: number;
  manifestDigest: string;
  legacyRoot: string;
  targetRoot: string;
  targetExportRoot: string;
  entries: PlanEntry[];
  rewrites: PlanRewrite[];
  vaultRoots: string[];
  ignoredSources: Array<{ source: string; path: string; sha256: string }>;
}

type EntryState = "planned" | "staged" | "applied" | "rolled-back";
type ReportState =
  | "planned"
  | "applying"
  | "applied"
  | "failed"
  | "rolling-back"
  | "rolled-back"
  | "rollback-failed";

interface ReportEntry extends Omit<PlanEntry, "sourcePath" | "targetPath"> {
  targetPath: string;
  state: EntryState;
  sourceFingerprint?: TreeFingerprint;
  targetFingerprint?: TreeFingerprint;
}

interface ReportRewrite extends PlanRewrite {
  state: EntryState;
}

export interface ControlVaultDataMigrationReport {
  formatVersion: number;
  mode: "dry-run" | "apply";
  state: ReportState;
  runId: string;
  createdAt: string;
  updatedAt: string;
  manifestDigest: string;
  legacyRoot: string;
  targetRoot: string;
  targetExportRoot: string;
  stagingPath?: string;
  entries: ReportEntry[];
  rewrites: ReportRewrite[];
  vaultRoots: string[];
  ignoredSources: Array<{ source: string; path: string; sha256: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${label} contains unsupported key '${key}'`);
    }
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function canonicalRelativePath(value: string, label: string): string {
  if (value.includes("\0") || path.isAbsolute(value)) {
    throw new Error(`${label} must be relative`);
  }
  const segments = value.split(/[\\/]+/u);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a relative path without traversal`);
  }
  return segments.join(path.sep);
}

function resolveUnderRoot(root: string, relative: string, label: string): string {
  const normalized = canonicalRelativePath(relative, label);
  const candidate = path.resolve(root, normalized);
  const escaped = path.relative(root, candidate);
  if (!escaped || escaped === ".." || escaped.startsWith(`..${path.sep}`) || path.isAbsolute(escaped)) {
    throw new Error(`${label} must resolve below its root`);
  }
  return candidate;
}

function pathExists(value: string): boolean {
  try {
    fs.lstatSync(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isBelow(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return Boolean(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || isBelow(left, right) || isBelow(right, left);
}

function assertDirectory(value: string, label: string): void {
  const stat = fs.lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
}

function ensureDirectory(root: string, target: string): void {
  if (!pathExists(root)) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assertDirectory(root, "Migration target root");
  const relative = path.relative(root, target);
  if (!relative || relative === ".") return;
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Migration directory must remain below its target root");
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!pathExists(current)) fs.mkdirSync(current, { mode: 0o700 });
    assertDirectory(current, "Migration target directory");
  }
}

function hashFile(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function scanTree(root: string, withContents: boolean): TreeStats | TreeFingerprint {
  const hash = crypto.createHash("sha256");
  const stats: TreeStats = { files: 0, directories: 0, bytes: 0 };
  const visit = (current: string, relative: string): void => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Migration data contains a symbolic link at '${relative}'`);
    }
    const mode = (stat.mode & 0o777).toString(8);
    if (stat.isDirectory()) {
      stats.directories += 1;
      hash.update(`D\0${relative}\0${mode}\n`);
      for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        visit(path.join(current, entry.name), path.posix.join(relative, entry.name));
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`Migration data contains an unsupported file at '${relative}'`);
    }
    stats.files += 1;
    stats.bytes += stat.size;
    hash.update(`F\0${relative}\0${mode}\0${stat.size}\0${withContents ? hashFile(current) : "metadata-only"}\n`);
  };
  visit(root, ".");
  return withContents ? { ...stats, sha256: hash.digest("hex") } : stats;
}

function fingerprintTree(root: string): TreeFingerprint {
  return scanTree(root, true) as TreeFingerprint;
}

function fingerprintsMatch(left: TreeFingerprint, right: TreeFingerprint): boolean {
  return left.sha256 === right.sha256
    && left.files === right.files
    && left.directories === right.directories
    && left.bytes === right.bytes;
}

function parseManifest(raw: unknown): ControlVaultDataManifest {
  if (!isRecord(raw)) throw new Error("Control/vault-data migration manifest must be an object");
  assertKnownKeys(raw, ["version", "entries", "specs", "ignoredSources"], "Migration manifest");
  if (raw.version !== 1) throw new Error("Migration manifest version must be 1");
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) {
    throw new Error("Migration manifest entries must not be empty");
  }
  if (!Array.isArray(raw.specs)) throw new Error("Migration manifest specs must be an array");
  const entries = raw.entries.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`entries[${index}] must be an object`);
    assertKnownKeys(entry, ["plane", "source", "target"], `entries[${index}]`);
    const plane = requireString(entry.plane, `entries[${index}].plane`);
    if (plane !== "control" && plane !== "vault-data") {
      throw new Error(`entries[${index}].plane is invalid`);
    }
    return {
      plane,
      source: requireString(entry.source, `entries[${index}].source`),
      target: requireString(entry.target, `entries[${index}].target`),
    } satisfies ControlVaultDataManifestEntry;
  });
  const specs = raw.specs.map((entry, index) => requireString(entry, `specs[${index}]`));
  const ignoredSources = raw.ignoredSources === undefined
    ? undefined
    : Array.isArray(raw.ignoredSources)
      ? raw.ignoredSources.map((entry, index) => requireString(entry, `ignoredSources[${index}]`))
      : (() => { throw new Error("Migration manifest ignoredSources must be an array"); })();
  return { version: 1, entries, specs, ...(ignoredSources ? { ignoredSources } : {}) };
}

export function readControlVaultDataManifest(filePath: string): {
  manifest: ControlVaultDataManifest;
  digest: string;
} {
  const content = fs.readFileSync(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw new Error(`Unable to parse migration manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    manifest: parseManifest(parsed),
    digest: crypto.createHash("sha256").update(content).digest("hex"),
  };
}

function assertEntryContract(entry: ControlVaultDataManifestEntry, index: number): {
  source: string;
  target: string;
} {
  const source = canonicalRelativePath(entry.source, `entries[${index}].source`);
  const target = canonicalRelativePath(entry.target, `entries[${index}].target`);
  if (entry.plane === "control") {
    if (!CONTROL_SOURCE_ROOTS.some((root) => source === root || source.startsWith(`${root}${path.sep}`))) {
      throw new Error(`entries[${index}] control source must be users, state, or backup-keys`);
    }
    if (!target.startsWith(`control${path.sep}`)) {
      throw new Error(`entries[${index}] control target must be below control/`);
    }
  } else {
    const sourcePosix = source.split(path.sep).join("/");
    const targetPosix = target.split(path.sep).join("/");
    if (!sourcePosix.startsWith(VAULT_SOURCE_PREFIX)) {
      throw new Error(`entries[${index}] vault-data source must be below exports/vaults/tenants/`);
    }
    if (!targetPosix.startsWith(VAULT_TARGET_PREFIX) || !targetPosix.endsWith("/workspaces")) {
      throw new Error(`entries[${index}] vault-data target must end in vault-data/.../workspaces`);
    }
    const sourceSuffix = sourcePosix.slice(VAULT_SOURCE_PREFIX.length);
    const expectedTarget = `${VAULT_TARGET_PREFIX}${sourceSuffix}/workspaces`;
    if (targetPosix !== expectedTarget) {
      throw new Error(`entries[${index}] vault-data target does not match its source scope`);
    }
  }
  return { source, target };
}

function assertUniquePaths(entries: PlanEntry[]): void {
  for (let index = 0; index < entries.length; index += 1) {
    for (const other of entries.slice(index + 1)) {
      if (pathsOverlap(entries[index]!.sourcePath, other.sourcePath)) {
        throw new Error("Migration source entries overlap");
      }
      if (pathsOverlap(entries[index]!.targetPath, other.targetPath)) {
        throw new Error("Migration target entries overlap");
      }
    }
  }
}

function assertInventoryCovered(root: string, sourcePaths: string[]): void {
  const covered = (candidate: string): boolean => sourcePaths.some((source) => candidate === source || isBelow(source, candidate));
  const hasMappedDescendant = (candidate: string): boolean => sourcePaths.some((source) => source === candidate || isBelow(candidate, source));
  const visit = (candidate: string): void => {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error(`Unlisted migration source is a symbolic link: ${candidate}`);
    if (covered(candidate)) return;
    if (!stat.isDirectory()) throw new Error(`Unlisted migration source data: ${candidate}`);
    const children = fs.readdirSync(candidate).map((name) => path.join(candidate, name));
    if (children.length === 0 && !hasMappedDescendant(candidate)) return;
    for (const child of children) visit(child);
  };
  visit(root);
}

function rewriteSpecDocument(
  sourcePath: string,
  targetExportRoot: string,
  expectedVaultSuffix: string,
): string {
  const document = yaml.load(fs.readFileSync(sourcePath, "utf8"));
  if (!isRecord(document) || !isRecord(document.attachments)) {
    throw new Error(`Spec is missing structured attachments: ${sourcePath}`);
  }
  const vaultData = document.attachments["vault-data"];
  if (!isRecord(vaultData) || !isRecord(vaultData.source)) {
    throw new Error(`Spec is missing structured vault-data source: ${sourcePath}`);
  }
  if (vaultData.source.kind !== "netfs") {
    throw new Error(`Spec vault-data source must be netfs during migration: ${sourcePath}`);
  }
  const subPath = String(vaultData.source.sub_path ?? "").replace(/^\/+|\/+$/gu, "");
  if (subPath !== expectedVaultSuffix) {
    throw new Error(`Spec vault-data sub_path does not match its mapped vault: ${sourcePath}`);
  }
  vaultData.mount_root = VAULT_DATA_RUNTIME_ROOTS[0];
  vaultData.durable_paths = [...VAULT_DATA_RUNTIME_ROOTS];
  vaultData.source.export_path = targetExportRoot;
  return yaml.dump(document, { noRefs: true, lineWidth: -1 });
}

function sha256Content(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function targetSpecPath(targetRoot: string, source: string): string {
  const normalized = source.split(path.sep).join("/");
  if (!normalized.startsWith("users/") || !normalized.endsWith(".agent.yaml")) {
    throw new Error(`Migration spec must be a saved users/*.agent.yaml path: ${source}`);
  }
  return path.join(targetRoot, "control", "users", ...normalized.slice("users/".length).split("/"));
}

function manifestIgnoredSourcePath(root: string, source: string): string {
  const resolved = resolveUnderRoot(root, source, "ignoredSources path");
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 0) {
    throw new Error(`Only empty regular files may be ignored by the migration: ${source}`);
  }
  return resolved;
}

function validateTargetExportRoot(targetExportRoot: string): string {
  const resolved = path.resolve(targetExportRoot);
  if (resolved === path.parse(resolved).root || path.basename(resolved) !== "vault-data") {
    throw new Error("Migration target export root must be an absolute path ending in /vault-data");
  }
  if (pathExists(resolved)) assertDirectory(resolved, "Migration target export root");
  return resolved;
}

export function createControlVaultDataMigrationPlan(input: {
  manifest: ControlVaultDataManifest;
  legacyRoot: string;
  targetRoot: string;
  targetExportRoot?: string;
  manifestDigest?: string;
}): ControlVaultDataMigrationPlan {
  const manifest = parseManifest(input.manifest);
  const legacyRoot = path.resolve(input.legacyRoot);
  const targetRoot = path.resolve(input.targetRoot);
  const targetExportRoot = validateTargetExportRoot(
    input.targetExportRoot ?? path.join(targetRoot, "vault-data"),
  );
  if (targetRoot === path.parse(targetRoot).root) {
    throw new Error("Migration target root must not be the filesystem root");
  }
  assertDirectory(legacyRoot, "Migration legacy root");

  const entries: PlanEntry[] = manifest.entries.map((rawEntry, index) => {
    const normalized = assertEntryContract(rawEntry, index);
    const sourcePath = resolveUnderRoot(legacyRoot, normalized.source, "Migration source");
    const targetPath = resolveUnderRoot(targetRoot, normalized.target, "Migration target");
    if (!pathExists(sourcePath)) throw new Error(`Migration source does not exist: ${normalized.source}`);
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) throw new Error(`Migration source must not be a symbolic link: ${normalized.source}`);
    if (stat.isDirectory() === false && stat.isFile() === false) {
      throw new Error(`Migration source must be a regular file or directory: ${normalized.source}`);
    }
    return {
      ...rawEntry,
      source: normalized.source,
      target: normalized.target,
      sourcePath,
      targetPath,
      stats: scanTree(sourcePath, false) as TreeStats,
    };
  });
  assertUniquePaths(entries);

  const sourcePaths = entries.map((entry) => entry.sourcePath);
  const inventoryRoots = [
    ...CONTROL_SOURCE_ROOTS,
    "exports/vaults",
  ].map((relative) => resolveUnderRoot(legacyRoot, relative, "Migration inventory root"));
  for (const root of inventoryRoots) {
    if (pathExists(root)) assertInventoryCovered(root, sourcePaths);
  }

  const rewrites: PlanRewrite[] = manifest.specs.map((source, index) => {
    const normalized = canonicalRelativePath(source, `specs[${index}]`);
    const sourcePath = resolveUnderRoot(legacyRoot, normalized, "Migration spec source");
    if (!pathExists(sourcePath)) throw new Error(`Migration spec does not exist: ${source}`);
    const targetPath = targetSpecPath(targetRoot, normalized);
    const specParts = normalized.split("/");
    if (specParts[2] !== "vaults" || specParts.length < 5) {
      throw new Error(`Migration spec is not inside a user vault: ${source}`);
    }
    const expectedVaultSuffix = `tenants/${specParts.slice(1, -1).join("/")}`;
    const rewritten = rewriteSpecDocument(sourcePath, targetExportRoot, expectedVaultSuffix);
    return {
      source: normalized,
      target: path.relative(targetRoot, targetPath).split(path.sep).join("/"),
      sourcePath,
      targetPath,
      expectedVaultSuffix,
      sourceSha256: sha256Content(fs.readFileSync(sourcePath, "utf8")),
      targetSha256: sha256Content(rewritten),
    };
  });

  const vaultRoots = Array.from(new Set(
    entries
      .filter((entry) => entry.plane === "vault-data")
      .map((entry) => path.dirname(entry.targetPath)),
  )).sort();
  const ignoredSources = (manifest.ignoredSources ?? []).map((source) => {
    const normalized = canonicalRelativePath(source, "ignoredSources");
    const ignoredPath = manifestIgnoredSourcePath(legacyRoot, normalized);
    return { source: normalized, path: ignoredPath, sha256: hashFile(ignoredPath) };
  });
  return {
    formatVersion: REPORT_VERSION,
    manifestDigest: input.manifestDigest ?? crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    legacyRoot,
    targetRoot,
    targetExportRoot,
    entries,
    rewrites,
    vaultRoots,
    ignoredSources,
  };
}

function writeJsonAtomically(filePath: string, value: unknown, rejectExisting = false): void {
  const absolutePath = path.resolve(filePath);
  if (rejectExisting && pathExists(absolutePath)) throw new Error(`Migration report already exists: ${absolutePath}`);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, absolutePath);
}

function reportPathOutsideRoots(reportPath: string, plan: ControlVaultDataMigrationPlan): void {
  const absolute = path.resolve(reportPath);
  if (isBelow(plan.legacyRoot, absolute) || isBelow(plan.targetRoot, absolute)) {
    throw new Error("Migration report must be outside the legacy and target roots");
  }
}

function migrationStagingPath(targetRoot: string, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("Invalid migration run ID");
  return path.join(targetRoot, STAGING_DIRECTORY, runId);
}

function reportEntry(entry: PlanEntry): ReportEntry {
  return { ...entry, state: "planned" };
}

function createReport(plan: ControlVaultDataMigrationPlan, mode: "dry-run" | "apply"): ControlVaultDataMigrationReport {
  const now = new Date().toISOString();
  return {
    formatVersion: REPORT_VERSION,
    mode,
    state: mode === "dry-run" ? "planned" : "applying",
    runId: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    manifestDigest: plan.manifestDigest,
    legacyRoot: plan.legacyRoot,
    targetRoot: plan.targetRoot,
    targetExportRoot: plan.targetExportRoot,
    entries: plan.entries.map(reportEntry),
    rewrites: plan.rewrites.map((rewrite) => ({ ...rewrite, state: "planned" })),
    vaultRoots: plan.vaultRoots,
    ignoredSources: plan.ignoredSources,
  };
}

function touch(report: ControlVaultDataMigrationReport): void {
  report.updatedAt = new Date().toISOString();
}

function safeRemove(pathValue: string, targetRoot: string): void {
  if (!pathExists(pathValue) || !isBelow(targetRoot, pathValue)) return;
  const stat = fs.lstatSync(pathValue);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to remove symbolic link: ${pathValue}`);
  fs.rmSync(pathValue, { recursive: true, force: false });
}

function safeRemoveEmpty(pathValue: string, targetRoot: string): void {
  if (!pathExists(pathValue) || !isBelow(targetRoot, pathValue)) return;
  const stat = fs.lstatSync(pathValue);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing to remove non-directory: ${pathValue}`);
  if (fs.readdirSync(pathValue).length === 0) fs.rmdirSync(pathValue);
}

function assertTargetsAbsent(plan: ControlVaultDataMigrationPlan): void {
  for (const entry of plan.entries) {
    if (pathExists(entry.targetPath)) throw new Error(`Migration target already exists: ${entry.target}`);
  }
}

function copyTreePreservingModes(sourcePath: string, targetPath: string, relative = "."): void {
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Migration data contains a symbolic link at '${relative}'`);
  }
  const mode = stat.mode & 0o777;
  if (stat.isDirectory()) {
    fs.mkdirSync(targetPath, { mode });
    fs.chmodSync(targetPath, mode);
    for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      copyTreePreservingModes(
        path.join(sourcePath, entry.name),
        path.join(targetPath, entry.name),
        path.posix.join(relative, entry.name),
      );
    }
    fs.chmodSync(targetPath, mode);
    fs.utimesSync(targetPath, stat.atime, stat.mtime);
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`Migration data contains an unsupported file at '${relative}'`);
  }
  fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(targetPath, mode);
  fs.utimesSync(targetPath, stat.atime, stat.mtime);
}

function applyRewrite(rewrite: PlanRewrite, targetExportRoot: string): void {
  const sourceContent = fs.readFileSync(rewrite.sourcePath, "utf8");
  if (sha256Content(sourceContent) !== rewrite.sourceSha256) {
    throw new Error(`Migration spec changed after planning: ${rewrite.source}`);
  }
  const rewritten = rewriteSpecDocument(
    rewrite.sourcePath,
    targetExportRoot,
    rewrite.expectedVaultSuffix,
  );
  fs.mkdirSync(path.dirname(rewrite.targetPath), { recursive: true, mode: 0o700 });
  const mode = fs.statSync(rewrite.targetPath).mode & 0o777;
  const temporaryPath = `${rewrite.targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, rewritten, { encoding: "utf8", mode });
  fs.renameSync(temporaryPath, rewrite.targetPath);
}

export function writeControlVaultDataDryRunReport(
  reportPath: string,
  plan: ControlVaultDataMigrationPlan,
): ControlVaultDataMigrationReport {
  reportPathOutsideRoots(reportPath, plan);
  const report = createReport(plan, "dry-run");
  writeJsonAtomically(reportPath, report, true);
  return report;
}

export function applyControlVaultDataMigration(input: {
  plan: ControlVaultDataMigrationPlan;
  reportPath: string;
}): ControlVaultDataMigrationReport {
  const { plan, reportPath } = input;
  reportPathOutsideRoots(reportPath, plan);
  assertTargetsAbsent(plan);
  const report = createReport(plan, "apply");
  const absoluteReportPath = path.resolve(reportPath);
  writeJsonAtomically(absoluteReportPath, report, true);
  const stagingPath = migrationStagingPath(plan.targetRoot, report.runId);
  report.stagingPath = stagingPath;
  touch(report);
  writeJsonAtomically(absoluteReportPath, report);
  try {
    ensureDirectory(plan.targetRoot, stagingPath);
    for (const [index, entry] of plan.entries.entries()) {
      const before = fingerprintTree(entry.sourcePath);
      const stagingEntry = path.join(stagingPath, String(index));
      ensureDirectory(plan.targetRoot, path.dirname(stagingEntry));
      copyTreePreservingModes(entry.sourcePath, stagingEntry);
      const sourceAfter = fingerprintTree(entry.sourcePath);
      const staged = fingerprintTree(stagingEntry);
      if (!fingerprintsMatch(before, sourceAfter) || !fingerprintsMatch(before, staged)) {
        throw new Error(`Migration fingerprint verification failed for ${entry.source}`);
      }
      const journal = report.entries[index]!;
      journal.sourceFingerprint = before;
      journal.targetFingerprint = staged;
      journal.state = "staged";
      touch(report);
      writeJsonAtomically(absoluteReportPath, report);
      ensureDirectory(plan.targetRoot, path.dirname(entry.targetPath));
      fs.renameSync(stagingEntry, entry.targetPath);
      journal.state = "applied";
      touch(report);
      writeJsonAtomically(absoluteReportPath, report);
    }

    for (const vaultRoot of plan.vaultRoots) {
      ensureDirectory(plan.targetRoot, vaultRoot);
      for (const directory of ["backups", "cache"]) {
        ensureDirectory(plan.targetRoot, path.join(vaultRoot, directory));
      }
    }
    for (const [index, rewrite] of plan.rewrites.entries()) {
      applyRewrite(rewrite, plan.targetExportRoot);
      const journal = report.rewrites[index]!;
      if (sha256Content(fs.readFileSync(rewrite.targetPath, "utf8")) !== rewrite.targetSha256) {
        throw new Error(`Migration spec rewrite verification failed for ${rewrite.source}`);
      }
      journal.state = "applied";
      touch(report);
      writeJsonAtomically(absoluteReportPath, report);
    }
    for (const [index, entry] of plan.entries.entries()) {
      report.entries[index]!.targetFingerprint = fingerprintTree(entry.targetPath);
    }
    safeRemove(stagingPath, plan.targetRoot);
    report.state = "applied";
    touch(report);
    writeJsonAtomically(absoluteReportPath, report);
    return report;
  } catch (error) {
    safeRemove(stagingPath, plan.targetRoot);
    report.state = "failed";
    touch(report);
    writeJsonAtomically(absoluteReportPath, report);
    throw error;
  }
}

function parseReport(raw: unknown): ControlVaultDataMigrationReport {
  if (!isRecord(raw) || raw.formatVersion !== REPORT_VERSION || (raw.mode !== "dry-run" && raw.mode !== "apply") || typeof raw.state !== "string" || typeof raw.runId !== "string" || !Array.isArray(raw.entries) || !Array.isArray(raw.rewrites) || !Array.isArray(raw.vaultRoots)) {
    throw new Error("Invalid control/vault-data migration report");
  }
  if (!RUN_ID_PATTERN.test(raw.runId)) throw new Error("Invalid migration report run ID");
  return raw as unknown as ControlVaultDataMigrationReport;
}

export function readControlVaultDataMigrationReport(filePath: string): ControlVaultDataMigrationReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to parse migration report: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseReport(parsed);
}

function validateReportRoots(report: ControlVaultDataMigrationReport, targetRoot: string): string {
  const resolved = path.resolve(targetRoot);
  if (path.resolve(report.targetRoot) !== resolved || resolved === path.parse(resolved).root) {
    throw new Error("Migration report target root does not match the requested root");
  }
  return resolved;
}

export function verifyControlVaultDataMigration(input: {
  reportPath: string;
  targetRoot: string;
}): { reportPath: string; targetRoot: string; entries: number; rewrites: number } {
  const report = readControlVaultDataMigrationReport(input.reportPath);
  const targetRoot = validateReportRoots(report, input.targetRoot);
  if (report.mode !== "apply" || report.state !== "applied") throw new Error("Only an applied migration can be verified");
  for (const entry of report.entries) {
    if (entry.state !== "applied" || !entry.targetFingerprint || !pathExists(entry.targetPath)) {
      throw new Error(`Migration entry is incomplete: ${entry.target}`);
    }
    if (!fingerprintsMatch(entry.targetFingerprint, fingerprintTree(entry.targetPath))) {
      throw new Error(`Migration target fingerprint changed: ${entry.target}`);
    }
  }
  for (const root of report.vaultRoots) {
    for (const directory of ["workspaces", "backups", "cache"]) {
      assertDirectory(path.join(root, directory), `Vault-data directory ${directory}`);
    }
  }
  for (const rewrite of report.rewrites) {
    if (rewrite.state !== "applied" || !pathExists(rewrite.targetPath) || sha256Content(fs.readFileSync(rewrite.targetPath, "utf8")) !== rewrite.targetSha256) {
      throw new Error(`Migration spec rewrite changed: ${rewrite.target}`);
    }
  }
  return {
    reportPath: path.resolve(input.reportPath),
    targetRoot,
    entries: report.entries.length,
    rewrites: report.rewrites.length,
  };
}

export function rollbackControlVaultDataMigration(input: {
  reportPath: string;
  targetRoot: string;
}): ControlVaultDataMigrationReport {
  const absoluteReportPath = path.resolve(input.reportPath);
  const report = readControlVaultDataMigrationReport(absoluteReportPath);
  const targetRoot = validateReportRoots(report, input.targetRoot);
  if (report.mode !== "apply" || !["applying", "applied", "failed", "rolling-back", "rollback-failed"].includes(report.state)) {
    throw new Error("Migration report is not eligible for rollback");
  }
  report.state = "rolling-back";
  touch(report);
  writeJsonAtomically(absoluteReportPath, report);
  try {
    for (const entry of [...report.entries].reverse()) {
      if (entry.state === "planned" || entry.state === "rolled-back") continue;
      if (!entry.targetFingerprint || !pathExists(entry.targetPath)) {
        throw new Error(`Migration target is missing or unjournaled: ${entry.target}`);
      }
      if (!fingerprintsMatch(entry.targetFingerprint, fingerprintTree(entry.targetPath))) {
        throw new Error(`Refusing to roll back changed target: ${entry.target}`);
      }
      safeRemove(entry.targetPath, targetRoot);
      entry.state = "rolled-back";
      touch(report);
      writeJsonAtomically(absoluteReportPath, report);
    }
    for (const root of report.vaultRoots) {
      for (const directory of ["backups", "cache", "workspaces"]) {
        safeRemoveEmpty(path.join(root, directory), targetRoot);
      }
      safeRemoveEmpty(root, targetRoot);
    }
    const emptyParents = Array.from(new Set(
      [
        ...report.entries.map((entry) => path.dirname(entry.targetPath)),
        ...report.vaultRoots.flatMap((root) => {
          const parents: string[] = [];
          let current = path.dirname(root);
          while (current !== targetRoot && isBelow(targetRoot, current)) {
            parents.push(current);
            current = path.dirname(current);
          }
          return parents;
        }),
      ],
    )).sort((left, right) => right.length - left.length);
    for (const parent of emptyParents) safeRemoveEmpty(parent, targetRoot);
    report.state = "rolled-back";
    touch(report);
    writeJsonAtomically(absoluteReportPath, report);
    return report;
  } catch (error) {
    report.state = "rollback-failed";
    touch(report);
    writeJsonAtomically(absoluteReportPath, report);
    throw error;
  }
}
