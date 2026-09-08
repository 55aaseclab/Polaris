import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { workflowRuntimeStageKey } from "@polaris/business-core/workflow-runtime-status";
import {
  createWorkspaceWorkflowInstance,
  deleteWorkspaceWorkflowInstance,
  listWorkspaceWorkflows,
  mergeWorkflowWithRuntimeStatus,
  updateWorkspaceWorkflowPaseoAgent,
} from "../lib/workspace-workflows.js";

test("new literature-review tasks inherit template stage fields", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "polaris-business-workflow-"));

  try {
    const workflow = createWorkspaceWorkflowInstance(
      "demo-research",
      workspaceRoot,
      "literature-review",
      { workflowId: "demo-review" },
    );

    const dataCollectionStage = workflow.stages.find((stage) => stage.id === "data-collection");
    const intelligenceAnalysisStage = workflow.stages.find((stage) => stage.id === "intelligence-analysis");
    const reportWritingStage = workflow.stages.find((stage) => stage.id === "report-writing");

    assert.equal(
      dataCollectionStage?.editable_fields.find((field) => field.path === "steps[1].id")?.value,
      "collect-literature",
    );
    assert.equal(
      intelligenceAnalysisStage?.editable_fields.find((field) => field.path === "steps[1].id")?.value,
      "analyze-literature",
    );
    assert.equal(
      reportWritingStage?.editable_fields.find((field) => field.path === "steps[1].id")?.value,
      "write-report",
    );
    assert.equal(
      intelligenceAnalysisStage?.editable_fields.find((field) => field.path === "review_policy.mode")?.value,
      "auto-pass",
    );
    assert.equal(
      intelligenceAnalysisStage?.editable_fields.find((field) => field.path === "question_prompt.method")?.value,
      "generate-text",
    );
    assert.equal(
      intelligenceAnalysisStage?.editable_fields.find((field) => field.path === "decision_context_prompt.output_kind")?.value,
      "text",
    );
    assert.equal(
      intelligenceAnalysisStage?.editable_fields.find((field) => field.path === "audience_prompt.method")?.value,
      "derive",
    );

    const savedConfig = readFileSync(join(workspaceRoot, "workflows.yaml"), "utf8");
    assert.doesNotMatch(savedConfig, /\n\s+steps:/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("deleteWorkspaceWorkflowInstance removes config and runtime files", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "polaris-business-workflow-delete-"));

  try {
    createWorkspaceWorkflowInstance(
      "demo-research",
      workspaceRoot,
      "literature-review",
      { workflowId: "demo-review" },
    );
    mkdirSync(join(workspaceRoot, "workflows", "demo-review", "report-writing", "outputs"), {
      recursive: true,
    });
    writeFileSync(
      join(workspaceRoot, "workflows", "demo-review", "report-writing", "outputs", "report.pdf"),
      "%PDF synthetic",
    );

    const deleted = deleteWorkspaceWorkflowInstance(
      "demo-research",
      workspaceRoot,
      "demo-review",
    );

    assert.equal(deleted.status, "deleted");
    assert.equal(existsSync(join(workspaceRoot, "workflows", "demo-review")), false);
    assert.doesNotMatch(
      readFileSync(join(workspaceRoot, "workflows.yaml"), "utf8"),
      /demo-review:/,
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("listWorkspaceWorkflows exposes the workflow file tree", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "polaris-business-workflow-files-"));

  try {
    createWorkspaceWorkflowInstance(
      "demo-research",
      workspaceRoot,
      "literature-review",
      { workflowId: "demo-review" },
    );
    mkdirSync(join(workspaceRoot, "workflows", "demo-review", "report-writing", "outputs"), {
      recursive: true,
    });
    writeFileSync(
      join(workspaceRoot, "workflows", "demo-review", "report-writing", "outputs", "report.pdf"),
      "%PDF synthetic",
    );

    const workflows = listWorkspaceWorkflows("demo-research", workspaceRoot);
    const workflow = workflows.find((item) => item.id === "demo-review");

    assert.ok(workflow);
    assert.ok(workflow?.files?.some((file) => file.path === "workflows/demo-review/case/README.md"));
    assert.ok(workflow?.files?.some((file) => file.path === "workflows/demo-review/report-writing/outputs/report.pdf"));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("cached workflow results refresh when a workflow asset changes", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "polaris-business-workflow-cache-"));

  try {
    createWorkspaceWorkflowInstance(
      "demo-research",
      workspaceRoot,
      "literature-review",
      { workflowId: "demo-review" },
    );

    const first = listWorkspaceWorkflows("demo-research", workspaceRoot)
      .find((workflow) => workflow.id === "demo-review");
    const second = listWorkspaceWorkflows("demo-research", workspaceRoot)
      .find((workflow) => workflow.id === "demo-review");
    assert.ok(first);
    assert.ok(second);
    assert.strictEqual(first?.files, second?.files);

    const newAsset = join(
      workspaceRoot,
      "workflows",
      "demo-review",
      "report-writing",
      "outputs",
      "draft-preview.md",
    );
    writeFileSync(newAsset, "# Draft preview\n");

    const refreshed = listWorkspaceWorkflows("demo-research", workspaceRoot)
      .find((workflow) => workflow.id === "demo-review");
    assert.ok(refreshed?.files?.some((file) => file.path.endsWith("draft-preview.md")));
    assert.notStrictEqual(refreshed?.files, first?.files);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("workflow summaries omit the expensive full asset tree", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "polaris-business-workflow-summary-"));

  try {
    createWorkspaceWorkflowInstance(
      "demo-research",
      workspaceRoot,
      "literature-review",
      { workflowId: "demo-review" },
    );

    const [summary] = listWorkspaceWorkflows("demo-research", workspaceRoot, { includeFiles: false });
    assert.ok(summary);
    assert.equal(summary?.files, undefined);
    assert.ok(summary?.stages.every((stage) => Array.isArray(stage.outputs)));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("listWorkspaceWorkflows rejects a symlinked workflow root", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "polaris-business-workflow-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "polaris-business-workflow-symlink-outside-"));

  try {
    createWorkspaceWorkflowInstance(
      "demo-research",
      workspaceRoot,
      "literature-review",
      { workflowId: "demo-review" },
    );
    rmSync(join(workspaceRoot, "workflows", "demo-review"), { recursive: true, force: true });
    symlinkSync(outside, join(workspaceRoot, "workflows", "demo-review"));

    assert.throws(
      () => listWorkspaceWorkflows("demo-research", workspaceRoot),
      /symlink outside/i,
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("listWorkspaceWorkflows includes stage steps and dependencies for graph rendering", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "polaris-business-workflow-graph-"));

  try {
    createWorkspaceWorkflowInstance(
      "demo-research",
      workspaceRoot,
      "literature-review",
      { workflowId: "demo-review" },
    );

    const workflow = listWorkspaceWorkflows("demo-research", workspaceRoot)
      .find((item) => item.id === "demo-review");

    assert.ok(workflow);
    assert.deepEqual(
      workflow?.stages.find((stage) => stage.id === "data-collection")?.steps[0],
      {
        args: [
          "--input",
          "{{data_collection_input}}",
          "--workspace",
          "{{workspace_id}}",
          "--run-prefix",
          "{{workflow_id}}",
          "--output",
          "{{collection_output}}",
          "--review-mode",
          "auto-approve",
        ],
        command: "run",
        id: "collect-literature",
        label: "data-collection.run",
        tool: "data-collection",
      },
    );
    assert.deepEqual(
      workflow?.stages.find((stage) => stage.id === "intelligence-analysis")?.depends_on_stage_ids,
      ["data-collection"],
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("listWorkspaceWorkflows backfills the default free-discussion workflow", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "polaris-business-workflow-default-"));

  try {
    const workflows = listWorkspaceWorkflows("demo-research", workspaceRoot);
    const discussion = workflows.find((workflow) => workflow.template_id === "free-discussion");

    assert.ok(discussion);
    assert.equal(discussion?.template_id, "free-discussion");
    assert.equal(discussion?.stages[0]?.id, "discussion");
    assert.equal(
      existsSync(join(workspaceRoot, "workflows", "discussion-demo-research", "discussion")),
      true,
    );
    const savedConfig = readFileSync(join(workspaceRoot, "workflows.yaml"), "utf8");
    assert.match(savedConfig, /schema_version: wanghai\.workspace-workflows\.v1/);
    assert.match(savedConfig, /workspace_id: demo-research/);
    assert.match(savedConfig, /discussion-demo-research:/);
    assert.match(savedConfig, /root_path: workflows\/discussion-demo-research\/discussion/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("runtime status overlays running workflow stages without a CLI subprocess", () => {
  const merged = mergeWorkflowWithRuntimeStatus(
    {
      category: "literature-review",
      description: "Synthetic workflow",
      id: "demo-review",
      last_run: {
        finished_at: "2026-07-30T10:00:00Z",
        path: "workflows/demo-review/runs/20260730-100000",
        started_at: "2026-07-30T09:00:00Z",
        status: "succeeded",
      },
      paseo: null,
      paseo_workspace_path: "/tmp/demo-review",
      pipeline_status: "current",
      stages: [
        {
          depends_on_stage_ids: [],
          editable_fields: [],
          id: "data-collection",
          inputs: [],
          label: "数据采集",
          outputs: [],
          root_path: "workflows/demo-review/data-collection",
          steps: [],
          status: {
            artifact: null,
            facts: [],
            modified_at: null,
            ready: false,
            size: null,
            status: null,
          },
        },
        {
          depends_on_stage_ids: [],
          editable_fields: [],
          id: "report-writing",
          inputs: [],
          label: "报告写作",
          outputs: [],
          root_path: "workflows/demo-review/report-writing",
          steps: [],
          status: {
            artifact: "workflows/demo-review/report-writing/outputs/report.pdf",
            facts: [],
            modified_at: "2026-07-30T10:00:00Z",
            ready: true,
            size: 1024,
            status: "final",
          },
        },
      ],
      status_generated_at: null,
      template_id: "literature-review",
      title: "Demo Review",
    },
    "/tmp/workspace-root",
    new Set([workflowRuntimeStageKey("demo-review", "data-collection")]),
    "2026-07-31T08:00:00Z",
  );

  assert.equal(merged.pipeline_status, "current");
  assert.equal(merged.status_generated_at, "2026-07-31T08:00:00Z");
  assert.equal(merged.last_run?.status, "running");
  assert.equal(merged.last_run?.path, "workflows/demo-review/runs/20260730-100000");
  assert.equal(
    merged.stages.find((stage) => stage.id === "data-collection")?.status.status,
    "running",
  );
  assert.equal(
    merged.stages.find((stage) => stage.id === "report-writing")?.status.status,
    "final",
  );
});

test("Paseo companion persists its agent on the concrete workflow instance", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "polaris-business-paseo-workflow-"));

  try {
    createWorkspaceWorkflowInstance(
      "demo-research",
      workspaceRoot,
      "literature-review",
      { workflowId: "demo-review" },
    );

    const before = listWorkspaceWorkflows("demo-research", workspaceRoot)
      .find((workflow) => workflow.id === "demo-review");
    assert.equal(before?.paseo, null);
    assert.equal(
      before?.paseo_workspace_path,
      join(workspaceRoot, "workflows", "demo-review"),
    );

    const updated = updateWorkspaceWorkflowPaseoAgent(
      "demo-research",
      workspaceRoot,
      "demo-review",
      "agent-example-123",
    );

    assert.deepEqual(updated.paseo, { agent_id: "agent-example-123" });
    assert.match(
      readFileSync(join(workspaceRoot, "workflows.yaml"), "utf8"),
      /paseo:\n\s+agent_id: agent-example-123/,
    );
    assert.deepEqual(
      listWorkspaceWorkflows("demo-research", workspaceRoot)
        .find((workflow) => workflow.id === "demo-review")?.paseo,
      { agent_id: "agent-example-123" },
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
