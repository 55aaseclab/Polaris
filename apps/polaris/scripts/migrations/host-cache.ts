import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REPORT_VERSION = 1;
const STAGING_DIRECTORY = ".polaris-host-cache-migrations";
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const HOST_CACHE_OCCUPANTS = [
  "literature-pdfs",
  "semantic-scholar",
  "topic-judgments",
  "arxiv-meta",
  "social-media",
] as const;

export type HostCacheOccupant = typeof HOST_CACHE_OCCUPANTS[number];

export type HostCacheMerge = "copy-new" | "already-present" | "source-missing";

export interface HostCachePlanEntry {
  occupant: HostCacheOccupant;
  sourcePath: string;
  targetPath: string;
  merge: HostCacheMerge;
  sourceFiles: number;
  sourceBytes: number;
}

export interface HostCacheMigrationPlan {
  formatVersion: number;
  sourceRoot: string;
  targetRoot: string;
  entries: HostCachePlanEntry[];
}

type ReportEntryState = "planned" | "applied" | "skipped" | "rolled-back";
type ReportState = "planned" | "applying" | "applied" | "failed" | "rolled-back";

export interface HostCacheReportEntry extends HostCachePlanEntry {
  state: ReportEntryState;
}

export interface HostCacheMigrationReport {
  formatVersion: number;
  mode: "dry-run" | "apply";
  state: ReportState;
  runId: string;
  createdAt: string;
  updatedAt: string;
  sourceRoot: string;
  targetRoot: string;
  entries: HostCacheReportEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function assertDirectory(value: string, label: string): void {
  const stat = fs.lstatSync(value);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
}

function assertNonRoot(value: string, label: string): string {
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new Error(`${label} must not be the filesystem root`);
  }
  return resolved;
}

function childPath(root: string, name: HostCacheOccupant): string {
  return path.join(path.resolve(root), name);
}

function treeStats(root: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
      continue;
    }
    if (stat.isFile()) {
      files += 1;
      bytes += stat.size;
    }
  }
  return { files, bytes };
}

function classify(sourcePath: string, targetPath: string): HostCacheMerge {
  if (!exists(sourcePath)) return "source-missing";
  if (exists(targetPath)) return "already-present";
  return "copy-new";
}

export function createHostCacheMigrationPlan(input: {
  sourceRoot: string;
  targetRoot: string;
}): HostCacheMigrationPlan {
  const sourceRoot = assertNonRoot(input.sourceRoot, "Host cache source root");
  const targetRoot = assertNonRoot(input.targetRoot, "Host cache target root");
  if (sourceRoot === targetRoot) {
    throw new Error("Host cache source and target must be different");
  }
  assertDirectory(sourceRoot, "Host cache source root");
  const entries: HostCachePlanEntry[] = HOST_CACHE_OCCUPANTS.map((occupant) => {
    const sourcePath = childPath(sourceRoot, occupant);
    const targetPath = childPath(targetRoot, occupant);
    const merge = classify(sourcePath, targetPath);
    const stats = merge === "source-missing" ? { files: 0, bytes: 0 } : treeStats(sourcePath);
    return {
      occupant,
      sourcePath,
      targetPath,
      merge,
      sourceFiles: stats.files,
      sourceBytes: stats.bytes,
    };
  });
  return {
    formatVersion: REPORT_VERSION,
    sourceRoot,
    targetRoot,
    entries,
  };
}

function writeJsonAtomically(filePath: string, value: unknown, rejectExisting = false): void {
  const absolute = path.resolve(filePath);
  if (rejectExisting && exists(absolute)) {
    throw new Error(`Migration report already exists: ${absolute}`);
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, absolute);
}

function createReport(
  plan: HostCacheMigrationPlan,
  mode: "dry-run" | "apply",
): HostCacheMigrationReport {
  const now = new Date().toISOString();
  return {
    formatVersion: REPORT_VERSION,
    mode,
    state: mode === "dry-run" ? "planned" : "applying",
    runId: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    sourceRoot: plan.sourceRoot,
    targetRoot: plan.targetRoot,
    entries: plan.entries.map((entry) => ({ ...entry, state: "planned" })),
  };
}

export function writeHostCacheDryRunReport(
  reportPath: string,
  plan: HostCacheMigrationPlan,
): HostCacheMigrationReport {
  const report = createReport(plan, "dry-run");
  writeJsonAtomically(reportPath, report, true);
  return report;
}

function stagingPath(targetRoot: string, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("Invalid host-cache migration run ID");
  return path.join(path.resolve(targetRoot), STAGING_DIRECTORY, runId);
}

function copyOccupant(sourcePath: string, targetPath: string): void {
  fs.cpSync(sourcePath, targetPath, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    preserveTimestamps: true,
  });
}

export function applyHostCacheMigration(input: {
  plan: HostCacheMigrationPlan;
  reportPath: string;
}): HostCacheMigrationReport {
  const { plan, reportPath } = input;
  const report = createReport(plan, "apply");
  const absoluteReportPath = path.resolve(reportPath);
  writeJsonAtomically(absoluteReportPath, report, true);
  const stageRoot = stagingPath(plan.targetRoot, report.runId);
  try {
    fs.mkdirSync(plan.targetRoot, { recursive: true, mode: 0o700 });
    assertDirectory(plan.targetRoot, "Host cache target root");
    fs.mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
    for (const [index, entry] of plan.entries.entries()) {
      const journal = report.entries[index]!;
      if (entry.merge === "source-missing" || entry.merge === "already-present") {
        journal.state = "skipped";
        continue;
      }
      const staged = path.join(stageRoot, entry.occupant);
      copyOccupant(entry.sourcePath, staged);
      fs.renameSync(staged, entry.targetPath);
      journal.state = "applied";
    }
    fs.rmSync(stageRoot, { recursive: true, force: true });
    report.state = "applied";
    report.updatedAt = new Date().toISOString();
    writeJsonAtomically(absoluteReportPath, report);
    return report;
  } catch (error) {
    if (exists(stageRoot)) fs.rmSync(stageRoot, { recursive: true, force: true });
    report.state = "failed";
    report.updatedAt = new Date().toISOString();
    writeJsonAtomically(absoluteReportPath, report);
    throw error;
  }
}

function readReport(reportPath: string): HostCacheMigrationReport {
  const parsed: unknown = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (!isRecord(parsed)
    || parsed.formatVersion !== REPORT_VERSION
    || !Array.isArray(parsed.entries)
    || typeof parsed.runId !== "string"
    || typeof parsed.targetRoot !== "string") {
    throw new Error("Invalid host-cache migration report");
  }
  return parsed as unknown as HostCacheMigrationReport;
}

export function verifyHostCacheMigration(input: {
  reportPath: string;
  targetRoot: string;
}): { reportPath: string; targetRoot: string; copied: number; skipped: number; valid: true } {
  const report = readReport(input.reportPath);
  if (path.resolve(report.targetRoot) !== path.resolve(input.targetRoot)) {
    throw new Error("Migration report target root does not match the requested root");
  }
  if (report.mode !== "apply" || report.state !== "applied") {
    throw new Error("Only an applied host-cache migration can be verified");
  }
  let copied = 0;
  let skipped = 0;
  for (const entry of report.entries) {
    if (entry.state === "skipped") {
      skipped += 1;
      continue;
    }
    if (entry.state !== "applied" || !exists(entry.targetPath)) {
      throw new Error(`Migrated host-cache occupant is missing: ${entry.occupant}`);
    }
    copied += 1;
  }
  return {
    reportPath: path.resolve(input.reportPath),
    targetRoot: path.resolve(input.targetRoot),
    copied,
    skipped,
    valid: true,
  };
}

export function rollbackHostCacheMigration(input: {
  reportPath: string;
  targetRoot: string;
}): HostCacheMigrationReport {
  const absoluteReportPath = path.resolve(input.reportPath);
  const report = readReport(absoluteReportPath);
  if (path.resolve(report.targetRoot) !== path.resolve(input.targetRoot)) {
    throw new Error("Migration report target root does not match the requested root");
  }
  if (report.mode !== "apply") {
    throw new Error("Host-cache dry-run reports are not eligible for rollback");
  }
  for (const entry of report.entries) {
    if (entry.state !== "applied") continue;
    if (exists(entry.targetPath)) {
      fs.rmSync(entry.targetPath, { recursive: true, force: false });
    }
    entry.state = "rolled-back";
  }
  report.state = "rolled-back";
  report.updatedAt = new Date().toISOString();
  writeJsonAtomically(absoluteReportPath, report);
  return report;
}
