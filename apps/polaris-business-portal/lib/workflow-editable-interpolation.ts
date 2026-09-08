import path from "node:path";

type ConfigRecord = Record<string, unknown>;

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

function normalizedRelativePath(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  return raw
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

function stagePrefix(stageId: string): string {
  return stageId.replaceAll("-", "_");
}

function stagePathKey(stageId: string, suffix: "input" | "output" | "root"): string {
  return `${stagePrefix(stageId)}_${suffix}`;
}

export function buildWorkflowInterpolationValues({
  category,
  stages,
  workflowId,
  workspaceId,
  workspaceRoot,
}: {
  category: string;
  stages: Record<string, unknown>;
  workflowId: string;
  workspaceId: string;
  workspaceRoot: string;
}): Record<string, string> {
  const values: Record<string, string> = {
    category,
    workflow_id: workflowId,
    workspace_id: workspaceId,
    workspace_root: workspaceRoot,
  };
  const scalarValues = new Map<string, string[]>();

  for (const [stageId, stageValue] of Object.entries(stages)) {
    const stage = asRecord(stageValue);
    const rootPath = normalizedRelativePath(stage.root_path);
    if (rootPath) {
      const root = path.resolve(workspaceRoot, rootPath);
      values[stagePathKey(stageId, "root")] = root;
      values[stagePathKey(stageId, "input")] = path.join(root, "inputs", "input.json");
      const outputPath = normalizedRelativePath(stage.output_path) ?? "outputs/output.json";
      values[stagePathKey(stageId, "output")] = path.resolve(root, outputPath);
    }

    const prefix = stagePrefix(stageId);
    for (const [key, item] of Object.entries(stage)) {
      if (typeof item !== "string") continue;
      values[`${prefix}_${key}`] = item;
      const prior = scalarValues.get(key) ?? [];
      prior.push(item);
      scalarValues.set(key, prior);
    }
  }

  for (const [key, stageValues] of scalarValues.entries()) {
    if (stageValues.length === 1) values[key] = stageValues[0]!;
  }

  if (values.data_collection_output) {
    values.collection_output = values.data_collection_output;
  }
  if (values.intelligence_analysis_root) {
    values.analysis_root = values.intelligence_analysis_root;
  }
  if (values.intelligence_analysis_input) {
    values.analysis_input = values.intelligence_analysis_input;
  }
  if (values.intelligence_analysis_output) {
    values.analysis_output = values.intelligence_analysis_output;
  }
  if (values.report_writing_root) {
    values.report_root = values.report_writing_root;
    values.report_draft = path.join(values.report_root, "work", "draft.json");
    values.report_tex = path.join(values.report_root, "outputs", "report.tex");
    values.report_bib = path.join(values.report_root, "outputs", "references.bib");
  }
  if (values.report_writing_input) {
    values.report_input = values.report_writing_input;
  }
  if (values.report_writing_output) {
    values.report_pdf = values.report_writing_output;
  }

  const reportStage = asRecord(stages["report-writing"]);
  const template = asString(reportStage.template);
  if (template) {
    values.report_template = template;
  }
  const claimFilter = normalizedRelativePath(reportStage.claim_filter);
  if (claimFilter && values.report_root) {
    values.report_claim_filter = path.resolve(values.report_root, claimFilter);
  }

  return values;
}
