import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { REPO_ROOT } from "@polaris/business-core";
import {
  resolveWorkspacePath,
  safeWorkspacePath,
  workspaceRelativePath as safeWorkspaceRelativePath,
  WORKSPACE_WORKFLOWS_FILE,
} from "@polaris/business-core/workspaces";
import {
  findRunningWorkflowStages,
  workflowRuntimeStageKey,
} from "@polaris/business-core/workflow-runtime-status";
import { compactWorkspaceDisplayValue } from "./workflow-display-value.js";
import { buildWorkflowInterpolationValues } from "./workflow-editable-interpolation.js";
import { flattenEditableFields } from "./workflow-editable-values.js";
import { readCachedFileResponse } from "./file-response-cache.js";

type ConfigRecord = Record<string, unknown>;
const WORKSPACE_WORKFLOWS_SCHEMA = "wanghai.workspace-workflows.v1";
const DEFAULT_FREE_DISCUSSION_TEMPLATE_ID = "free-discussion";
const LEGACY_FREE_DISCUSSION_WORKFLOW_ID = "free-discussion";
const DEFAULT_FREE_DISCUSSION_STAGE_ID = "discussion";

export type WorkspaceWorkflowAsset = {
  kind: "data" | "document" | "image" | "pdf";
  modified_at: string;
  name: string;
  path: string;
  size: number;
};

export type WorkspaceWorkflowStageFact = {
  label: string;
  value: string;
};

export type WorkspaceWorkflowEditableField = {
  path: string;
  value: string;
};

export type WorkspaceWorkflowStageStatus = {
  /** Primary artifact relative path, if present. */
  artifact: string | null;
  /** Compact fact rows for the UI (no marketing copy). */
  facts: WorkspaceWorkflowStageFact[];
  modified_at: string | null;
  /** Stage has its primary output on disk. */
  ready: boolean;
  size: number | null;
  /** Document status field when present (e.g. final). */
  status: string | null;
};

export type WorkspaceWorkflowStep = {
  args: string[];
  command: string;
  id: string;
  label: string;
  tool: string;
};

export type WorkspaceWorkflowStage = {
  depends_on_stage_ids: string[];
  editable_fields: WorkspaceWorkflowEditableField[];
  id: string;
  inputs: WorkspaceWorkflowAsset[];
  label: string;
  outputs: WorkspaceWorkflowAsset[];
  root_path: string;
  steps: WorkspaceWorkflowStep[];
  status: WorkspaceWorkflowStageStatus;
};

export type WorkspaceWorkflowRunSummary = {
  finished_at: string | null;
  path: string;
  started_at: string | null;
  status: string;
};

export type WorkspaceWorkflowPaseoCompanion = {
  agent_id: string;
};

export type WorkspaceWorkflow = {
  category: string;
  description: string;
  id: string;
  /** Latest run under workflows/<id>/runs, if any. */
  last_run: WorkspaceWorkflowRunSummary | null;
  files?: WorkspaceWorkflowAsset[];
  /** current | stale | incomplete | unknown */
  pipeline_status: "current" | "stale" | "incomplete" | "unknown";
  paseo: WorkspaceWorkflowPaseoCompanion | null;
  /** Absolute workflow directory used as the Paseo workspace. */
  paseo_workspace_path: string;
  stages: WorkspaceWorkflowStage[];
  status_generated_at: string | null;
  template_id: string | null;
  title: string;
};

type CreateWorkspaceWorkflowInstanceOptions = {
  workflowId?: string | null;
};

type ListWorkspaceWorkflowsOptions = {
  includeFiles?: boolean;
};

const STAGE_LABELS: Record<string, string> = {
  "data-collection": "数据采集",
  discussion: "自由讨论",
  "intelligence-analysis": "情报分析",
  "report-writing": "报告写作",
  outreach: "客户触达",
};

const KEY_ASSET_LIMIT = 12;
const MAX_JSON_BYTES = 40 * 1024 * 1024;
const MAX_PASEO_AGENT_ID_LENGTH = 240;
const INTERMEDIATE_ASSET_EXTENSIONS = new Set([
  ".aux",
  ".log",
  ".out",
]);

function isRecord(value: unknown): value is ConfigRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): ConfigRecord {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizedPaseoAgentId(value: unknown): string | null {
  const agentId = asString(value);
  if (!agentId || agentId.length > MAX_PASEO_AGENT_ID_LENGTH) return null;
  return agentId;
}

function paseoCompanion(value: unknown): WorkspaceWorkflowPaseoCompanion | null {
  const agentId = normalizedPaseoAgentId(asRecord(value).agent_id);
  return agentId ? { agent_id: agentId } : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function workflowStageDependsOn(value: unknown): string[] {
  return (asArray(asRecord(value).depends_on) ?? [])
    .map((entry) => asString(asRecord(entry).stage))
    .filter((stageId): stageId is string => Boolean(stageId));
}

function workflowStageSteps(value: unknown): WorkspaceWorkflowStep[] {
  return (asArray(asRecord(value).steps) ?? []).flatMap((entry) => {
    const step = asRecord(entry);
    const id = asString(step.id);
    const tool = asString(step.tool);
    const command = asString(step.command);
    if (!id || !tool || !command) {
      return [];
    }
    const args = (asArray(step.args) ?? []).map((argument) => String(argument));
    return [{
      id,
      tool,
      command,
      args,
      label: `${tool}.${command}`,
    }];
  });
}

function mergeRecords(base: ConfigRecord, overrides: ConfigRecord): ConfigRecord {
  const merged: ConfigRecord = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const original = merged[key];
    merged[key] = isRecord(original) && isRecord(value) ? mergeRecords(original, value) : value;
  }
  return merged;
}

function isWorkflowId(value: string) {
  return /^[a-z][a-z0-9-]{0,62}$/.test(value);
}

function ensureWorkflowLayout(rootDir: string, workflowId: string) {
  for (const name of ["case", "inputs", "outputs", "runs", "work"]) {
    fs.mkdirSync(path.join(rootDir, name), { recursive: true });
  }
  const readme = path.join(rootDir, "case", "README.md");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      `# ${workflowId}\n\nThis directory stores workflow state.\n`,
      "utf-8",
    );
  }
}

function freeDiscussionWorkflowId(workspace: string): string {
  const prefix = "discussion-";
  if (prefix.length + workspace.length <= 63) {
    return `${prefix}${workspace}`;
  }
  const hash = createHash("sha1").update(workspace).digest("hex").slice(0, 8);
  const keep = 63 - prefix.length - hash.length - 1;
  return `${prefix}${workspace.slice(0, keep)}-${hash}`;
}

function freeDiscussionWorkflowEntry(workspace: string): ConfigRecord {
  const workflowId = freeDiscussionWorkflowId(workspace);
  return {
    extends: DEFAULT_FREE_DISCUSSION_TEMPLATE_ID,
    description: "自由讨论工作流，只用于打开 Paseo 会话。",
    stages: {
      [DEFAULT_FREE_DISCUSSION_STAGE_ID]: {
        root_path: `workflows/${workflowId}/${DEFAULT_FREE_DISCUSSION_STAGE_ID}`,
      },
    },
    title: "自由讨论",
    workspace_id: workspace,
  };
}

function ensureDefaultWorkspaceWorkflowDocument(
  workspace: string,
  workspaceRoot: string,
  document: ConfigRecord,
): ConfigRecord {
  const workflowId = freeDiscussionWorkflowId(workspace);
  const workflowEntries = asRecord(document.workflows);
  const legacyEntry = asRecord(workflowEntries[LEGACY_FREE_DISCUSSION_WORKFLOW_ID]);
  let discussionEntry = asRecord(workflowEntries[workflowId]);
  let shouldWrite = false;
  if (!Object.keys(discussionEntry).length) {
    discussionEntry = Object.keys(legacyEntry).length
      ? structuredClone(legacyEntry) as ConfigRecord
      : freeDiscussionWorkflowEntry(workspace);
    shouldWrite = true;
  }
  const stages = asRecord(discussionEntry.stages);
  const discussionStage = asRecord(stages[DEFAULT_FREE_DISCUSSION_STAGE_ID]);
  const expectedRootPath = `workflows/${workflowId}/${DEFAULT_FREE_DISCUSSION_STAGE_ID}`;
  if (asString(discussionEntry.extends) !== DEFAULT_FREE_DISCUSSION_TEMPLATE_ID) {
    discussionEntry.extends = DEFAULT_FREE_DISCUSSION_TEMPLATE_ID;
    shouldWrite = true;
  }
  if (asString(discussionEntry.workspace_id) !== workspace) {
    discussionEntry.workspace_id = workspace;
    shouldWrite = true;
  }
  if (asString(discussionEntry.title) !== "自由讨论") {
    discussionEntry.title = "自由讨论";
    shouldWrite = true;
  }
  if (asString(discussionEntry.description) !== "自由讨论工作流，只用于打开 Paseo 会话。") {
    discussionEntry.description = "自由讨论工作流，只用于打开 Paseo 会话。";
    shouldWrite = true;
  }
  if (asString(discussionStage.root_path) !== expectedRootPath) {
    discussionStage.root_path = expectedRootPath;
    shouldWrite = true;
  }
  stages[DEFAULT_FREE_DISCUSSION_STAGE_ID] = discussionStage;
  discussionEntry.stages = stages;
  workflowEntries[workflowId] = discussionEntry;
  if (workflowId !== LEGACY_FREE_DISCUSSION_WORKFLOW_ID && LEGACY_FREE_DISCUSSION_WORKFLOW_ID in workflowEntries) {
    delete workflowEntries[LEGACY_FREE_DISCUSSION_WORKFLOW_ID];
    shouldWrite = true;
  }
  const legacyRoot = workflowWorkspacePath(workspaceRoot, LEGACY_FREE_DISCUSSION_WORKFLOW_ID);
  const workflowRoot = workflowWorkspacePath(workspaceRoot, workflowId);
  if (
    workflowId !== LEGACY_FREE_DISCUSSION_WORKFLOW_ID
    && fs.existsSync(legacyRoot)
    && !fs.existsSync(workflowRoot)
  ) {
    fs.renameSync(legacyRoot, workflowRoot);
  } else if (
    workflowId !== LEGACY_FREE_DISCUSSION_WORKFLOW_ID
    && fs.existsSync(legacyRoot)
    && fs.existsSync(workflowRoot)
  ) {
    fs.rmSync(legacyRoot, { recursive: true, force: true });
  }
  if (shouldWrite) {
    const next = {
      ...document,
      workflows: workflowEntries,
    };
    writeWorkspaceWorkflowDocument(workspaceRoot, next);
    ensureWorkflowLayout(
      workflowRoot,
      workflowId,
    );
    ensureWorkflowLayout(
      workflowWorkspacePath(workspaceRoot, workflowId, DEFAULT_FREE_DISCUSSION_STAGE_ID),
      workflowId,
    );
    return next;
  }
  ensureWorkflowLayout(
    workflowRoot,
    workflowId,
  );
  ensureWorkflowLayout(
    workflowWorkspacePath(workspaceRoot, workflowId, DEFAULT_FREE_DISCUSSION_STAGE_ID),
    workflowId,
  );
  return {
    ...document,
    workflows: workflowEntries,
  };
}

function defaultWorkflowInstanceId(workflows: ConfigRecord, templateId: string): string {
  const dateStamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const base = `${templateId}-${dateStamp}`;
  let candidate = base;
  let counter = 2;
  while (candidate in workflows) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function rootWorkflowConfigPath() {
  return path.join(REPO_ROOT, "workflows", "business", "templates.yaml");
}

function workspaceWorkflowConfigPath(workspaceRoot: string) {
  return path.join(workspaceRoot, WORKSPACE_WORKFLOWS_FILE);
}

function readRootWorkflowConfig(): ConfigRecord {
  const configPath = rootWorkflowConfigPath();
  if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
    throw new Error("未找到 Polaris business workflow 模板文件");
  }
  try {
    return asRecord(YAML.parse(fs.readFileSync(configPath, "utf-8")));
  } catch {
    throw new Error("无法读取 Polaris business workflow 模板文件");
  }
}

function readWorkspaceWorkflowDocument(workspace: string, workspaceRoot: string): ConfigRecord {
  const configPath = workspaceWorkflowConfigPath(workspaceRoot);
  if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
    return ensureDefaultWorkspaceWorkflowDocument(workspace, workspaceRoot, {
      schema_version: WORKSPACE_WORKFLOWS_SCHEMA,
      workspace_id: workspace,
      workflows: {},
    });
  }

  let config: ConfigRecord;
  try {
    config = asRecord(YAML.parse(fs.readFileSync(configPath, "utf-8")));
  } catch {
    throw new Error(`无法读取 ${WORKSPACE_WORKFLOWS_FILE}`);
  }

  const schemaVersion = asString(config.schema_version);
  if (schemaVersion !== WORKSPACE_WORKFLOWS_SCHEMA) {
    throw new Error(`${WORKSPACE_WORKFLOWS_FILE} 必须使用 ${WORKSPACE_WORKFLOWS_SCHEMA}`);
  }
  const workspaceId = asString(config.workspace_id);
  if (workspaceId !== workspace) {
    throw new Error(`${WORKSPACE_WORKFLOWS_FILE}.workspace_id 必须匹配当前 workspace`);
  }
  return ensureDefaultWorkspaceWorkflowDocument(workspace, workspaceRoot, {
    ...config,
    workflows: asRecord(config.workflows),
  });
}

function writeWorkspaceWorkflowDocument(workspaceRoot: string, document: ConfigRecord) {
  fs.writeFileSync(workspaceWorkflowConfigPath(workspaceRoot), YAML.stringify(document), "utf-8");
}

function literatureReviewWorkflowEntry(workspace: string, workflowId: string): ConfigRecord {
  return {
    description: `Literature review instance ${workflowId}.`,
    extends: "literature-review",
    title: workflowId,
    workspace_id: workspace,
    stages: {
      "data-collection": {
        collection_id: workflowId,
        root_path: `workflows/${workflowId}/data-collection`,
      },
      "intelligence-analysis": {
        analysis_id: `${workflowId}-analysis`,
        root_path: `workflows/${workflowId}/intelligence-analysis`,
      },
      "report-writing": {
        report_id: workflowId,
        root_path: `workflows/${workflowId}/report-writing`,
      },
    },
  };
}

function normalizedRootPath(value: unknown): string | null {
  const rootPath = asString(value);
  if (!rootPath) return null;
  const normalized = rootPath
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    return null;
  }
  return normalized;
}

function assetKind(filePath: string): WorkspaceWorkflowAsset["kind"] {
  const extension = path.extname(filePath).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"].includes(extension)) return "image";
  if (extension === ".pdf") return "pdf";
  if ([".json", ".csv", ".xlsx", ".xls"].includes(extension)) return "data";
  return "document";
}

function isKeyAssetFile(filePath: string) {
  const name = path.basename(filePath);
  return !name.includes(".bak-") && !INTERMEDIATE_ASSET_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function workspaceRelativePath(workspaceRoot: string, filePath: string) {
  return safeWorkspaceRelativePath(workspaceRoot, filePath);
}

function assetSummary(workspaceRoot: string, filePath: string): WorkspaceWorkflowAsset {
  const stat = fs.statSync(filePath);
  return {
    kind: assetKind(filePath),
    modified_at: stat.mtime.toISOString(),
    name: path.basename(filePath),
    path: workspaceRelativePath(workspaceRoot, filePath),
    size: stat.size,
  };
}

function workflowWorkspacePath(
  workspaceRoot: string,
  workflowId: string,
  ...segments: string[]
): string {
  if (!isWorkflowId(workflowId)) {
    throw new Error(`workflow id is invalid: ${workflowId}`);
  }
  return workspaceDescendantPath(workspaceRoot, path.join("workflows", workflowId, ...segments));
}

function stageWorkspacePath(
  workspaceRoot: string,
  stageRoot: string,
  ...segments: string[]
): string {
  const normalized = normalizedRootPath(stageRoot);
  if (!normalized) {
    throw new Error(`stage path resolves outside workspace: ${stageRoot}`);
  }
  return workspaceDescendantPath(workspaceRoot, path.posix.join(normalized, ...segments));
}

function workspaceDescendantPath(workspaceRoot: string, relativePath: string): string {
  if (fs.existsSync(workspaceRoot)) {
    return safeWorkspacePath(workspaceRoot, relativePath);
  }
  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(root, relativePath);
  if (candidate === root || candidate.startsWith(`${root}${path.sep}`)) {
    return candidate;
  }
  throw new Error(`workspace path resolves outside workspace: ${relativePath}`);
}

function listFiles(rootDir: string, workspaceRoot: string, limit = KEY_ASSET_LIMIT): WorkspaceWorkflowAsset[] {
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) return [];
  const files: WorkspaceWorkflowAsset[] = [];
  const stack = [rootDir];
  while (stack.length > 0 && files.length < limit) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(filePath);
      else if (entry.isFile() && isKeyAssetFile(filePath)) files.push(assetSummary(workspaceRoot, filePath));
      if (files.length >= limit) break;
    }
  }
  return files;
}

function listAllFiles(rootDir: string, workspaceRoot: string): WorkspaceWorkflowAsset[] {
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) return [];
  const files: WorkspaceWorkflowAsset[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
      } else if (entry.isFile()) {
        files.push(assetSummary(workspaceRoot, filePath));
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function workflowFiles(workspaceRoot: string, workflowId: string): WorkspaceWorkflowAsset[] {
  return listAllFiles(workflowWorkspacePath(workspaceRoot, workflowId), workspaceRoot);
}

/**
 * Build the cheap source snapshot used to decide whether a workflow result is
 * still valid. Directory entries are included so new or removed assets also
 * invalidate the cached result.
 */
function workflowSourcePaths(workspaceRoot: string, workflowId: string): string[] {
  const rootDir = workflowWorkspacePath(workspaceRoot, workflowId);
  const paths = [rootDir];
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) return paths;

  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        paths.push(filePath);
        stack.push(filePath);
      } else if (entry.isFile()) {
        paths.push(filePath);
      }
    }
  }

  return paths.sort();
}

function stageAssets(workspaceRoot: string, stageId: string, stageRoot: string) {
  const inputs = listFiles(stageWorkspacePath(workspaceRoot, stageRoot, "inputs"), workspaceRoot);
  const outputs = listFiles(stageWorkspacePath(workspaceRoot, stageRoot, "outputs"), workspaceRoot);
  if (stageId === "report-writing") {
    const draftPath = stageWorkspacePath(workspaceRoot, stageRoot, "work", "draft.json");
    if (fs.existsSync(draftPath) && fs.statSync(draftPath).isFile()) {
      outputs.push(assetSummary(workspaceRoot, draftPath));
    }
  }

  return {
    inputs,
    outputs: outputs
      .sort((left, right) => left.path.localeCompare(right.path))
      .slice(0, KEY_ASSET_LIMIT),
  };
}

function emptyStageStatus(): WorkspaceWorkflowStageStatus {
  return {
    artifact: null,
    facts: [],
    modified_at: null,
    ready: false,
    size: null,
    status: null,
  };
}

function readJsonFile(filePath: string): ConfigRecord | null {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    const size = fs.statSync(filePath).size;
    if (size > MAX_JSON_BYTES) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function fileMeta(workspaceRoot: string, filePath: string): {
  artifact: string;
  modified_at: string;
  size: number;
} | null {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    const stat = fs.statSync(filePath);
    return {
      artifact: workspaceRelativePath(workspaceRoot, filePath),
      modified_at: stat.mtime.toISOString(),
      size: stat.size,
    };
  } catch {
    return null;
  }
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function pdfPageCount(filePath: string): number | null {
  try {
    const output = execFileSync("pdfinfo", [filePath], {
      encoding: "utf-8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    const match = output.match(/^Pages:\s+(\d+)\s*$/m);
    if (!match) return null;
    const pages = Number(match[1]);
    return Number.isFinite(pages) ? pages : null;
  } catch {
    return null;
  }
}

function dataCollectionStatus(
  workspaceRoot: string,
  stageRoot: string,
): WorkspaceWorkflowStageStatus {
  const outputPath = stageWorkspacePath(workspaceRoot, stageRoot, "outputs", "output.json");
  const meta = fileMeta(workspaceRoot, outputPath);
  if (!meta) {
    return {
      ...emptyStageStatus(),
      facts: [{ label: "产物", value: "无 output.json" }],
      status: "missing",
    };
  }

  const document = readJsonFile(outputPath);
  const status = asString(document?.status);
  const records = asArray(document?.records);
  const rejected = asArray(document?.rejected_records);
  const facts: WorkspaceWorkflowStageFact[] = [];
  if (records) facts.push({ label: "记录", value: String(records.length) });
  if (rejected) facts.push({ label: "拒绝", value: String(rejected.length) });
  if (asString(document?.collection_id)) {
    facts.push({ label: "collection_id", value: asString(document?.collection_id)! });
  }
  facts.push({ label: "产物", value: `${path.basename(meta.artifact)} · ${formatBytes(meta.size)}` });

  return {
    artifact: meta.artifact,
    facts,
    modified_at: meta.modified_at,
    ready: true,
    size: meta.size,
    status,
  };
}

function intelligenceAnalysisStatus(
  workspaceRoot: string,
  stageRoot: string,
): WorkspaceWorkflowStageStatus {
  const outputPath = stageWorkspacePath(workspaceRoot, stageRoot, "outputs", "output.json");
  const inputPath = stageWorkspacePath(workspaceRoot, stageRoot, "inputs", "input.json");
  const meta = fileMeta(workspaceRoot, outputPath);
  if (!meta) {
    return {
      ...emptyStageStatus(),
      facts: [{ label: "产物", value: "无 output.json" }],
      status: "missing",
    };
  }

  const document = readJsonFile(outputPath);
  const input = readJsonFile(inputPath);
  const status = asString(document?.status);
  const judgments = asArray(document?.judgments);
  const unresolved = asArray(document?.unresolved);
  const review = asRecord(document?.review);
  const reviewSummary = asRecord(review.summary);
  const searchScope = asRecord(document?.search_scope);
  const model = asString(input?.model) ?? asString(document?.model);
  const effort = asString(input?.model_reasoning_effort) ?? asString(document?.model_reasoning_effort);
  const facts: WorkspaceWorkflowStageFact[] = [];

  if (judgments) facts.push({ label: "判断", value: String(judgments.length) });
  if (unresolved) facts.push({ label: "未决", value: String(unresolved.length) });
  if (asNumber(searchScope.record_count) !== null) {
    facts.push({ label: "语料记录", value: String(asNumber(searchScope.record_count)) });
  }
  if (asString(review.status) || asString(review.approval_mode)) {
    const approved = asNumber(reviewSummary.approved);
    const total = asNumber(reviewSummary.review_total);
    const mode = asString(review.approval_mode) ?? asString(review.status) ?? "—";
    const detail = approved !== null && total !== null ? `${mode} · ${approved}/${total}` : mode;
    facts.push({ label: "审核", value: detail });
  }
  if (model) {
    facts.push({ label: "模型", value: effort ? `${model} / ${effort}` : model });
  }
  if (asString(document?.literature_method)) {
    facts.push({ label: "方法", value: asString(document?.literature_method)! });
  }
  facts.push({ label: "产物", value: `${path.basename(meta.artifact)} · ${formatBytes(meta.size)}` });

  return {
    artifact: meta.artifact,
    facts,
    modified_at: meta.modified_at,
    ready: true,
    size: meta.size,
    status,
  };
}

/** Same pattern as tools/report-writing/runner.py INLINE_CLAIM_CITE_RE. */
const INLINE_CLAIM_CITE_RE = /\[@([A-Za-z0-9_.:\-]+(?:\s*;\s*[A-Za-z0-9_.:\-]+)*)\]/g;

/** Bulk citation dump threshold: markers packing this many ids are not real prose coverage. */
const BULK_CITE_THRESHOLD = 10;

function collectSectionClaimIds(section: unknown, ids: Set<string>) {
  if (!isRecord(section)) return;
  for (const claimId of asArray(section.claim_ids) ?? []) {
    if (typeof claimId === "string" && claimId.trim()) ids.add(claimId.trim());
  }
  for (const child of asArray(section.subsections) ?? []) {
    collectSectionClaimIds(child, ids);
  }
}

function collectDraftProse(draft: ConfigRecord): string {
  const chunks: string[] = [];
  for (const section of asArray(draft.sections) ?? []) {
    if (!isRecord(section)) continue;
    for (const paragraph of asArray(section.paragraphs) ?? []) {
      if (typeof paragraph === "string") chunks.push(paragraph);
    }
    for (const subsection of asArray(section.subsections) ?? []) {
      if (!isRecord(subsection)) continue;
      for (const paragraph of asArray(subsection.paragraphs) ?? []) {
        if (typeof paragraph === "string") chunks.push(paragraph);
      }
    }
  }
  return chunks.join("\n");
}

type DraftClaimCoverage = {
  /** claim_ids listed on section arrays */
  arrayCount: number;
  /** unique ids inside [@…] markers */
  inlineCount: number;
  /** array ∩ inline — runner "covered" definition */
  markedCount: number;
  /** in array but missing from prose markers */
  arrayOnlyCount: number;
  /** citation marker clusters */
  clusterCount: number;
  /** clusters with a single claim id */
  soloClusters: number;
  /** clusters with >= BULK_CITE_THRESHOLD ids */
  bulkClusters: number;
  /** mean ids per cluster */
  meanClusterSize: number;
  /** unique ids that only appear inside bulk clusters */
  bulkOnlyCount: number;
};

function analyzeDraftClaimCoverage(draft: ConfigRecord | null): DraftClaimCoverage | null {
  if (!draft) return null;

  const arrayIds = new Set<string>();
  for (const section of asArray(draft.sections) ?? []) {
    collectSectionClaimIds(section, arrayIds);
  }

  const prose = collectDraftProse(draft);
  const inlineIds = new Set<string>();
  const bulkIds = new Set<string>();
  const smallIds = new Set<string>();
  let clusterCount = 0;
  let soloClusters = 0;
  let bulkClusters = 0;
  let totalClusterIds = 0;

  for (const match of prose.matchAll(INLINE_CLAIM_CITE_RE)) {
    const ids = match[1]
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean);
    if (ids.length === 0) continue;
    clusterCount += 1;
    totalClusterIds += ids.length;
    if (ids.length === 1) soloClusters += 1;
    if (ids.length >= BULK_CITE_THRESHOLD) {
      bulkClusters += 1;
      for (const id of ids) bulkIds.add(id);
    }
    if (ids.length <= 3) {
      for (const id of ids) smallIds.add(id);
    }
    for (const id of ids) inlineIds.add(id);
  }

  let markedCount = 0;
  let arrayOnlyCount = 0;
  for (const id of arrayIds) {
    if (inlineIds.has(id)) markedCount += 1;
    else arrayOnlyCount += 1;
  }

  let bulkOnlyCount = 0;
  for (const id of bulkIds) {
    if (!smallIds.has(id)) bulkOnlyCount += 1;
  }

  return {
    arrayCount: arrayIds.size,
    inlineCount: inlineIds.size,
    markedCount,
    arrayOnlyCount,
    clusterCount,
    soloClusters,
    bulkClusters,
    meanClusterSize: clusterCount > 0 ? totalClusterIds / clusterCount : 0,
    bulkOnlyCount,
  };
}

/**
 * Honest claim-coverage facts.
 *
 * Runner provenance may say unused_claims_remaining=[] when every claim id
 * appears somewhere in [@a;b;c;…] dumps. That is mechanical marker coverage,
 * not substantive prose coverage. Surface both.
 */
function claimCoverageFacts(
  draft: ConfigRecord | null,
  provenance: ConfigRecord,
): WorkspaceWorkflowStageFact[] {
  const facts: WorkspaceWorkflowStageFact[] = [];
  const analysis = analyzeDraftClaimCoverage(draft);
  const rounds = asNumber(provenance.coverage_fill_rounds);
  const unused = asArray(provenance.unused_claims_remaining);
  const provenanceMissing = unused?.length ?? null;

  if (!analysis && rounds === null && provenanceMissing === null) return facts;

  const bulkDominated = Boolean(
    analysis
    && analysis.clusterCount > 0
    && (
      analysis.bulkOnlyCount >= Math.max(10, Math.floor(analysis.markedCount * 0.5))
      || analysis.meanClusterSize >= BULK_CITE_THRESHOLD
    ),
  );

  if (analysis) {
    if (analysis.arrayOnlyCount > 0) {
      facts.push({
        label: "claim 覆盖",
        value: `标记 ${analysis.markedCount}/${analysis.arrayCount} · 数组未进正文 ${analysis.arrayOnlyCount}`,
      });
    } else if (bulkDominated) {
      // Mechanical full mark, but mostly bulk dumps — do not call this 全覆盖.
      facts.push({
        label: "claim 覆盖",
        value: `机械标记 ${analysis.markedCount}/${analysis.arrayCount} · 实质未覆盖（批量堆砌）`,
      });
    } else if (analysis.arrayCount > 0 && analysis.markedCount === analysis.arrayCount) {
      facts.push({
        label: "claim 覆盖",
        value: `${analysis.markedCount}/${analysis.arrayCount} 已写入正文`,
      });
    } else if (analysis.arrayCount > 0) {
      facts.push({
        label: "claim 覆盖",
        value: `标记 ${analysis.markedCount}/${analysis.arrayCount}`,
      });
    }
  } else if (provenanceMissing !== null) {
    facts.push({
      label: "claim 覆盖",
      value: provenanceMissing === 0
        ? "provenance 称无缺口（未校验正文）"
        : `provenance 仍缺 ${provenanceMissing}`,
    });
  }

  if (analysis && analysis.clusterCount > 0) {
    const mean = analysis.meanClusterSize >= 10
      ? analysis.meanClusterSize.toFixed(0)
      : analysis.meanClusterSize.toFixed(1);
    facts.push({
      label: "引用形态",
      value: `${analysis.clusterCount} 簇 · 单引 ${analysis.soloClusters} · 批量(≥${BULK_CITE_THRESHOLD}) ${analysis.bulkClusters} · 均值 ${mean}/簇`,
    });
  }

  if (provenanceMissing !== null && provenanceMissing > 0) {
    facts.push({ label: "runner 缺口", value: String(provenanceMissing) });
  }

  const pipeline = asString(provenance.pipeline);
  if (pipeline) {
    facts.push({ label: "写作 pipeline", value: pipeline });
  }

  if (rounds !== null) {
    facts.push({
      label: "补全轮次",
      value: rounds === 0
        ? pipeline === "compress-outline-expand"
          ? "0（分节 expand，无整稿 fill）"
          : "0（未跑 coverage fill）"
        : String(rounds),
    });
  }

  return facts;
}

function reportWritingStatus(
  workspaceRoot: string,
  stageRoot: string,
): WorkspaceWorkflowStageStatus {
  const pdfPath = stageWorkspacePath(workspaceRoot, stageRoot, "outputs", "report.pdf");
  const draftPath = stageWorkspacePath(workspaceRoot, stageRoot, "work", "draft.json");
  const meta = fileMeta(workspaceRoot, pdfPath);
  const draft = readJsonFile(draftPath);
  const provenance = asRecord(draft?.provenance);
  const facts: WorkspaceWorkflowStageFact[] = [];

  if (!meta) {
    if (draft) {
      const title = asString(draft.title);
      if (title) facts.push({ label: "草稿标题", value: title });
      facts.push(...claimCoverageFacts(draft, provenance));
      facts.push({ label: "产物", value: "有 draft.json，无 report.pdf" });
      return {
        artifact: workspaceRelativePath(workspaceRoot, draftPath),
        facts,
        modified_at: fileMeta(workspaceRoot, draftPath)?.modified_at ?? null,
        ready: false,
        size: fileMeta(workspaceRoot, draftPath)?.size ?? null,
        status: "draft",
      };
    }
    return {
      ...emptyStageStatus(),
      facts: [{ label: "产物", value: "无 report.pdf" }],
      status: "missing",
    };
  }

  const title = asString(draft?.title);
  if (title) facts.push({ label: "标题", value: title });
  const pages = pdfPageCount(pdfPath);
  if (pages !== null) facts.push({ label: "页数", value: String(pages) });
  const model = asString(provenance.model);
  const effort = asString(provenance.model_reasoning_effort);
  if (model) facts.push({ label: "模型", value: effort ? `${model} / ${effort}` : model });
  facts.push(...claimCoverageFacts(draft, provenance));
  facts.push({ label: "产物", value: `report.pdf · ${formatBytes(meta.size)}` });

  return {
    artifact: meta.artifact,
    facts,
    modified_at: meta.modified_at,
    ready: true,
    size: meta.size,
    status: "ready",
  };
}

function genericOutputStatus(
  workspaceRoot: string,
  stageRoot: string,
): WorkspaceWorkflowStageStatus {
  const outputPath = stageWorkspacePath(workspaceRoot, stageRoot, "outputs", "output.json");
  const meta = fileMeta(workspaceRoot, outputPath);
  if (!meta) {
    return {
      ...emptyStageStatus(),
      facts: [{ label: "产物", value: "无 output.json" }],
      status: "missing",
    };
  }

  const document = readJsonFile(outputPath);
  const facts: WorkspaceWorkflowStageFact[] = [];
  const recordCount = asArray(document?.records)?.length;
  if (recordCount !== undefined) facts.push({ label: "记录", value: String(recordCount) });
  const outreachId = asString(document?.outreach_id);
  if (outreachId) facts.push({ label: "outreach_id", value: outreachId });
  facts.push({ label: "产物", value: `${path.basename(meta.artifact)} · ${formatBytes(meta.size)}` });
  return {
    artifact: meta.artifact,
    facts,
    modified_at: meta.modified_at,
    ready: true,
    size: meta.size,
    status: asString(document?.status) ?? "ready",
  };
}

function stageStatus(
  workspaceRoot: string,
  stageId: string,
  stageRoot: string,
): WorkspaceWorkflowStageStatus {
  if (stageId === "data-collection") return dataCollectionStatus(workspaceRoot, stageRoot);
  if (stageId === "intelligence-analysis") return intelligenceAnalysisStatus(workspaceRoot, stageRoot);
  if (stageId === "report-writing") return reportWritingStatus(workspaceRoot, stageRoot);
  return genericOutputStatus(workspaceRoot, stageRoot);
}

function workflowStages(
  workflowId: string,
  category: string,
  value: unknown,
  workspace: string,
  workspaceRoot: string,
): WorkspaceWorkflowStage[] {
  const mergedStages = asRecord(value);
  const interpolationValues = buildWorkflowInterpolationValues({
    category,
    stages: mergedStages,
    workflowId,
    workspaceId: workspace,
    workspaceRoot,
  });
  return Object.entries(mergedStages).flatMap(([id, stage]) => {
    const rootPath = normalizedRootPath(asRecord(stage).root_path);
    if (!rootPath) return [];
    const editableFields = flattenEditableFields(stage, "", interpolationValues).map((field) => ({
      ...field,
      value: compactWorkspaceDisplayValue(field.value, workspaceRoot),
    }));
    return [{
      depends_on_stage_ids: workflowStageDependsOn(stage),
      editable_fields: editableFields,
      id,
      label: STAGE_LABELS[id] ?? id,
      root_path: rootPath,
      steps: workflowStageSteps(stage),
      status: stageStatus(workspaceRoot, id, rootPath),
      ...stageAssets(workspaceRoot, id, rootPath),
    }];
  });
}

function readPipelineStatus(
  workspaceRoot: string,
  workflowId: string,
  stages: WorkspaceWorkflowStage[],
): { pipeline_status: WorkspaceWorkflow["pipeline_status"]; status_generated_at: string | null } {
  const statusPath = workflowWorkspacePath(workspaceRoot, workflowId, "outputs", "status.json");
  const document = readJsonFile(statusPath);
  if (document) {
    const status = asString(document.status);
    if (status === "current" || status === "stale") {
      return {
        pipeline_status: status,
        status_generated_at: asString(document.generated_at),
      };
    }
  }

  const readyCount = stages.filter((stage) => stage.status.ready).length;
  if (readyCount === 0) return { pipeline_status: "incomplete", status_generated_at: null };
  if (readyCount < stages.length) return { pipeline_status: "incomplete", status_generated_at: null };
  return { pipeline_status: "unknown", status_generated_at: null };
}

function latestRunSummary(
  workspaceRoot: string,
  workflowId: string,
): WorkspaceWorkflowRunSummary | null {
  const runsDir = workflowWorkspacePath(workspaceRoot, workflowId, "runs");
  if (!fs.existsSync(runsDir) || !fs.statSync(runsDir).isDirectory()) return null;

  const runDirs = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (runDirs.length === 0) return null;

  const latestName = runDirs[runDirs.length - 1]!;
  const runPath = workflowWorkspacePath(workspaceRoot, workflowId, "runs", latestName, "run.json");
  const relative = workspaceRelativePath(
    workspaceRoot,
    workflowWorkspacePath(workspaceRoot, workflowId, "runs", latestName),
  );
  const document = readJsonFile(runPath);
  if (!document) {
    return {
      finished_at: null,
      path: relative,
      started_at: null,
      status: "unknown",
    };
  }
  return {
    finished_at: asString(document.finished_at),
    path: relative,
    started_at: asString(document.started_at),
    status: asString(document.status) ?? "unknown",
  };
}

export function mergeWorkflowWithRuntimeStatus(
  workflow: WorkspaceWorkflow,
  workspaceRoot: string,
  runningStageKeys: ReadonlySet<string>,
  generatedAt: string | null,
): WorkspaceWorkflow {
  const mergedStages = workflow.stages.map((stage) => {
    if (!runningStageKeys.has(workflowRuntimeStageKey(workflow.id, stage.id))) return stage;
    return {
      ...stage,
      status: {
        ...stage.status,
        status: "running",
      },
    };
  });

  const hasRunningStage = workflow.stages.some((stage) => (
    runningStageKeys.has(workflowRuntimeStageKey(workflow.id, stage.id))
  ));
  const lastRun = hasRunningStage
    ? {
      finished_at: null,
      path: workflow.last_run?.path ?? workspaceRelativePath(
        workspaceRoot,
        workflowWorkspacePath(workspaceRoot, workflow.id, "runs"),
      ),
      started_at: workflow.last_run?.started_at ?? null,
      status: "running",
    }
    : workflow.last_run;

  return {
    ...workflow,
    last_run: lastRun,
    stages: mergedStages,
    status_generated_at: generatedAt ?? workflow.status_generated_at,
  };
}

function runtimeWorkflowStatus(
  workflows: WorkspaceWorkflow[],
  workspaceRoot: string,
): { generatedAt: string | null; runningStageKeys: Set<string> } {
  if (workflows.length === 0) {
    return { generatedAt: null, runningStageKeys: new Set() };
  }
  const runningByStage = findRunningWorkflowStages(
    workflows.flatMap((workflow) => workflow.stages.map((stage) => ({
      key: workflowRuntimeStageKey(workflow.id, stage.id),
      rootPath: stageWorkspacePath(workspaceRoot, stage.root_path),
      stageId: stage.id,
      workflowId: workflow.id,
    }))),
  );
  return {
    generatedAt: new Date().toISOString(),
    runningStageKeys: new Set(runningByStage.keys()),
  };
}

function cachedWorkspaceWorkflow(
  rootConfig: ConfigRecord,
  workspace: string,
  workspaceRoot: string,
  workflowId: string,
  value: unknown,
  options: ListWorkspaceWorkflowsOptions = {},
): WorkspaceWorkflow | null {
  const includeFiles = options.includeFiles ?? true;
  const templates = asRecord(rootConfig["workflow-templates"]);
  const workflowConfigPath = workspaceWorkflowConfigPath(workspaceRoot);
  const sourcePaths = [
    rootWorkflowConfigPath(),
    workflowConfigPath,
    ...workflowSourcePaths(workspaceRoot, workflowId),
  ];

  return readCachedFileResponse(
    `workspace-workflow:${workspaceRoot}:${workspace}:${workflowId}:${includeFiles ? "full" : "summary"}`,
    sourcePaths,
    () => {
      const workflow = asRecord(value);
      if (asString(workflow.workspace_id) !== workspace) return null;

      const templateId = asString(workflow.extends);
      const template = templateId ? asRecord(templates[templateId]) : {};
      const merged = mergeRecords(template, workflow);
      const stages = workflowStages(
        workflowId,
        asString(merged.category) ?? "",
        merged.stages,
        workspace,
        workspaceRoot,
      );
      const pipeline = readPipelineStatus(workspaceRoot, workflowId, stages);

      return {
        category: asString(merged.category) ?? "",
        description: asString(merged.description) ?? "",
        id: workflowId,
        last_run: latestRunSummary(workspaceRoot, workflowId),
        ...(includeFiles ? { files: workflowFiles(workspaceRoot, workflowId) } : {}),
        pipeline_status: pipeline.pipeline_status,
        paseo: paseoCompanion(workflow.paseo),
        paseo_workspace_path: workflowWorkspacePath(workspaceRoot, workflowId),
        stages,
        status_generated_at: pipeline.status_generated_at,
        template_id: templateId,
        title: asString(merged.title) ?? asString(merged.name) ?? workflowId,
      } satisfies WorkspaceWorkflow;
    },
  );
}

export function createWorkspaceWorkflowInstance(
  workspace: string,
  workspaceRoot: string,
  templateId: string,
  options: CreateWorkspaceWorkflowInstanceOptions = {},
): WorkspaceWorkflow {
  if (templateId !== "literature-review") {
    throw new Error(`暂不支持模板实例化：${templateId}`);
  }

  const rootConfig = readRootWorkflowConfig();
  const templates = asRecord(rootConfig["workflow-templates"]);
  if (!(templateId in templates)) {
    throw new Error(`未找到 workflow template: ${templateId}`);
  }

  const workspaceDocument = readWorkspaceWorkflowDocument(workspace, workspaceRoot);
  const workflowEntries = asRecord(workspaceDocument.workflows);
  const requestedId = options.workflowId?.trim() || defaultWorkflowInstanceId(workflowEntries, templateId);
  if (!isWorkflowId(requestedId)) {
    throw new Error("workflow id 必须匹配 ^[a-z][a-z0-9-]{0,62}$");
  }
  if (requestedId in workflowEntries) {
    throw new Error(`workflow 已存在：${requestedId}`);
  }

  workflowEntries[requestedId] = literatureReviewWorkflowEntry(workspace, requestedId);
  writeWorkspaceWorkflowDocument(workspaceRoot, {
    ...workspaceDocument,
    workflows: workflowEntries,
  });

  ensureWorkflowLayout(workflowWorkspacePath(workspaceRoot, requestedId), requestedId);
  ensureWorkflowLayout(workflowWorkspacePath(workspaceRoot, requestedId, "data-collection"), requestedId);
  ensureWorkflowLayout(workflowWorkspacePath(workspaceRoot, requestedId, "intelligence-analysis"), requestedId);
  ensureWorkflowLayout(workflowWorkspacePath(workspaceRoot, requestedId, "report-writing"), requestedId);

  const created = listWorkspaceWorkflows(workspace, workspaceRoot).find((workflow) => workflow.id === requestedId);
  if (!created) {
    throw new Error(`创建后未找到 workflow：${requestedId}`);
  }
  return created;
}

export function deleteWorkspaceWorkflowInstance(
  workspace: string,
  workspaceRoot: string,
  workflowId: string,
): {
  config_path: string;
  path: string;
  status: "deleted";
  workflow_id: string;
  workspace_id: string;
} {
  if (!isWorkflowId(workflowId)) {
    throw new Error("workflow id 必须匹配 ^[a-z][a-z0-9-]{0,62}$");
  }

  const workspaceDocument = readWorkspaceWorkflowDocument(workspace, workspaceRoot);
  const workflowEntries = asRecord(workspaceDocument.workflows);
  const workflow = asRecord(workflowEntries[workflowId]);
  if (!Object.keys(workflow).length) {
    throw new Error(`未找到 workflow：${workflowId}`);
  }
  if (asString(workflow.workspace_id) !== workspace) {
    throw new Error(`workflow 不属于当前 workspace：${workflowId}`);
  }

  delete workflowEntries[workflowId];
  writeWorkspaceWorkflowDocument(workspaceRoot, {
    ...workspaceDocument,
    workflows: workflowEntries,
  });

  const workflowRoot = workflowWorkspacePath(workspaceRoot, workflowId);
  fs.rmSync(workflowRoot, { recursive: true, force: true });
  return {
    config_path: WORKSPACE_WORKFLOWS_FILE,
    path: workspaceRelativePath(workspaceRoot, workflowRoot),
    status: "deleted",
    workflow_id: workflowId,
    workspace_id: workspace,
  };
}

export function updateWorkspaceWorkflowPaseoAgent(
  workspace: string,
  workspaceRoot: string,
  workflowId: string,
  agentId: string,
): WorkspaceWorkflow {
  if (!isWorkflowId(workflowId)) {
    throw new Error("workflow id 必须匹配 ^[a-z][a-z0-9-]{0,62}$");
  }
  const normalizedAgentId = normalizedPaseoAgentId(agentId);
  if (!normalizedAgentId) {
    throw new Error("agent_id 不能为空且长度不能超过 240 个字符");
  }

  const workspaceDocument = readWorkspaceWorkflowDocument(workspace, workspaceRoot);
  const workflowEntries = asRecord(workspaceDocument.workflows);
  const workflow = asRecord(workflowEntries[workflowId]);
  if (!Object.keys(workflow).length) {
    throw new Error(`未找到 workflow：${workflowId}`);
  }
  if (asString(workflow.workspace_id) !== workspace) {
    throw new Error(`workflow 不属于当前 workspace：${workflowId}`);
  }

  workflowEntries[workflowId] = {
    ...workflow,
    paseo: {
      ...asRecord(workflow.paseo),
      agent_id: normalizedAgentId,
    },
  };
  writeWorkspaceWorkflowDocument(workspaceRoot, {
    ...workspaceDocument,
    workflows: workflowEntries,
  });

  const updated = listWorkspaceWorkflows(workspace, workspaceRoot)
    .find((workflowItem) => workflowItem.id === workflowId);
  if (!updated) {
    throw new Error(`保存后未找到 workflow：${workflowId}`);
  }
  return updated;
}

export function readWorkspaceWorkflowConfigSource(
  workspace: string,
  workflowId: string,
): {
  file_path: string;
  section_path: string;
  template_id: string | null;
  yaml: string;
} {
  const document = readWorkspaceWorkflowDocument(workspace, resolveWorkspacePath(workspace));
  const workflow = asRecord(asRecord(document.workflows)[workflowId]);
  if (!Object.keys(workflow).length) {
    throw new Error(`未找到 workflow：${workflowId}`);
  }
  if (asString(workflow.workspace_id) !== workspace) {
    throw new Error(`workflow 不属于当前 workspace：${workflowId}`);
  }

  return {
    file_path: WORKSPACE_WORKFLOWS_FILE,
    section_path: `workflows.${workflowId}`,
    template_id: asString(workflow.extends),
    yaml: YAML.stringify({
      workflows: {
        [workflowId]: workflow,
      },
    }),
  };
}

export function listWorkspaceWorkflows(
  workspace: string,
  workspaceRoot: string,
  options: ListWorkspaceWorkflowsOptions = {},
): WorkspaceWorkflow[] {
  const rootConfig = readRootWorkflowConfig();
  const workspaceDocument = readWorkspaceWorkflowDocument(workspace, workspaceRoot);
  const workflows = Object.entries(asRecord(workspaceDocument.workflows)).flatMap(([id, value]) => {
    if (!isWorkflowId(id)) return [];
    const workflow = cachedWorkspaceWorkflow(rootConfig, workspace, workspaceRoot, id, value, options);
    return workflow ? [workflow] : [];
  });
  const runtime = runtimeWorkflowStatus(workflows, workspaceRoot);
  return workflows.map((workflow) => mergeWorkflowWithRuntimeStatus(
    workflow,
    workspaceRoot,
    runtime.runningStageKeys,
    runtime.generatedAt,
  ));
}

export function getWorkspaceWorkflow(
  workspace: string,
  workspaceRoot: string,
  workflowId: string,
  options: ListWorkspaceWorkflowsOptions = {},
): WorkspaceWorkflow {
  if (!isWorkflowId(workflowId)) {
    throw new Error(`workflow id is invalid: ${workflowId}`);
  }

  const rootConfig = readRootWorkflowConfig();
  const workspaceDocument = readWorkspaceWorkflowDocument(workspace, workspaceRoot);
  const workflowEntries = asRecord(workspaceDocument.workflows);
  const value = workflowEntries[workflowId];
  if (!isRecord(value)) {
    throw new Error(`未找到 workflow：${workflowId}`);
  }
  if (asString(value.workspace_id) !== workspace) {
    throw new Error(`workflow 不属于当前 workspace：${workflowId}`);
  }

  const workflow = cachedWorkspaceWorkflow(
    rootConfig,
    workspace,
    workspaceRoot,
    workflowId,
    value,
    options,
  );
  if (!workflow) {
    throw new Error(`未找到 workflow：${workflowId}`);
  }

  const runtime = runtimeWorkflowStatus([workflow], workspaceRoot);
  return mergeWorkflowWithRuntimeStatus(
    workflow,
    workspaceRoot,
    runtime.runningStageKeys,
    runtime.generatedAt,
  );
}
