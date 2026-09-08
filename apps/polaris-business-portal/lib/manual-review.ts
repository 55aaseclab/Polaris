import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@polaris/business-core";
import {
  bootstrapManualReview,
  exportManualReview as exportManualReviewState,
  saveManualReview as saveManualReviewState,
  type ManualReviewPaths as CoreManualReviewPaths,
} from "@polaris/business-core/manual-review";
import { safeWorkspacePath, workspaceRelativePath } from "@polaris/business-core/workspaces";
import { isIntegratedBusinessRuntime } from "./business-runtime.js";

type JsonObject = Record<string, unknown>;

type ManualReviewPaths = {
  kind: "collection" | "generic";
  manualList: string;
  nonReview: string | null;
  output: string;
  reviewMode: string | null;
  stageRoot: string;
  state: string;
};

export class WanghaiManualReviewPolicyError extends Error {
  readonly statusCode = 503;

  constructor(message: string) {
    super(message);
    this.name = "WanghaiManualReviewPolicyError";
  }
}

/**
 * Finalizing an intelligence analysis invokes an executor and changes a
 * workflow result. Polaris must own that durable job in integrated mode.
 */
export function assertManualReviewActionIsSurfaceOnly(
  completeAnalysis: boolean,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    completeAnalysis
    && isIntegratedBusinessRuntime(env)
  ) {
    throw new WanghaiManualReviewPolicyError(
      "Integrated intelligence-analysis completion requires the Polaris durable job service",
    );
  }
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readJson(filePath: string, label: string): JsonObject {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} does not exist`);
  }
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} must contain a JSON object`);
    }
    return value as JsonObject;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
    throw error;
  }
}

function readOptionalJson(filePath: string): JsonObject | null {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  return readJson(filePath, path.basename(filePath));
}

function intelligenceAnalysisBinary() {
  const binary = path.join(
    REPO_ROOT,
    "tools",
    "intelligence-analysis",
    "clue-intelligence-analysis",
  );
  if (!fs.existsSync(binary)) throw new Error("Cannot locate clue-intelligence-analysis");
  return binary;
}

function parsedErrorMessage(stdout: string | undefined) {
  if (!stdout) return null;
  try {
    const value = asObject(JSON.parse(stdout));
    return asString(value.error);
  } catch {
    return null;
  }
}

function runJsonCommand(binary: string, args: string[]): JsonObject {
  let stdout: string;
  try {
    stdout = execFileSync(binary, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
    });
  } catch (error) {
    const detail = error as { message?: string; stderr?: string; stdout?: string };
    throw new Error(
      parsedErrorMessage(detail.stdout)
      ?? detail.stderr?.trim()
      ?? detail.message
      ?? "workflow command failed",
    );
  }

  try {
    return asObject(JSON.parse(stdout));
  } catch {
    throw new Error(`${path.basename(binary)} returned non-JSON output`);
  }
}

function pathsForManualList(workspaceRoot: string, assetPath: string): ManualReviewPaths {
  const manualList = safeWorkspacePath(workspaceRoot, assetPath);
  if (path.basename(manualList) !== "manual-review-list.json") {
    throw new Error("Asset is not a manual-review-list.json file");
  }

  const outputsDir = path.dirname(manualList);
  if (path.basename(outputsDir) !== "outputs") {
    throw new Error("manual-review-list.json must be inside a stage outputs directory");
  }

  const stageRoot = path.dirname(outputsDir);
  const document = readJson(manualList, "manual-review-list.json");
  const generic = document.schema_version === "clue.manual-review.v2";
  const nonReview = path.join(outputsDir, "non-review-results.json");
  if (!generic && !fs.existsSync(nonReview)) {
    throw new Error("Customer manual-review-list.json requires non-review-results.json");
  }

  return {
    kind: generic ? "generic" : "collection",
    manualList,
    nonReview: generic ? null : nonReview,
    output: generic
      ? path.join(stageRoot, "work", "manual-review", "review-result.json")
      : path.join(outputsDir, "output.json"),
    reviewMode: asString(document.review_mode),
    stageRoot,
    state: generic
      ? path.join(stageRoot, "work", "manual-review", "review-state.json")
      : path.join(stageRoot, "work", "review-state.json"),
  };
}

function corePaths(paths: ManualReviewPaths): CoreManualReviewPaths {
  return {
    manualList: paths.manualList,
    nonReview: paths.nonReview,
    output: paths.output,
    state: paths.state,
  };
}

function isIntelligenceAnalysis(paths: ManualReviewPaths, workspaceRoot: string) {
  return paths.kind === "generic"
    && workspaceRelativePath(workspaceRoot, paths.stageRoot)
      .startsWith("intelligence-analysis/");
}

function isReadOnly(paths: ManualReviewPaths) {
  if (paths.reviewMode === "auto-pass" || paths.reviewMode === "auto-approve") {
    return true;
  }
  const output = readOptionalJson(path.join(paths.stageRoot, "outputs", "output.json"));
  const review = asObject(output?.review);
  const approvalMode = asString(review.approval_mode);
  return output?.status === "final" && approvalMode?.startsWith("auto_") === true;
}

function publicPayload(
  workspaceRoot: string,
  paths: ManualReviewPaths,
  payload: JsonObject,
) {
  return {
    ...payload,
    asset_path: workspaceRelativePath(workspaceRoot, paths.manualList),
    can_complete_analysis: isIntelligenceAnalysis(paths, workspaceRoot),
    kind: paths.kind,
    paths: {
      result_file: workspaceRelativePath(workspaceRoot, paths.output),
      state_file: workspaceRelativePath(workspaceRoot, paths.state),
    },
    read_only: isReadOnly(paths),
    review_mode: paths.reviewMode,
  };
}

export function getManualReview(workspaceRoot: string, assetPath: string): JsonObject {
  const paths = pathsForManualList(workspaceRoot, assetPath);
  const payload = bootstrapManualReview(corePaths(paths));
  return publicPayload(workspaceRoot, paths, payload);
}

export function saveManualReview(
  workspaceRoot: string,
  assetPath: string,
  recordId: string,
  status: unknown,
  note: unknown,
): JsonObject {
  if (!recordId.trim()) throw new Error("Review request requires record_id");
  if (!["pending", "approved", "rejected"].includes(String(status))) {
    throw new Error("Review status must be pending, approved, or rejected");
  }
  if (typeof note !== "string" || note.length > 5000) {
    throw new Error("Review note must be a string up to 5000 characters");
  }

  const paths = pathsForManualList(workspaceRoot, assetPath);
  if (isReadOnly(paths)) throw new Error("This review list is an automatic audit artifact");
  return saveManualReviewState(corePaths(paths), recordId, status, note);
}

export function exportManualReview(
  workspaceRoot: string,
  assetPath: string,
  completeAnalysis: boolean,
): JsonObject {
  assertManualReviewActionIsSurfaceOnly(completeAnalysis);
  const paths = pathsForManualList(workspaceRoot, assetPath);
  if (isReadOnly(paths)) {
    throw new Error("This review list is an automatic audit artifact");
  }
  const exported = exportManualReviewState(corePaths(paths));
  if (!completeAnalysis || !isIntelligenceAnalysis(paths, workspaceRoot)) {
    return exported;
  }

  const completion = runJsonCommand(intelligenceAnalysisBinary(), [
    "complete-review",
    "--analysis-root",
    paths.stageRoot,
    "--review-result",
    paths.output,
  ]);
  return { ...exported, completion };
}
