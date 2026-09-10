import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DocStore,
  runPipeline,
  type FfiHost,
  type FfiInvokeRequest,
  type FfiInvokeResult,
  type PortAst,
} from "polaris-workflow";
import { listDomainPackProjections } from "../scripts/config/domain-packs.js";
import { closePolarisControlStore } from "../scripts/portal/control-store.js";
import { WorkflowControlService } from "../scripts/portal/workflow-control.js";

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../..",
);
const DEFINITION = path.join(REPO_ROOT, "packs", "autoresearch", "main.ord");

class SyntheticToolHost implements FfiHost {
  readonly log = [];

  constructor(private readonly ports: PortAst[]) {}

  has(): boolean {
    return true;
  }

  clearLog(): void {
    this.log.length = 0;
  }

  invoke(request: FfiInvokeRequest): FfiInvokeResult {
    const port = this.ports.find((candidate) =>
      (candidate.qualifiedName ?? candidate.name) === request.port
      || candidate.name === request.port,
    );
    const output: Record<string, string | number | boolean> = {};
    for (const field of port?.outFields ?? []) {
      output[field.name] = field.type === "Boolean"
        ? true
        : field.type === "Number" || field.type === "Money"
          ? 1
          : `synthetic:${request.port}:${field.name}`;
    }
    return { ok: true, output, resolvedVersion: "1.0.0" };
  }
}

test("AutoResearch is a declaration-only pack with one flow and no legacy graphs", () => {
  const source = fs.readFileSync(DEFINITION, "utf8");
  const result = runPipeline(source);
  assert.equal(result.ok, true, result.issues.map((issue) => issue.message).join("; "));
  assert.equal(result.ast?.name, "AutoResearch");
  assert.deepEqual(result.ast?.pipelines, []);
  assert.deepEqual(result.ast?.trials, []);
  assert.deepEqual(result.ast?.flows.map((flow) => flow.name), ["LiteratureReview"]);
  assert.equal(result.ast?.flows[0]?.steps.length, 13);
  assert.deepEqual(
    result.ast?.ports.map((port) => port.qualifiedName ?? port.name),
    [
      "literature.codex",
      "literature.collection",
      "literature.analysis",
      "literature.report",
    ],
  );
  assert.deepEqual(
    result.ast?.flows[0]?.outputs.map((output) => output.name),
    ["pdfRef", "markdownRef", "manifestRef"],
  );
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "tools", "literature-review")), false);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "packs", "autoresearch", "workflow.py")), false);
});

test("the compiled LiteratureReview flow runs from its declared inputs and produces pdfRef", async () => {
  const result = runPipeline(fs.readFileSync(DEFINITION, "utf8"));
  assert.ok(result.program);
  const flow = result.ast?.flows.find((candidate) => candidate.name === "LiteratureReview");
  assert.ok(flow);
  const input = Object.fromEntries(flow.inputs.map((field) => [field.name, `synthetic:${field.name}`]));
  const execution = await result.program.runAsync(
    "LiteratureReview",
    input,
    new DocStore(),
    new SyntheticToolHost(result.ast?.ports ?? []),
  );
  assert.equal(execution.ok, true, execution.message);
  assert.equal(typeof execution.outputs?.pdfRef, "string");
  assert.equal(execution.stepLog.length, flow.steps.length);
});

test("Polaris admits LiteratureReview using only the flow's declared inputs", async () => {
  const previousDataRoot = process.env.POLARIS_DATA_ROOT;
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-flow-admission-"));
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
      autoStart: false,
    });
    const admitted = await service.createRun("synthetic-tenant", {
      packId: "AutoResearch",
      flowId: "LiteratureReview",
      driver: "none",
      values: {
        question: "synthetic question",
        decisionContext: "synthetic context",
        audience: "synthetic audience",
        reviewMode: "synthetic mode",
        reportTemplate: "synthetic template",
      },
    });
    assert.equal(admitted.packId, "AutoResearch");
    assert.equal(admitted.flowId, "LiteratureReview");
    assert.equal(admitted.status, "queued");
  } finally {
    service?.close();
    closePolarisControlStore();
    fs.rmSync(dataRoot, { recursive: true, force: true });
    if (previousDataRoot === undefined) delete process.env.POLARIS_DATA_ROOT;
    else process.env.POLARIS_DATA_ROOT = previousDataRoot;
  }
});
