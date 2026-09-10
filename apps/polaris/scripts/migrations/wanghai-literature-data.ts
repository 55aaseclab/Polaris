import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const REPORT_VERSION = 1;
const STAGING_DIRECTORY = ".polaris-wanghai-literature-migrations";
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const WORKSPACE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const EXCLUDED_DIRECTORY_NAMES = new Set([
  "__pycache__",
  ".pytest_cache",
  ".venv",
  "node_modules",
  "browser-profile",
  "chrome-profile",
  "brightdata-venv",
]);
const EXCLUDED_FILE_SUFFIXES = [".pyc", ".pyo", ".crdownload"];

export interface LiteratureDataScope {
  tenantId: string;
  vaultId: string;
  workspaceId: string;
}

export interface LiteratureDataMapping {
  source: string;
  target: string;
  purpose: "collections" | "workflow-history" | "shared-history" | "metadata";
}

export interface LiteratureDataMigrationPlan {
  formatVersion: number;
  sourceRoot: string;
  archiveRoot: string;
  targetRoot: string;
  scope: LiteratureDataScope;
  mappings: LiteratureDataMapping[];
  entries: LiteratureDataPlanEntry[];
  sourceInventory: SourceInventory;
  workflowIds: string[];
}

export interface TreeStats {
  files: number;
  directories: number;
  bytes: number;
}

export interface TreeFingerprint extends TreeStats {
  sha256: string;
}

export interface LiteratureDataPlanEntry extends LiteratureDataMapping {
  sourcePath: string;
  targetPath: string;
  stats: TreeStats;
}

export interface SkippedSymlink {
  path: string;
  target: string;
  exists: boolean;
}

export interface SourceInventory {
  symlinks: SkippedSymlink[];
  excludedDirectories: string[];
  excludedFiles: string[];
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

export interface LiteratureDataReportEntry extends LiteratureDataPlanEntry {
  state: EntryState;
  sourceFingerprint?: TreeFingerprint;
  targetFingerprint?: TreeFingerprint;
}

export interface LiteratureDataMigrationReport {
  formatVersion: number;
  mode: "dry-run" | "apply";
  state: ReportState;
  runId: string;
  createdAt: string;
  updatedAt: string;
  sourceRoot: string;
  archiveRoot: string;
  targetRoot: string;
  scope: LiteratureDataScope;
  mappings: LiteratureDataMapping[];
  entries: LiteratureDataReportEntry[];
  sourceInventory: SourceInventory;
  workflowIds: string[];
  historicalOnly: true;
  generatedIndexPath?: string;
  generatedIndexSha256?: string;
}

const DEFAULT_MAPPINGS: LiteratureDataMapping[] = [
  {
    source: "data-collections",
    target: "data-collections",
    purpose: "collections",
  },
  {
    source: "workflows",
    target: "legacy-workflows",
    purpose: "workflow-history",
  },
  {
    source: "report-writing",
    target: "legacy-report-writing",
    purpose: "shared-history",
  },
  {
    source: "assets",
    target: "legacy-assets",
    purpose: "shared-history",
  },
  {
    source: "workspace.json",
    target: "metadata/workspace.json",
    purpose: "metadata",
  },
  {
    source: "workspace-layout.json",
    target: "metadata/workspace-layout.json",
    purpose: "metadata",
  },
  {
    source: "workflows.yaml",
    target: "metadata/workflows.yaml",
    purpose: "metadata",
  },
  {
    source: "README.md",
    target: "metadata/README.md",
    purpose: "metadata",
  },
  {
    source: "MOVE-LOG.txt",
    target: "metadata/MOVE-LOG.txt",
    purpose: "metadata",
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireScopePart(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes("/") || normalized.includes("\\") || normalized.includes("\0")) {
    throw new Error(`${label} must be a single non-empty path component`);
  }
  return normalized;
}

function requireWorkspaceId(value: string): string {
  const normalized = value.trim();
  if (!WORKSPACE_ID_PATTERN.test(normalized)) {
    throw new Error("workspaceId must be a lowercase workspace identifier");
  }
  return normalized;
}

function assertRealDirectory(value: string, label: string): void {
  const stat = fs.lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
}

function exists(value: string): boolean {
  try {
    fs.lstatSync(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function canonicalRelative(value: string, label: string): string {
  if (!value || value.includes("\0") || path.isAbsolute(value)) {
    throw new Error(`${label} must be relative`);
  }
  const segments = value.split(/[\\/]+/u);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} must not contain traversal`);
  }
  return segments.join(path.sep);
}

function resolveChild(root: string, relative: string, label: string): string {
  const normalized = canonicalRelative(relative, label);
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, normalized);
  const relation = path.relative(resolvedRoot, candidate);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`${label} must remain below its root`);
  }
  return candidate;
}

function assertNonRoot(value: string, label: string): string {
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new Error(`${label} must not be the filesystem root`);
  }
  return resolved;
}

function sortedEntries(directory: string): fs.Dirent[] {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => {
    return Buffer.compare(Buffer.from(left.name), Buffer.from(right.name));
  });
}

function excludedDirectory(name: string): boolean {
  return EXCLUDED_DIRECTORY_NAMES.has(name);
}

function excludedFile(name: string): boolean {
  return EXCLUDED_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function scanInventory(root: string): SourceInventory {
  const inventory: SourceInventory = {
    symlinks: [],
    excludedDirectories: [],
    excludedFiles: [],
  };
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of sortedEntries(current)) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute);
        inventory.symlinks.push({
          path: relative,
          target,
          exists: fs.existsSync(absolute),
        });
        continue;
      }
      if (entry.isDirectory()) {
        if (excludedDirectory(entry.name)) {
          inventory.excludedDirectories.push(relative);
        }
        // Walk excluded directories for symlink inventory without copying
        // their runtime material. This makes the omission auditable.
        stack.push(absolute);
        continue;
      }
      if (entry.isFile() && excludedFile(entry.name)) {
        inventory.excludedFiles.push(relative);
      }
    }
  }
  return inventory;
}

function hashFile(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

interface ScanOptions {
  collectInventory: boolean;
}

function scanTree(root: string, options: ScanOptions): {
  stats: TreeStats;
  fingerprint: TreeFingerprint;
  inventory: SourceInventory;
} {
  const hash = crypto.createHash("sha256");
  const stats: TreeStats = { files: 0, directories: 0, bytes: 0 };
  const inventory: SourceInventory = {
    symlinks: [],
    excludedDirectories: [],
    excludedFiles: [],
  };

  const visit = (current: string, relative: string): void => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      if (options.collectInventory) {
        inventory.symlinks.push({
          path: relative,
          target: fs.readlinkSync(current),
          exists: fs.existsSync(current),
        });
      }
      return;
    }
    if (stat.isDirectory()) {
      stats.directories += 1;
      hash.update(`D\0${relative}\0${(stat.mode & 0o777).toString(8)}\n`);
      for (const entry of sortedEntries(current)) {
        const childRelative = path.posix.join(relative, entry.name);
        if (entry.isSymbolicLink()) {
          visit(path.join(current, entry.name), childRelative);
          continue;
        }
        if (entry.isDirectory() && excludedDirectory(entry.name)) {
          if (options.collectInventory) inventory.excludedDirectories.push(childRelative);
          continue;
        }
        if (entry.isFile() && excludedFile(entry.name)) {
          if (options.collectInventory) inventory.excludedFiles.push(childRelative);
          continue;
        }
        visit(path.join(current, entry.name), childRelative);
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`Unsupported source file type at '${relative}'`);
    }
    const digest = hashFile(current);
    stats.files += 1;
    stats.bytes += stat.size;
    hash.update(`F\0${relative}\0${(stat.mode & 0o777).toString(8)}\0${stat.size}\0${digest}\n`);
  };

  visit(root, ".");
  return {
    stats,
    fingerprint: { ...stats, sha256: hash.digest("hex") },
    inventory,
  };
}

function fingerprintsMatch(left: TreeFingerprint, right: TreeFingerprint): boolean {
  return left.sha256 === right.sha256
    && left.files === right.files
    && left.directories === right.directories
    && left.bytes === right.bytes;
}

function mergeInventory(left: SourceInventory, right: SourceInventory): SourceInventory {
  return {
    symlinks: [...left.symlinks, ...right.symlinks],
    excludedDirectories: [...left.excludedDirectories, ...right.excludedDirectories],
    excludedFiles: [...left.excludedFiles, ...right.excludedFiles],
  };
}

function readWorkflowIds(sourcePath: string): string[] {
  const workflowConfig = path.join(sourcePath, "workflows.yaml");
  if (!fs.existsSync(workflowConfig)) return [];
  const parsed = yaml.load(fs.readFileSync(workflowConfig, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.workflows)) return [];
  return Object.keys(parsed.workflows).sort((left, right) => left.localeCompare(right));
}

function archiveTargetRoot(archiveRoot: string, scope: LiteratureDataScope): string {
  return path.join(
    archiveRoot,
    "tenants",
    requireScopePart(scope.tenantId, "tenantId"),
    "vaults",
    requireScopePart(scope.vaultId, "vaultId"),
    requireWorkspaceId(scope.workspaceId),
  );
}

function defaultMappings(): LiteratureDataMapping[] {
  return DEFAULT_MAPPINGS.map((mapping) => ({ ...mapping }));
}

export function createWanghaiLiteratureDataMigrationPlan(input: {
  sourceRoot: string;
  archiveRoot: string;
  scope: LiteratureDataScope;
  mappings?: LiteratureDataMapping[];
}): LiteratureDataMigrationPlan {
  const sourceRoot = assertNonRoot(input.sourceRoot, "Literature source root");
  const archiveRoot = assertNonRoot(input.archiveRoot, "Polaris archive root");
  assertRealDirectory(sourceRoot, "Literature source root");
  const targetRoot = archiveTargetRoot(archiveRoot, input.scope);
  if (path.resolve(sourceRoot) === path.resolve(targetRoot)) {
    throw new Error("Literature source and archive target must be different");
  }

  const mappings = (input.mappings ?? defaultMappings()).map((mapping, index) => ({
    source: canonicalRelative(mapping.source, `mappings[${index}].source`),
    target: canonicalRelative(mapping.target, `mappings[${index}].target`),
    purpose: mapping.purpose,
  }));
  const entries: LiteratureDataPlanEntry[] = [];
  const targetPaths: string[] = [];
  const inventory = scanInventory(sourceRoot);
  for (const mapping of mappings) {
    const sourcePath = resolveChild(sourceRoot, mapping.source, "Mapping source");
    const targetPath = resolveChild(targetRoot, mapping.target, "Mapping target");
    if (!exists(sourcePath)) throw new Error(`Literature source does not exist: ${mapping.source}`);
    if (targetPaths.some((candidate) => candidate === targetPath
      || candidate.startsWith(`${targetPath}${path.sep}`)
      || targetPath.startsWith(`${candidate}${path.sep}`))) {
      throw new Error(`Literature migration target mappings overlap at ${mapping.target}`);
    }
    targetPaths.push(targetPath);
    const scan = scanTree(sourcePath, { collectInventory: false });
    entries.push({ ...mapping, sourcePath, targetPath, stats: scan.stats });
  }
  if (entries.length === 0) throw new Error("Literature migration must contain at least one mapping");

  return {
    formatVersion: REPORT_VERSION,
    sourceRoot,
    archiveRoot,
    targetRoot,
    scope: {
      tenantId: requireScopePart(input.scope.tenantId, "tenantId"),
      vaultId: requireScopePart(input.scope.vaultId, "vaultId"),
      workspaceId: requireWorkspaceId(input.scope.workspaceId),
    },
    mappings,
    entries,
    sourceInventory: inventory,
    workflowIds: readWorkflowIds(sourceRoot),
  };
}

function writeJsonAtomically(filePath: string, value: unknown, rejectExisting = false): void {
  const absolute = path.resolve(filePath);
  if (rejectExisting && exists(absolute)) throw new Error(`Migration report already exists: ${absolute}`);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, absolute);
}

function touch(report: LiteratureDataMigrationReport): void {
  report.updatedAt = new Date().toISOString();
}

function reportEntry(entry: LiteratureDataPlanEntry): LiteratureDataReportEntry {
  return { ...entry, state: "planned" };
}

function createReport(
  plan: LiteratureDataMigrationPlan,
  mode: "dry-run" | "apply",
): LiteratureDataMigrationReport {
  const now = new Date().toISOString();
  return {
    formatVersion: REPORT_VERSION,
    mode,
    state: mode === "dry-run" ? "planned" : "applying",
    runId: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    sourceRoot: plan.sourceRoot,
    archiveRoot: plan.archiveRoot,
    targetRoot: plan.targetRoot,
    scope: plan.scope,
    mappings: plan.mappings,
    entries: plan.entries.map(reportEntry),
    sourceInventory: plan.sourceInventory,
    workflowIds: plan.workflowIds,
    historicalOnly: true,
  };
}

function assertReportPathSafe(reportPath: string, plan: LiteratureDataMigrationPlan): void {
  const absolute = path.resolve(reportPath);
  if (absolute === plan.targetRoot || absolute.startsWith(`${plan.targetRoot}${path.sep}`)) {
    throw new Error("Migration report must not be stored below the archive target");
  }
}

function stagingPath(archiveRoot: string, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("Invalid literature migration run ID");
  return path.join(archiveRoot, STAGING_DIRECTORY, runId);
}

function ensureDirectory(target: string): void {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  assertRealDirectory(target, "Migration directory");
}

function copyFilteredTree(sourcePath: string, targetPath: string): void {
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to copy symbolic link '${sourcePath}'`);
  }
  const mode = stat.mode & 0o777;
  if (stat.isDirectory()) {
    fs.mkdirSync(targetPath, { mode });
    fs.chmodSync(targetPath, mode);
    for (const entry of sortedEntries(sourcePath)) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && excludedDirectory(entry.name)) continue;
      if (entry.isFile() && excludedFile(entry.name)) continue;
      copyFilteredTree(path.join(sourcePath, entry.name), path.join(targetPath, entry.name));
    }
    fs.chmodSync(targetPath, mode);
    fs.utimesSync(targetPath, stat.atime, stat.mtime);
    return;
  }
  if (!stat.isFile()) throw new Error(`Unsupported source file type at '${sourcePath}'`);
  fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(targetPath, mode);
  fs.utimesSync(targetPath, stat.atime, stat.mtime);
}

function generatedIndex(report: LiteratureDataMigrationReport): Record<string, unknown> {
  return {
    schema_version: "polaris.wanghai-literature-archive.v1",
    historical_only: true,
    scope: report.scope,
    source_workspace: "literature-review",
    polaris_workspace: report.scope.workspaceId,
    polaris_workflow_definition: "packs/autoresearch/main.ord",
    legacy_workflow_ids: report.workflowIds,
    mappings: report.mappings.map(({ source, target, purpose }) => ({ source, target, purpose })),
    excluded_runtime_material: {
      directories: ["__pycache__", ".pytest_cache", ".venv", "node_modules", "browser-profile", "chrome-profile", "brightdata-venv"],
      file_suffixes: EXCLUDED_FILE_SUFFIXES,
      symbolic_links: report.sourceInventory.symlinks.length,
    },
    execution_boundary: "Imported artifacts are evidence only; old Wanghai run state is not a Polaris durable run.",
  };
}

function indexPath(targetRoot: string): string {
  return path.join(targetRoot, "IMPORT.json");
}

function indexDigest(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function assertTargetsAbsent(plan: LiteratureDataMigrationPlan): void {
  if (exists(plan.targetRoot)) throw new Error(`Literature archive target already exists: ${plan.targetRoot}`);
}

function sourceFingerprint(entry: LiteratureDataPlanEntry): TreeFingerprint {
  return scanTree(entry.sourcePath, { collectInventory: false }).fingerprint;
}

function targetFingerprint(entry: LiteratureDataPlanEntry): TreeFingerprint {
  return scanTree(entry.targetPath, { collectInventory: false }).fingerprint;
}

export function writeWanghaiLiteratureDataDryRunReport(
  reportPath: string,
  plan: LiteratureDataMigrationPlan,
): LiteratureDataMigrationReport {
  assertReportPathSafe(reportPath, plan);
  const report = createReport(plan, "dry-run");
  writeJsonAtomically(reportPath, report, true);
  return report;
}

export function applyWanghaiLiteratureDataMigration(input: {
  plan: LiteratureDataMigrationPlan;
  reportPath: string;
}): LiteratureDataMigrationReport {
  const { plan, reportPath } = input;
  assertReportPathSafe(reportPath, plan);
  assertTargetsAbsent(plan);
  const report = createReport(plan, "apply");
  const absoluteReportPath = path.resolve(reportPath);
  writeJsonAtomically(absoluteReportPath, report, true);
  const stageRoot = stagingPath(plan.archiveRoot, report.runId);
  try {
    ensureDirectory(stageRoot);
    for (const [index, entry] of plan.entries.entries()) {
      const before = sourceFingerprint(entry);
      const stageEntry = path.join(stageRoot, entry.target);
      ensureDirectory(path.dirname(stageEntry));
      copyFilteredTree(entry.sourcePath, stageEntry);
      const after = sourceFingerprint(entry);
      const staged = targetFingerprint({ ...entry, targetPath: stageEntry });
      if (!fingerprintsMatch(before, after)) {
        throw new Error(`Literature source changed while copying '${entry.source}'`);
      }
      if (!fingerprintsMatch(before, staged)) {
        throw new Error(`Literature archive verification failed for '${entry.source}'`);
      }
      const journal = report.entries[index]!;
      journal.sourceFingerprint = before;
      journal.targetFingerprint = staged;
      journal.state = "staged";
      touch(report);
      writeJsonAtomically(absoluteReportPath, report);
    }

    const generatedPath = indexPath(stageRoot);
    const generated = generatedIndex(report);
    writeJsonAtomically(generatedPath, generated);
    report.generatedIndexPath = indexPath(plan.targetRoot);
    report.generatedIndexSha256 = indexDigest(generatedPath);
    ensureDirectory(path.dirname(plan.targetRoot));
    fs.renameSync(stageRoot, plan.targetRoot);
    for (const entry of report.entries) entry.state = "applied";
    report.state = "applied";
    touch(report);
    writeJsonAtomically(absoluteReportPath, report);
    return report;
  } catch (error) {
    if (exists(stageRoot)) fs.rmSync(stageRoot, { recursive: true, force: true });
    report.state = "failed";
    touch(report);
    writeJsonAtomically(absoluteReportPath, report);
    throw error;
  }
}

function readReport(reportPath: string): LiteratureDataMigrationReport {
  const parsed: unknown = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (!isRecord(parsed)
    || parsed.formatVersion !== REPORT_VERSION
    || (parsed.mode !== "dry-run" && parsed.mode !== "apply")
    || typeof parsed.state !== "string"
    || typeof parsed.runId !== "string"
    || typeof parsed.targetRoot !== "string"
    || !Array.isArray(parsed.entries)) {
    throw new Error("Invalid Wanghai literature migration report");
  }
  if (!RUN_ID_PATTERN.test(parsed.runId)) throw new Error("Invalid Wanghai literature migration report run ID");
  return parsed as unknown as LiteratureDataMigrationReport;
}

function reportTargetPath(entry: LiteratureDataReportEntry, targetRoot: string): string {
  const target = path.resolve(entry.targetPath);
  const expected = resolveChild(targetRoot, entry.target, "Report target");
  if (target !== expected) throw new Error(`Report target does not match mapping '${entry.target}'`);
  return expected;
}

export function verifyWanghaiLiteratureDataMigration(input: {
  reportPath: string;
  archiveRoot: string;
}): { reportPath: string; targetRoot: string; entries: number; valid: true } {
  const report = readReport(input.reportPath);
  const targetRoot = path.resolve(report.targetRoot);
  const expectedArchiveRoot = path.resolve(input.archiveRoot);
  if (path.resolve(report.archiveRoot) !== expectedArchiveRoot) {
    throw new Error("Migration report archive root does not match the requested root");
  }
  if (report.mode !== "apply" || report.state !== "applied") {
    throw new Error("Only an applied literature migration can be verified");
  }
  for (const entry of report.entries) {
    if (entry.state !== "applied" || !entry.targetFingerprint) {
      throw new Error("Literature migration report contains an incomplete entry");
    }
    const target = reportTargetPath(entry, targetRoot);
    if (!exists(target)) throw new Error(`Migrated literature entry is missing: ${entry.target}`);
    if (!fingerprintsMatch(entry.targetFingerprint, targetFingerprint({ ...entry, targetPath: target }))) {
      throw new Error(`Migrated literature entry changed: ${entry.target}`);
    }
  }
  if (!report.generatedIndexPath || !report.generatedIndexSha256 || !exists(report.generatedIndexPath)) {
    throw new Error("Migrated literature archive index is missing");
  }
  if (indexDigest(report.generatedIndexPath) !== report.generatedIndexSha256) {
    throw new Error("Migrated literature archive index changed");
  }
  return {
    reportPath: path.resolve(input.reportPath),
    targetRoot,
    entries: report.entries.length,
    valid: true,
  };
}

export function rollbackWanghaiLiteratureDataMigration(input: {
  reportPath: string;
  archiveRoot: string;
}): LiteratureDataMigrationReport {
  const absoluteReportPath = path.resolve(input.reportPath);
  const report = readReport(absoluteReportPath);
  const archiveRoot = path.resolve(input.archiveRoot);
  if (path.resolve(report.archiveRoot) !== archiveRoot) {
    throw new Error("Migration report archive root does not match the requested root");
  }
  if (report.mode !== "apply" || !["applying", "applied", "failed", "rolling-back", "rollback-failed"].includes(report.state)) {
    throw new Error("Literature migration report is not eligible for rollback");
  }
  report.state = "rolling-back";
  touch(report);
  writeJsonAtomically(absoluteReportPath, report);
  try {
    if (report.state !== "rolling-back") throw new Error("Invalid rollback state");
    for (const entry of report.entries) {
      if (entry.state === "rolled-back" || entry.state === "planned") continue;
      if (!entry.targetFingerprint) throw new Error("Literature migration entry has no target fingerprint");
      const target = reportTargetPath(entry, path.resolve(report.targetRoot));
      if (!exists(target)) {
        if (entry.state === "staged") continue;
        throw new Error(`Migrated literature entry is missing: ${entry.target}`);
      }
      if (!fingerprintsMatch(entry.targetFingerprint, targetFingerprint({ ...entry, targetPath: target }))) {
        throw new Error(`Refusing to roll back changed literature entry: ${entry.target}`);
      }
    }
    if (report.generatedIndexPath && exists(report.generatedIndexPath)
      && report.generatedIndexSha256 !== indexDigest(report.generatedIndexPath)) {
      throw new Error("Refusing to roll back a changed literature archive index");
    }
    if (exists(report.targetRoot)) fs.rmSync(report.targetRoot, { recursive: true, force: false });
    const stage = stagingPath(archiveRoot, report.runId);
    if (exists(stage)) fs.rmSync(stage, { recursive: true, force: true });
    for (const entry of report.entries) entry.state = "rolled-back";
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
