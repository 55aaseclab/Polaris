import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createMockHost,
  DslInterpreter,
  DocStore,
  flattenDomain,
  runPipeline,
  type FfiInvokeRequest,
  type FfiInvokeResult,
} from "../src/index.js";

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/v2/${name}.ord`, import.meta.url)),
    "utf8",
  );
}

const toolResolver = {
  resolve(toolId: string) {
    return toolId === "synthetic.tool" ? { commands: ["run"] } : null;
  },
};

/** Synthetic host: records every invoke; the caller can shape outputs. */
class RecordingHost {
  readonly log: FfiInvokeRequest[] = [];
  readonly clearLog = () => {};
  has = () => true;
  resolveCollection: ((reference: unknown) => unknown[]) | undefined;
  onInvoke: (request: FfiInvokeRequest) => FfiInvokeResult = () => ({
    ok: true,
    output: { result: "synthetic" },
  });

  invoke(request: FfiInvokeRequest): FfiInvokeResult {
    this.log.push(request);
    return this.onInvoke(request);
  }
}

test("parallel branches run concurrently and join before the next step", async () => {
  const pipeline = runPipeline(fixture("positive-parallel"), { toolResolver });
  assert.equal(pipeline.ok, true, pipeline.issues.map((issue) => issue.message).join("; "));

  const parallel = pipeline.ast!.flows[0]!.body!.find((item) => item.kind === "Parallel");
  assert.ok(parallel && parallel.kind === "Parallel");
  assert.equal(parallel.id, "parallel-1");
  assert.deepEqual(parallel.branches.map((branch) => branch.id), ["left", "right"]);
  const host = new RecordingHost();
  const store = new DocStore();
  const result = await pipeline.program!.runAsync(
    "ParallelRun",
    { value: "synthetic" },
    store,
    host as never,
  );
  assert.equal(result.ok, true, result.message);
  assert.equal(host.log.length, 2);
  assert.ok(result.outputs?.leftResult);
  assert.ok(result.outputs?.rightResult);

  const groups = result.stepLog
    .map((log) => log.group)
    .filter((group) => group?.kind === "parallel");
  assert.ok(groups.some((group) => group?.branch === "left"));
  assert.ok(groups.some((group) => group?.branch === "right"));
  // join: the summary step runs only after both branches completed
  const summary = result.stepLog.find((log) => log.id === "summary");
  assert.ok(summary && summary.ok);
  assert.deepEqual(summary?.used, { leftResult: "synthetic", rightResult: "synthetic" });
});

test("choice walks the branch whose predicate matches the step context", async () => {
  const pipeline = runPipeline(fixture("positive-choice"), { toolResolver });
  assert.equal(pipeline.ok, true, pipeline.issues.map((issue) => issue.message).join("; "));

  const host = new RecordingHost();
  const fast = await pipeline.program!.runAsync(
    "ChoiceRun",
    { value: "synthetic", mode: "fast" },
    new DocStore(),
    host as never,
  );
  assert.equal(fast.ok, true, fast.message);
  const fastLog = fast.stepLog.find((log) => log.id === "fastPath");
  assert.ok(fastLog);
  assert.deepEqual(fastLog.group, { kind: "choice", id: "choice-1", branch: "when-1", when: 'mode == "fast"' });
  const decision = fast.stepLog.find((log) => log.id === "choice-1");
  assert.ok(decision && decision.ok);
  assert.deepEqual(decision.group, { kind: "choice", id: "choice-1", branch: "when-1", when: 'mode == "fast"' });

  const fallback = await pipeline.program!.runAsync(
    "ChoiceRun",
    { value: "synthetic", mode: "neither" },
    new DocStore(),
    new RecordingHost() as never,
  );
  assert.equal(fallback.ok, true, fallback.message);
  assert.ok(fallback.stepLog.some((log) => log.id === "fallback"));
  assert.ok(!fallback.stepLog.some((log) => log.id === "fastPath" || log.id === "slowPath"));
});

test("forEach iterates per list item and aggregates outputs", async () => {
  const pipeline = runPipeline(fixture("positive-foreach"), { toolResolver });
  assert.equal(pipeline.ok, true, pipeline.issues.map((issue) => issue.message).join("; "));

  const host = new RecordingHost();
  host.resolveCollection = () => [{ id: "a" }, { id: "b" }, { id: "c" }];
  host.onInvoke = (request) => ({ ok: true, output: { value: `done:${request.input.entry}` } });
  const result = await pipeline.program!.runAsync(
    "ForEachRun",
    { items: "items-ref" },
    new DocStore(),
    host as never,
  );
  assert.equal(result.ok, true, result.message);
  assert.equal(host.log.length, 3);
  const values = JSON.parse(String(result.outputs?.value)) as string[];
  assert.equal(values.length, 3);
  const iterations = result.stepLog
    .map((log) => log.group)
    .filter((group) => group?.kind === "forEach")
    .map((group) => group?.iteration);
  assert.deepEqual([...new Set(iterations)].sort(), [1, 2, 3]);
});

test("forEach rejects a source that is not a list artifact", () => {
  const pipeline = runPipeline(fixture("positive-foreach"), { toolResolver });
  const host = new RecordingHost();
  host.resolveCollection = () => null;
  const result = pipeline.program!.run(
    "ForEachRun",
    { items: "items-ref" },
    new DocStore(),
    host as never,
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /forEach source/u);
});

test("while loops until the condition reads a completed step output", async () => {
  const pipeline = runPipeline(fixture("positive-while"), { toolResolver });
  assert.equal(pipeline.ok, true, pipeline.issues.map((issue) => issue.message).join("; "));

  const host = new RecordingHost();
  let remaining = 3;
  host.onInvoke = () => {
    remaining -= 1;
    return { ok: true, output: { rounds: remaining, result: `round-${3 - remaining}` } };
  };
  const result = await pipeline.program!.runAsync(
    "WhileRun",
    { rounds: 3 },
    new DocStore(),
    host as never,
  );
  assert.equal(result.ok, true, result.message);
  assert.equal(host.log.length, 3);
  const iterations = result.stepLog
    .map((log) => log.group)
    .filter((group) => group?.kind === "while")
    .map((group) => group?.iteration);
  assert.deepEqual([...new Set(iterations)], [1, 2, 3]);
  assert.equal(result.outputs?.result, "round-3");
});

test("a failing step inside while terminates the loop (PRD 3.13.3 stop-loss)", async () => {
  const pipeline = runPipeline(fixture("positive-while"), { toolResolver });
  const host = new RecordingHost();
  let calls = 0;
  host.onInvoke = () => {
    calls += 1;
    if (calls > 1) return { ok: false, output: {}, error: "synthetic failure" };
    return { ok: true, output: { rounds: 2, result: "round-1" } };
  };
  const result = await pipeline.program!.runAsync(
    "WhileRun",
    { rounds: 3 },
    new DocStore(),
    host as never,
  );
  assert.equal(result.ok, false);
  assert.equal(calls, 2);
});

test("subflow reuses another flow's DAG and merges its outputs", async () => {
  const pipeline = runPipeline(fixture("positive-subflow"), { toolResolver });
  assert.equal(pipeline.ok, true, pipeline.issues.map((issue) => issue.message).join("; "));

  // input mapping parses (braced form)
  const subflowItem = pipeline.ast!.flows
    .find((flow) => flow.name === "SubflowRun")!.body!
    .find((item) => item.kind === "Subflow");
  assert.ok(subflowItem && subflowItem.kind === "Subflow");
  assert.deepEqual(subflowItem.input, { question: "question" });

  const host = new RecordingHost();
  host.onInvoke = () => ({ ok: true, output: { answer: "synthetic-answer" } });
  const result = await pipeline.program!.runAsync(
    "SubflowRun",
    { question: "synthetic question" },
    new DocStore(),
    host as never,
  );
  assert.equal(result.ok, true, result.message);
  assert.equal(host.log.length, 1);
  assert.ok(result.stepLog.some((log) => log.id === "ask"));
  const subflowLog = result.stepLog.find((log) => log.id === "subflow-1");
  assert.ok(subflowLog && subflowLog.ok);
  assert.deepEqual(subflowLog.group, { kind: "subflow", id: "subflow-1" });
  assert.equal(result.outputs?.answer, "synthetic-answer");

  const interpreter = new DslInterpreter(
    pipeline.ast!,
    new DocStore(),
    createMockHost(flattenDomain(pipeline.ast).ports),
  );
  const interpreted = interpreter.interpret("SubflowRun", { question: "synthetic question" });
  assert.equal(interpreted.ok, true, interpreted.message);
  assert.ok(interpreted.stepLog.some((log) => log.id === "ask"));
});

test("validator rejects subflow cycles (self and mutual)", () => {
  const selfCycle = runPipeline(fixture("negative-subflow-self-cycle"), { toolResolver });
  assert.equal(selfCycle.ok, false);
  assert.ok(selfCycle.issues.some((issue) => issue.code === "E_SUBFLOW_CYCLE"));

  const mutualCycle = runPipeline(fixture("negative-subflow-mutual-cycle"), { toolResolver });
  assert.equal(mutualCycle.ok, false);
  assert.ok(mutualCycle.issues.some((issue) => issue.code === "E_SUBFLOW_CYCLE"));
});

test("validator rejects a join that cannot guarantee a branch-only field", () => {
  const result = runPipeline(fixture("negative-join-incomplete"), { toolResolver });
  assert.equal(result.ok, false);
  const codes = result.issues.filter((issue) => issue.code === "E_CHOICE_NOT_EXHAUSTIVE");
  assert.ok(codes.length >= 2);
});

test("validator checks construct preconditions (branches, predicates, sources)", () => {
  const singleBranch = runPipeline(`
domain StructuredPack version "0.1.0"
flow Solo title "Solo" create {
  steps {
    parallel {
      branch only {
        mark "Mark" { output { done: Boolean } }
      }
    }
  }
  output { done: Boolean from done }
  ui { layout form primary "Run" }
}
`);
  assert.equal(singleBranch.ok, false);
  assert.ok(singleBranch.issues.some((issue) => issue.code === "E_PARALLEL_BRANCHES"));

  const unknownPredicateField = runPipeline(`
domain StructuredPack version "0.1.0"
flow Solo title "Solo" create {
  steps {
    choice {
      when missing == "x" {
        mark "Mark" { output { done: Boolean } }
      }
    }
  }
  output { done: Boolean from done }
  ui { layout form primary "Run" }
}
`);
  assert.equal(unknownPredicateField.ok, false);
  assert.ok(unknownPredicateField.issues.some((issue) => issue.code === "E_CHOICE_FIELD"));

  const unknownForEachSource = runPipeline(`
domain StructuredPack version "0.1.0"
flow Solo title "Solo" create {
  steps {
    forEach entry in ghost {
      mark "Mark" { output { done: Boolean } }
    }
  }
  output { done: Boolean from done }
  ui { layout form primary "Run" }
}
`);
  assert.equal(unknownForEachSource.ok, false);
  assert.ok(unknownForEachSource.issues.some((issue) => issue.code === "E_FOREACH_SOURCE"));

  const unknownWhileField = runPipeline(`
domain StructuredPack version "0.1.0"
flow Solo title "Solo" create {
  steps {
    while missing > 0 {
      mark "Mark" { output { done: Boolean } }
    }
  }
  output { done: Boolean from done }
  ui { layout form primary "Run" }
}
`);
  assert.equal(unknownWhileField.ok, false);
  assert.ok(unknownWhileField.issues.some((issue) => issue.code === "E_WHILE_FIELD"));

  const unknownSubflow = runPipeline(`
domain StructuredPack version "0.1.0"
flow Solo title "Solo" create {
  steps {
    subflow Ghost { }
  }
  output { done: Boolean from done }
  ui { layout form primary "Run" }
}
`);
  assert.equal(unknownSubflow.ok, false);
  assert.ok(unknownSubflow.issues.some((issue) => issue.code === "E_SUBFLOW_UNKNOWN"));
});

test("v1 linear packs remain parseable and valid (linear is a v2 subset)", () => {
  for (const pack of ["autoresearch", "cve-genie-trial"]) {
    const source = readFileSync(
      fileURLToPath(new URL(`../../../packs/${pack}/main.ord`, import.meta.url)),
      "utf8",
    );
    // No toolResolver: the real tool inventory belongs to the host app; the
    // structural regression here is parse + validate of the v1 surface.
    const pipeline = runPipeline(source);
    const blocking = pipeline.issues.filter((issue) => issue.level === "error");
    assert.equal(pipeline.ok, true, `${pack}: ${blocking.map((issue) => issue.message).join("; ")}`);
    for (const flow of flattenDomain(pipeline.ast!).flows) {
      assert.ok(flow.body && flow.body.length > 0);
      assert.ok(flow.steps.every((step) => step.uses.length > 0 || step.call));
    }
  }
});
