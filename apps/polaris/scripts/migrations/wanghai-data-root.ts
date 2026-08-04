import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveWanghaiHostDataRootsAtRoot } from "../config/wanghai-env.js";

const CATEGORIES = ["workspaces", "backups", "cache"] as const;
const REPORT_VERSION = 1;
const MIGRATION_STAGING_DIR = ".polaris-wanghai-migrations";
const MIGRATION_RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type WanghaiDataRootCategory = typeof CATEGORIES[number];

export interface WanghaiMigrationPath {
  source: string;
  target?: string;
}

export interface WanghaiMigrationMapping {
  tenantId: string;
  vaultId: string;
  workspaces?: WanghaiMigrationPath[];
  backups?: WanghaiMigrationPath[];
  cache?: WanghaiMigrationPath[];
}

export interface WanghaiMigrationManifest {
  version: 1;
  sourceRoots?: Partial<Record<WanghaiDataRootCategory, string>>;
  mappings: WanghaiMigrationMapping[];
}

export interface TreeStats {
  files: number;
  directories: number;
  bytes: number;
}

export interface TreeFingerprint extends TreeStats {
  sha256: string;
}

export interface WanghaiMigrationPlanEntry {
  mappingIndex: number;
  tenantId: string;
  vaultId: string;
  category: WanghaiDataRootCategory;
  sourceRelativePath: string;
  targetRelativePath: string;
  sourcePath: string;
  targetPath: string;
  stats: TreeStats;
}

export interface WanghaiMigrationPlan {
  formatVersion: number;
  manifestDigest: string;
  legacyRoot: string;
  targetRoot: string;
  entries: WanghaiMigrationPlanEntry[];
}

type ReportEntryState = "planned" | "staged" | "applied" | "rolled-back";
type ReportState = "planned" | "applying" | "applied" | "failed" | "rolling-back" | "rolled-back" | "rollback-failed";

export interface WanghaiMigrationReportEntry {
  mappingIndex: number;
  tenantId: string;
  vaultId: string;
  category: WanghaiDataRootCategory;
  sourceRelativePath: string;
  targetRelativePath: string;
  targetPath: string;
  stats: TreeStats;
  state: ReportEntryState;
  sourceFingerprint?: TreeFingerprint;
  targetFingerprint?: TreeFingerprint;
}

export interface WanghaiMigrationReport {
  formatVersion: number;
  mode: "dry-run" | "apply";
  state: ReportState;
  runId: string;
  createdAt: string;
  updatedAt: string;
  manifestDigest: string;
  legacyRoot: string;
  targetRoot: string;
  stagingPath?: string;
  entries: WanghaiMigrationReportEntry[];
}

export interface WanghaiMigrationVerification {
  reportPath: string;
  targetRoot: string;
  entries: Array<{
    category: WanghaiDataRootCategory;
    targetRelativePath: string;
    valid: boolean;
  }>;
}

const DEFAULT_SOURCE_ROOTS: Record<WanghaiDataRootCategory, string> = {
  workspaces: "vaults",
  backups: "backups",
  cache: "cache",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKnownKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new Error(`${label} contains unsupported key '${key}'`);
    }
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function parsePathEntries(value: unknown, label: string): WanghaiMigrationPath[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((item, index) => {
    if (typeof item === "string") {
      return { source: requireNonEmptyString(item, `${label}[${index}]`) };
    }
    if (!isRecord(item)) {
      throw new Error(`${label}[${index}] must be a path string or object`);
    }
    assertKnownKeys(item, ["source", "target"], `${label}[${index}]`);
    const target = item.target === undefined
      ? undefined
      : requireNonEmptyString(item.target, `${label}[${index}].target`);
    return {
      source: requireNonEmptyString(item.source, `${label}[${index}].source`),
      ...(target ? { target } : {}),
    };
  });
}

/** Parse a strict, explicit mapping manifest. */
export function parseWanghaiMigrationManifest(raw: unknown): WanghaiMigrationManifest {
  if (!isRecord(raw)) {
    throw new Error("Wanghai migration manifest must be a JSON object");
  }
  assertKnownKeys(raw, ["version", "sourceRoots", "mappings"], "Wanghai migration manifest");
  if (raw.version !== 1) {
    throw new Error("Wanghai migration manifest version must be 1");
  }

  let sourceRoots: Partial<Record<WanghaiDataRootCategory, string>> | undefined;
  if (raw.sourceRoots !== undefined) {
    if (!isRecord(raw.sourceRoots)) {
      throw new Error("Wanghai migration manifest sourceRoots must be an object");
    }
    assertKnownKeys(raw.sourceRoots, CATEGORIES, "Wanghai migration manifest sourceRoots");
    sourceRoots = {};
    for (const category of CATEGORIES) {
      const value = raw.sourceRoots[category];
      if (value !== undefined) {
        sourceRoots[category] = requireNonEmptyString(value, `sourceRoots.${category}`);
      }
    }
  }

  if (!Array.isArray(raw.mappings) || raw.mappings.length === 0) {
    throw new Error("Wanghai migration manifest mappings must contain at least one mapping");
  }
  const mappings = raw.mappings.map((mapping, index) => {
    if (!isRecord(mapping)) {
      throw new Error(`mappings[${index}] must be an object`);
    }
    assertKnownKeys(mapping, ["tenantId", "vaultId", ...CATEGORIES], `mappings[${index}]`);
    return {
      tenantId: requireNonEmptyString(mapping.tenantId, `mappings[${index}].tenantId`),
      vaultId: requireNonEmptyString(mapping.vaultId, `mappings[${index}].vaultId`),
      workspaces: parsePathEntries(mapping.workspaces, `mappings[${index}].workspaces`),
      backups: parsePathEntries(mapping.backups, `mappings[${index}].backups`),
      cache: parsePathEntries(mapping.cache, `mappings[${index}].cache`),
    } satisfies WanghaiMigrationMapping;
  });

  return {
    version: 1,
    ...(sourceRoots && Object.keys(sourceRoots).length > 0 ? { sourceRoots } : {}),
    mappings,
  };
}

export function readWanghaiMigrationManifest(filePath: string): {
  manifest: WanghaiMigrationManifest;
  digest: string;
} {
  const content = fs.readFileSync(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw new Error(`Unable to parse Wanghai migration manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    manifest: parseWanghaiMigrationManifest(parsed),
    digest: crypto.createHash("sha256").update(content).digest("hex"),
  };
}

function canonicalRelativePath(value: string, label: string): string {
  if (value.includes("\0")) {
    throw new Error(`${label} must not contain a NUL byte`);
  }
  const segments = value.split(/[\\/]+/u);
  if (segments.length === 0 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a non-empty relative path without traversal`);
  }
  if (path.isAbsolute(value)) {
    throw new Error(`${label} must be relative`);
  }
  return segments.join(path.sep);
}

function resolveUnderRoot(root: string, relativePath: string, label: string): string {
  const normalized = canonicalRelativePath(relativePath, label);
  const candidate = path.resolve(root, normalized);
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must resolve below its root`);
  }
  return candidate;
}

function isBelow(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || isBelow(left, right) || isBelow(right, left);
}

function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function assertDirectory(pathValue: string, label: string): void {
  const stat = fs.lstatSync(pathValue);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
}

function ensureDirectory(root: string, target: string): void {
  if (!pathExists(root)) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  assertDirectory(root, "Wanghai target root");
  const relative = path.relative(root, target);
  if (relative === "" || relative === ".") {
    return;
  }
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Migration target must remain below the Wanghai target root");
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!pathExists(current)) {
      fs.mkdirSync(current, { mode: 0o700 });
    }
    assertDirectory(current, "Migration target directory");
  }
}

function hashFile(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function scanTree(root: string, includeFileContents: boolean): TreeStats | TreeFingerprint {
  const hash = crypto.createHash("sha256");
  const stats: TreeStats = { files: 0, directories: 0, bytes: 0 };

  const visit = (current: string, relative: string): void => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Migration source contains a symbolic link at '${relative}'`);
    }
    const mode = (stat.mode & 0o777).toString(8);
    if (stat.isDirectory()) {
      stats.directories += 1;
      hash.update(`D\0${relative}\0${mode}\n`);
      const entries = fs.readdirSync(current, { withFileTypes: true })
        .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
      for (const entry of entries) {
        visit(path.join(current, entry.name), path.posix.join(relative, entry.name));
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`Migration source contains an unsupported file type at '${relative}'`);
    }
    stats.files += 1;
    stats.bytes += stat.size;
    const fileDigest = includeFileContents ? hashFile(current) : "metadata-only";
    hash.update(`F\0${relative}\0${mode}\0${stat.size}\0${fileDigest}\n`);
  };

  visit(root, ".");
  if (!includeFileContents) {
    return stats;
  }
  return { ...stats, sha256: hash.digest("hex") };
}

function scanTreeStats(root: string): TreeStats {
  return scanTree(root, false) as TreeStats;
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

function planDigest(manifest: WanghaiMigrationManifest): string {
  return crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function sourceRootFor(
  legacyRoot: string,
  manifest: WanghaiMigrationManifest,
  category: WanghaiDataRootCategory,
): string {
  const configured = manifest.sourceRoots?.[category] ?? DEFAULT_SOURCE_ROOTS[category];
  return resolveUnderRoot(legacyRoot, configured, `sourceRoots.${category}`);
}

function categoryTargetRoot(
  targetRoot: string,
  mapping: WanghaiMigrationMapping,
  category: WanghaiDataRootCategory,
): string {
  const roots = resolveWanghaiHostDataRootsAtRoot(targetRoot, mapping);
  if (category === "workspaces") return roots.workspacesRoot;
  if (category === "backups") return roots.backupRoot;
  return roots.cacheRoot;
}

function assertUniqueEntries(entries: WanghaiMigrationPlanEntry[]): void {
  for (let index = 0; index < entries.length; index += 1) {
    const current = entries[index]!;
    for (const other of entries.slice(index + 1)) {
      if (pathsOverlap(current.sourcePath, other.sourcePath)) {
        throw new Error(
          `Migration source paths overlap for mappings ${current.mappingIndex} and ${other.mappingIndex}`,
        );
      }
      if (pathsOverlap(current.targetPath, other.targetPath)) {
        throw new Error(
          `Migration target paths overlap for mappings ${current.mappingIndex} and ${other.mappingIndex}`,
        );
      }
    }
  }
}

/**
 * Build a no-write migration plan. It scans metadata only and never reads file
 * contents, copies data, or creates target directories.
 */
export function createWanghaiDataRootMigrationPlan(input: {
  manifest: WanghaiMigrationManifest;
  legacyRoot: string;
  targetRoot: string;
  manifestDigest?: string;
}): WanghaiMigrationPlan {
  const manifest = parseWanghaiMigrationManifest(input.manifest);
  const legacyRoot = path.resolve(input.legacyRoot);
  const targetRoot = path.resolve(input.targetRoot);
  if (targetRoot === path.parse(targetRoot).root) {
    throw new Error("Wanghai target root must not be the filesystem root");
  }
  assertDirectory(legacyRoot, "Wanghai legacy root");

  const mappedCategories = new Set<WanghaiDataRootCategory>();
  for (const mapping of manifest.mappings) {
    for (const category of CATEGORIES) {
      if ((mapping[category] ?? []).length > 0) {
        mappedCategories.add(category);
      }
    }
  }

  const sourceRoots = new Map<WanghaiDataRootCategory, string>();
  for (const category of CATEGORIES) {
    if (!mappedCategories.has(category)) {
      continue;
    }
    const sourceRoot = sourceRootFor(legacyRoot, manifest, category);
    assertDirectory(sourceRoot, `Wanghai legacy ${category} root`);
    sourceRoots.set(category, sourceRoot);
  }

  const entries: WanghaiMigrationPlanEntry[] = [];
  for (const [mappingIndex, mapping] of manifest.mappings.entries()) {
    for (const category of CATEGORIES) {
      if (!mappedCategories.has(category)) {
        continue;
      }
      const sourceRoot = sourceRoots.get(category)!;
      const targetCategoryRoot = categoryTargetRoot(targetRoot, mapping, category);
      if (pathsOverlap(sourceRoot, targetCategoryRoot)) {
        throw new Error(`Migration target for ${category} must not overlap its legacy source root`);
      }
      for (const item of mapping[category] ?? []) {
        const sourceRelativePath = canonicalRelativePath(
          item.source,
          `mappings[${mappingIndex}].${category}.source`,
        );
        const targetRelativePath = canonicalRelativePath(
          item.target ?? item.source,
          `mappings[${mappingIndex}].${category}.target`,
        );
        const sourcePath = resolveUnderRoot(sourceRoot, sourceRelativePath, "Migration source path");
        const targetPath = resolveUnderRoot(targetCategoryRoot, targetRelativePath, "Migration target path");
        if (!pathExists(sourcePath)) {
          throw new Error(`Migration source path does not exist: ${sourceRelativePath}`);
        }
        entries.push({
          mappingIndex,
          tenantId: mapping.tenantId,
          vaultId: mapping.vaultId,
          category,
          sourceRelativePath,
          targetRelativePath,
          sourcePath,
          targetPath,
          stats: scanTreeStats(sourcePath),
        });
      }
    }
  }

  if (entries.length === 0) {
    throw new Error("Wanghai migration manifest does not map any source data");
  }
  assertUniqueEntries(entries);
  return {
    formatVersion: REPORT_VERSION,
    manifestDigest: input.manifestDigest ?? planDigest(manifest),
    legacyRoot,
    targetRoot,
    entries,
  };
}

function reportEntry(entry: WanghaiMigrationPlanEntry): WanghaiMigrationReportEntry {
  return {
    mappingIndex: entry.mappingIndex,
    tenantId: entry.tenantId,
    vaultId: entry.vaultId,
    category: entry.category,
    sourceRelativePath: entry.sourceRelativePath,
    targetRelativePath: entry.targetRelativePath,
    targetPath: entry.targetPath,
    stats: entry.stats,
    state: "planned",
  };
}

function createReport(
  plan: WanghaiMigrationPlan,
  mode: "dry-run" | "apply",
): WanghaiMigrationReport {
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
    entries: plan.entries.map(reportEntry),
  };
}

function writeJsonAtomically(filePath: string, value: unknown, rejectExisting = false): void {
  const absolutePath = path.resolve(filePath);
  if (rejectExisting && pathExists(absolutePath)) {
    throw new Error(`Migration report already exists: ${absolutePath}`);
  }
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, absolutePath);
}

function touchReport(report: WanghaiMigrationReport): void {
  report.updatedAt = new Date().toISOString();
}

/** Write a no-copy dry-run report. Existing reports are never overwritten. */
export function writeWanghaiMigrationDryRunReport(
  reportPath: string,
  plan: WanghaiMigrationPlan,
): WanghaiMigrationReport {
  assertReportPathOutsideDataRoots(reportPath, plan);
  const report = createReport(plan, "dry-run");
  writeJsonAtomically(reportPath, report, true);
  return report;
}

function assertReportPathOutsideDataRoots(reportPath: string, plan: WanghaiMigrationPlan): void {
  const absolutePath = path.resolve(reportPath);
  if (isBelow(plan.legacyRoot, absolutePath) || isBelow(plan.targetRoot, absolutePath)) {
    throw new Error("Migration report must be stored outside the legacy and target data roots");
  }
}

function assertTargetsAbsent(plan: WanghaiMigrationPlan): void {
  for (const entry of plan.entries) {
    if (pathExists(entry.targetPath)) {
      throw new Error(`Migration target already exists: ${entry.targetPath}`);
    }
  }
}

function safeRemoveDirectory(directory: string, targetRoot: string): void {
  if (!pathExists(directory)) {
    return;
  }
  if (!isBelow(targetRoot, directory)) {
    throw new Error("Refusing to remove a migration staging directory outside the target root");
  }
  fs.rmSync(directory, { recursive: true, force: true });
}

function migrationStagingPath(targetRoot: string, runId: string): string {
  if (!MIGRATION_RUN_ID_PATTERN.test(runId)) {
    throw new Error("Invalid Wanghai migration run ID");
  }
  return path.join(path.resolve(targetRoot), MIGRATION_STAGING_DIR, runId);
}

function reportStagingPath(report: WanghaiMigrationReport, targetRoot: string): string | null {
  if (!report.stagingPath) {
    return null;
  }
  const expectedPath = migrationStagingPath(targetRoot, report.runId);
  if (path.resolve(report.stagingPath) !== expectedPath) {
    throw new Error("Migration report staging path does not match its run ID");
  }
  return expectedPath;
}

/**
 * Copy the planned source trees into new tenant-qualified roots. The source is
 * never modified. Each promoted tree is checked against pre- and post-copy
 * fingerprints and journaled before it becomes eligible for rollback.
 */
export function applyWanghaiDataRootMigration(input: {
  plan: WanghaiMigrationPlan;
  reportPath: string;
}): WanghaiMigrationReport {
  const { plan, reportPath } = input;
  assertReportPathOutsideDataRoots(reportPath, plan);
  assertTargetsAbsent(plan);
  const report = createReport(plan, "apply");
  const absoluteReportPath = path.resolve(reportPath);
  writeJsonAtomically(absoluteReportPath, report, true);
  const stagingPath = migrationStagingPath(plan.targetRoot, report.runId);
  report.stagingPath = stagingPath;
  touchReport(report);
  writeJsonAtomically(absoluteReportPath, report);

  try {
    ensureDirectory(plan.targetRoot, stagingPath);
    for (const [index, entry] of plan.entries.entries()) {
      if (pathExists(entry.targetPath)) {
        throw new Error(`Migration target appeared during apply: ${entry.targetPath}`);
      }
      const sourceBefore = fingerprintTree(entry.sourcePath);
      const stagingEntry = path.join(stagingPath, String(index));
      ensureDirectory(plan.targetRoot, path.dirname(stagingEntry));
      fs.cpSync(entry.sourcePath, stagingEntry, {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: false,
        preserveTimestamps: true,
      });
      const sourceAfter = fingerprintTree(entry.sourcePath);
      const stagedFingerprint = fingerprintTree(stagingEntry);
      if (!fingerprintsMatch(sourceBefore, sourceAfter)) {
        throw new Error(`Migration source changed while copying '${entry.sourceRelativePath}'`);
      }
      if (!fingerprintsMatch(sourceBefore, stagedFingerprint)) {
        throw new Error(`Migration verification failed for '${entry.sourceRelativePath}'`);
      }

      const journalEntry = report.entries[index]!;
      journalEntry.sourceFingerprint = sourceBefore;
      journalEntry.targetFingerprint = stagedFingerprint;
      journalEntry.state = "staged";
      touchReport(report);
      writeJsonAtomically(absoluteReportPath, report);

      ensureDirectory(plan.targetRoot, path.dirname(entry.targetPath));
      fs.renameSync(stagingEntry, entry.targetPath);
      journalEntry.state = "applied";
      touchReport(report);
      writeJsonAtomically(absoluteReportPath, report);
    }
    safeRemoveDirectory(stagingPath, plan.targetRoot);
    report.state = "applied";
    touchReport(report);
    writeJsonAtomically(absoluteReportPath, report);
    return report;
  } catch (error) {
    safeRemoveDirectory(stagingPath, plan.targetRoot);
    report.state = "failed";
    touchReport(report);
    writeJsonAtomically(absoluteReportPath, report);
    throw error;
  }
}

function assertReport(value: unknown): asserts value is WanghaiMigrationReport {
  if (!isRecord(value)
    || value.formatVersion !== REPORT_VERSION
    || (value.mode !== "dry-run" && value.mode !== "apply")
    || typeof value.state !== "string"
    || typeof value.runId !== "string"
    || typeof value.targetRoot !== "string"
    || !Array.isArray(value.entries)) {
    throw new Error("Invalid Wanghai migration report");
  }
  const reportStates: readonly string[] = [
    "planned",
    "applying",
    "applied",
    "failed",
    "rolling-back",
    "rolled-back",
    "rollback-failed",
  ];
  if (!reportStates.includes(value.state)) {
    throw new Error("Invalid Wanghai migration report state");
  }
  if (!MIGRATION_RUN_ID_PATTERN.test(value.runId)) {
    throw new Error("Invalid Wanghai migration report run ID");
  }
  for (const entry of value.entries) {
    if (!isRecord(entry)
      || typeof entry.tenantId !== "string"
      || typeof entry.vaultId !== "string"
      || !CATEGORIES.includes(entry.category as WanghaiDataRootCategory)
      || typeof entry.targetRelativePath !== "string"
      || typeof entry.targetPath !== "string"
      || typeof entry.state !== "string") {
      throw new Error("Invalid Wanghai migration report entry");
    }
  }
}

export function readWanghaiMigrationReport(reportPath: string): WanghaiMigrationReport {
  const content = fs.readFileSync(reportPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Unable to parse Wanghai migration report: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertReport(parsed);
  return parsed;
}

function validateReportTargetRoot(report: WanghaiMigrationReport, targetRoot: string): string {
  const resolvedTargetRoot = path.resolve(targetRoot);
  if (path.resolve(report.targetRoot) !== resolvedTargetRoot) {
    throw new Error("Migration report target root does not match the requested target root");
  }
  if (resolvedTargetRoot === path.parse(resolvedTargetRoot).root) {
    throw new Error("Wanghai target root must not be the filesystem root");
  }
  return resolvedTargetRoot;
}

function reportEntryTargetPath(entry: WanghaiMigrationReportEntry, targetRoot: string): string {
  const targetPath = path.resolve(entry.targetPath);
  if (!isBelow(targetRoot, targetPath)) {
    throw new Error("Migration report contains a target outside the requested target root");
  }
  const roots = resolveWanghaiHostDataRootsAtRoot(targetRoot, entry);
  const categoryRoot = entry.category === "workspaces"
    ? roots.workspacesRoot
    : entry.category === "backups"
      ? roots.backupRoot
      : roots.cacheRoot;
  const expectedTargetPath = resolveUnderRoot(
    categoryRoot,
    entry.targetRelativePath,
    "Migration report target path",
  );
  if (targetPath !== expectedTargetPath) {
    throw new Error("Migration report target path does not match its tenant and vault scope");
  }
  return expectedTargetPath;
}

/** Recalculate target digests without reading legacy source data. */
export function verifyWanghaiDataRootMigration(input: {
  reportPath: string;
  targetRoot: string;
}): WanghaiMigrationVerification {
  const report = readWanghaiMigrationReport(input.reportPath);
  const targetRoot = validateReportTargetRoot(report, input.targetRoot);
  if (report.mode !== "apply" || report.state !== "applied") {
    throw new Error("Only a completed apply report can be verified");
  }

  const entries = report.entries.map((entry) => {
    if (entry.state !== "applied" || !entry.targetFingerprint) {
      throw new Error("Migration report has an incomplete applied entry");
    }
    const targetPath = reportEntryTargetPath(entry, targetRoot);
    if (!pathExists(targetPath)) {
      throw new Error(`Migrated target is missing: ${entry.targetRelativePath}`);
    }
    const actual = fingerprintTree(targetPath);
    if (!fingerprintsMatch(entry.targetFingerprint, actual)) {
      throw new Error(`Migrated target verification failed: ${entry.targetRelativePath}`);
    }
    return {
      category: entry.category,
      targetRelativePath: entry.targetRelativePath,
      valid: true,
    };
  });
  return {
    reportPath: path.resolve(input.reportPath),
    targetRoot,
    entries,
  };
}

/**
 * Remove only target copies whose current digest still matches the journal.
 * Legacy source data is never removed. Any changed target stops the rollback.
 */
export function rollbackWanghaiDataRootMigration(input: {
  reportPath: string;
  targetRoot: string;
}): WanghaiMigrationReport {
  const absoluteReportPath = path.resolve(input.reportPath);
  const report = readWanghaiMigrationReport(absoluteReportPath);
  const targetRoot = validateReportTargetRoot(report, input.targetRoot);
  const stagingPath = reportStagingPath(report, targetRoot);
  if (report.mode !== "apply"
    || !["applying", "applied", "failed", "rolling-back", "rollback-failed"].includes(report.state)) {
    throw new Error("Migration report is not eligible for rollback");
  }

  report.state = "rolling-back";
  touchReport(report);
  writeJsonAtomically(absoluteReportPath, report);
  try {
    for (const entry of [...report.entries].reverse()) {
      if (entry.state === "rolled-back") {
        continue;
      }
      if (entry.state === "planned") {
        continue;
      }
      if (!entry.targetFingerprint) {
        throw new Error("Migration report entry has no target fingerprint");
      }
      const targetPath = reportEntryTargetPath(entry, targetRoot);
      if (!pathExists(targetPath) && entry.state === "staged") {
        continue;
      }
      if (!pathExists(targetPath)) {
        throw new Error(`Migrated target is missing: ${entry.targetRelativePath}`);
      }
      const actual = fingerprintTree(targetPath);
      if (!fingerprintsMatch(entry.targetFingerprint, actual)) {
        throw new Error(`Refusing to roll back changed target: ${entry.targetRelativePath}`);
      }
      fs.rmSync(targetPath, { recursive: true, force: false });
      entry.state = "rolled-back";
      touchReport(report);
      writeJsonAtomically(absoluteReportPath, report);
    }
    if (stagingPath) {
      safeRemoveDirectory(stagingPath, targetRoot);
    }
    report.state = "rolled-back";
    touchReport(report);
    writeJsonAtomically(absoluteReportPath, report);
    return report;
  } catch (error) {
    report.state = "rollback-failed";
    touchReport(report);
    writeJsonAtomically(absoluteReportPath, report);
    throw error;
  }
}
