import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  InMemoryTrialStateStore,
  MockHost,
  runPipeline,
  trialHostFromFfi,
} from "polaris-workflow";
import { WorkflowControlService } from "../scripts/portal/workflow-control.js";
import { closePolarisControlStore } from "../scripts/portal/control-store.js";
import { listDomainPackProjections } from "../scripts/config/domain-packs.js";

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../..",
);
const PACK_ROOT = path.join(REPO_ROOT, "packs", "autoresearch");
const DEFINITION = path.join(PACK_ROOT, "main.ord");

function trialInput(): Record<string, unknown> {
  return {
    inputRef: "synthetic-collection-input",
    workspaceId: "synthetic-workspace",
    runPrefix: "synthetic-run",
    analysisId: "synthetic-analysis",
    reportId: "synthetic-report",
    question: "Which bounded behavior is supported by the synthetic corpus?",
    decisionContext: "Synthetic DSL trial test",
    audience: "research engineering",
    reviewMode: "auto-pass",
    literatureMethod: "iterate",
    reportReviewMode: "fixed",
    reportTemplate: "auto",
    batchSize: 10,
  };
}

test("AutoResearch is a declaration-only pack with one flow and one execution trial", () => {
  const source = fs.readFileSync(DEFINITION, "utf8");
  const result = runPipeline(source);
  assert.equal(result.ok, true, result.issues.map((issue) => issue.message).join("; "));
  assert.equal(result.ast?.name, "AutoResearch");
  assert.deepEqual(result.ast?.pipelines, []);
  assert.deepEqual(result.ast?.flows.map((flow) => flow.name), ["LiteratureReview"]);
  assert.equal(result.ast?.flows[0]?.steps.length, 3);
  assert.deepEqual(
    result.ast?.trials?.map((trial) => trial.name),
    ["LiteratureReviewExecution"],
  );
  assert.equal(result.ast?.trials?.[0]?.nodes.length, 18);
  assert.equal(result.ast?.trials?.[0]?.edges.length, 22);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "tools", "literature-review")), false);
  assert.equal(fs.existsSync(path.join(PACK_ROOT, "workflow.py")), false);
});

test("the AutoResearch trial runs from the DSL and materializes its declared artifacts", async () => {
  const source = fs.readFileSync(DEFINITION, "utf8");
  const result = runPipeline(source);
  assert.ok(result.trialPrograms?.[0]);
  const trial = result.trialPrograms[0];
  const mockHost = new MockHost([...trial.ports]);
  const originalInvoke = mockHost.invoke.bind(mockHost);
  mockHost.invoke = (request) => {
    const result = originalInvoke(request);
    for (const [key, value] of Object.entries(result.output)) {
      if (typeof value === "string") result.output[key] = `${request.port}:${key}`;
    }
    if (request.port === "ResolveCollectionReview") {
      result.output.collectionReviewPending = false;
    }
    if (request.port === "ResolveAnalysisReview") {
      result.output.analysisReviewPending = false;
    }
    if (request.port === "ReviewLiteratureReport") {
      result.output.reportPassed = true;
    }
    return result;
  };
  const host = trialHostFromFfi(mockHost, () => true);
  const state = await trial.run(trialInput(), host, {
    runId: "synthetic-trial-run",
    store: new InMemoryTrialStateStore(),
    allowNetwork: true,
  });
  assert.equal(state.status, "succeeded", JSON.stringify(state.error));
  assert.ok(state.artifacts.some((artifact) => artifact.name === "pdfRef"));
  assert.ok(state.receipts.length >= 10);
  assert.equal(state.workflow, "LiteratureReviewExecution");
});

test("Polaris executes AutoResearch through the declared trial without the removed tool", async () => {
  const previousDataRoot = process.env.POLARIS_DATA_ROOT;
  const dataRoot = fs.mkdtempSync(path.join("/tmp", "polaris-dsl-runtime-"));
  process.env.POLARIS_DATA_ROOT = dataRoot;
  let service: WorkflowControlService | undefined;
  try {
    const pack = listDomainPackProjections(import.meta.url).find(
      (candidate) => candidate.id === "AutoResearch",
    );
    assert.ok(pack);
    service = new WorkflowControlService({
      importMetaUrl: import.meta.url,
      listPacks: () => [pack],
      listVaults: async () => [],
      autoStart: true,
      pollMs: 10,
    });
    const admitted = await service.createRun("synthetic-tenant", {
      packId: "AutoResearch",
      flowId: "LiteratureReview",
      driver: "none",
      values: { brief: "synthetic DSL execution" },
    });
    const deadline = Date.now() + 2_000;
    let completed = admitted;
    while (
      Date.now() < deadline
      && completed.status !== "succeeded"
      && completed.status !== "failed"
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      completed = await service.getRun("synthetic-tenant", admitted.id);
    }
    assert.equal(completed.status, "succeeded", completed.error?.message);
    assert.ok(completed.artifacts.length > 0);
    assert.ok(completed.receipts.length > 0);
  } finally {
    service?.close();
    closePolarisControlStore();
    fs.rmSync(dataRoot, { recursive: true, force: true });
    if (previousDataRoot === undefined) delete process.env.POLARIS_DATA_ROOT;
    else process.env.POLARIS_DATA_ROOT = previousDataRoot;
  }
});
