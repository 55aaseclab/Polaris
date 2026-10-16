import assert from "node:assert/strict";
import test from "node:test";
import {
  createMockHost,
  DslInterpreter,
  DocStore,
  flattenDomain,
  runPipeline,
  type AsyncFfiHost,
  type FfiCallLog,
  type FfiInvokeRequest,
  type FfiInvokeResult,
} from "../src/index.js";

const source = `
domain TestCommerce version "0.1.0"
enum OrderStatus { Draft, Created, Approved }
entity Order {
  id : ID
  customer : String
  status : OrderStatus
}
flow CreateOrder title "Create order" on Order {
  create
  input { customer : String required }
  require { true }
  steps {
    create_record "Create" {
      uses { customer }
      output { orderId : ID }
    }
  }
  output {
    orderId : ID from orderId
    status : OrderStatus from record.status
  }
  transition status -> Created
  emit OrderCreated
  ui { layout form primary "Create" }
}
`;

test("public package pipeline parses, validates, and interprets a flow", () => {
  const pipeline = runPipeline(source);
  assert.equal(pipeline.ok, true);
  assert.ok(pipeline.ast);

  const store = new DocStore();
  const host = createMockHost(flattenDomain(pipeline.ast).ports);
  const interpreter = new DslInterpreter(pipeline.ast, store, host);
  const result = interpreter.interpret("CreateOrder", { customer: "Synthetic customer" });

  assert.equal(result.ok, true);
  assert.equal(result.record?.entity, "Order");
  assert.equal(result.record?.status, "Created");
  assert.equal(store.events[0]?.name, "OrderCreated");
});

test("removed trial DSL surface is rejected", () => {
  const versioned = runPipeline(`dsl version "0.4-trial"
domain RemovedTrial version "1.0.0"
entity Record { id: ID }
`);
  assert.equal(versioned.ok, false);
  assert.match(versioned.parseErrors.map((error) => error.message).join("; "), /Unsupported DSL language version/u);

  const trial = runPipeline(`dsl version "0.4"
domain RemovedTrial version "1.0.0"
trial Main { }
`);
  assert.equal(trial.ok, false);
  assert.match(trial.parseErrors.map((error) => error.message).join("; "), /trial DSL surface has been removed/u);
});

test("zero-input host ports may be called without a uses declaration", () => {
  const pipeline = runPipeline(`
domain ContextPack version "1.0.0"
port ResolveContext version "1.0.0" {
  out { contextId: String }
  effect read
}
flow ReadContext title "Read context" create {
  steps {
    context "Resolve context" {
      call ResolveContext
      output { contextId: String }
    }
  }
  output { contextId: String from contextId }
  ui { layout form primary "Read" }
}
`);

  assert.equal(pipeline.ok, true);
  assert.deepEqual(
    pipeline.issues.filter((issue) => issue.level === "warning"),
    [],
  );
});

const toolResolver = {
  resolve(toolId: string) {
    return toolId === "synthetic.tool"
      ? { commands: ["run"] }
      : null;
  },
};

const boundToolSource = `
domain SyntheticPack version "0.1.0"
port external.tool version "1.0.0" {
  in { value: String }
  out { result: String }
  effect ffi
  binding { tool "synthetic.tool" }
}
flow Run title "Run" create {
  input { value: String required }
  steps {
    invoke "Invoke" {
      uses { value }
      call external.tool
      command "run"
      output { result: String }
    }
  }
  output { result: String from result }
  ui { layout form primary "Run" }
}
`;

test("DSL validation accepts an FFI call when its tool and command exist", () => {
  const result = runPipeline(boundToolSource, { toolResolver });
  assert.equal(result.ok, true, result.issues.map((issue) => issue.message).join("; "));
});

test("DSL validation rejects an FFI call whose tool is absent from inventory", () => {
  const result = runPipeline(boundToolSource, {
    toolResolver: { resolve: () => null },
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "E_FFI_TOOL"));
});

test("DSL validation rejects an FFI call whose command is absent from inventory", () => {
  const result = runPipeline(boundToolSource.replace('command "run"', 'command "missing"'), {
    toolResolver,
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "E_FFI_COMMAND"));
});

test("DSL validation rejects an FFI port without a binding", () => {
  const result = runPipeline(boundToolSource.replace('binding { tool "synthetic.tool" }', ""));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "E_FFI_BINDING"));
});

test("map invokes its port once per collection item and aggregates outputs", () => {
  const source = `
domain MapPack version "0.1.0"
port item.process version "1.0.0" {
  in { item: String }
  out { value: String }
  effect ffi
  binding { tool "synthetic.tool" }
}
flow MapItems title "Map items" create {
  input { collection: String required }
  steps {
    process "Process items" {
      uses { collection }
      map item in collection call item.process
      command "run"
      output { value: String }
    }
  }
  output { value: String from value }
  ui { layout form primary "Run" }
}
`;
  const parsed = runPipeline(source, { toolResolver });
  assert.equal(parsed.ok, true, parsed.issues.map((issue) => issue.message).join("; "));
  const calls: FfiInvokeRequest[] = [];
  const host = {
    has: () => true,
    clearLog: () => {},
    log: [],
    resolveCollection: () => [{ id: "a" }, { id: "b" }],
    invoke(request: FfiInvokeRequest): FfiInvokeResult {
      calls.push(request);
      return { ok: true, output: { value: String(request.input.item) } };
    },
  };
  const result = parsed.program!.run("MapItems", { collection: "collection-ref" }, new DocStore(), host);
  assert.equal(result.ok, true, result.message);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.meta?.mapIndex, 0);
  assert.equal(calls[1]?.meta?.mapIndex, 1);
  assert.deepEqual(JSON.parse(String(result.outputs?.value)), [
    { id: "a", value: "{\"id\":\"a\"}" },
    { id: "b", value: "{\"id\":\"b\"}" },
  ]);
});

const asyncSource = `
domain AsyncPack version "1.0.0"
port ReadThing version "1.0.0" {
  in {
    subject: String
  }
  out {
    summary: String
  }
  effect read
}
flow Read title "Read" create {
  needs { ReadThing }
  input {
    subject: String required
  }
  steps {
    read "Read" {
      uses { subject }
      call ReadThing
      output {
        summary: String
      }
    }
  }
  output {
    summary: String from summary
  }
  ui { layout form primary "Read" }
}
`;

class AsyncReadHost implements AsyncFfiHost {
  readonly log: FfiCallLog[] = [];
  syncCalls = 0;
  asyncCalls = 0;

  has(port: string, version?: string): boolean {
    return port === "ReadThing" && (version === undefined || version === "1.0.0");
  }

  invoke(req: FfiInvokeRequest): FfiInvokeResult {
    this.syncCalls += 1;
    return {
      ok: true,
      output: { summary: `sync:${req.input.subject}` },
      resolvedVersion: "1.0.0",
    };
  }

  async invokeAsync(req: FfiInvokeRequest): Promise<FfiInvokeResult> {
    this.asyncCalls += 1;
    await Promise.resolve();
    return {
      ok: true,
      output: { summary: `async:${req.input.subject}` },
      resolvedVersion: "1.0.0",
    };
  }

  clearLog(): void {
    this.log.length = 0;
  }
}

test("compiled programs can await async FFI hosts without changing sync execution", async () => {
  const pipeline = runPipeline(asyncSource);
  assert.equal(pipeline.ok, true);
  assert.ok(pipeline.program);
  const program = pipeline.program;

  const syncHost = new AsyncReadHost();
  const syncResult = program.run(
    "Read",
    { subject: "synthetic" },
    new DocStore(),
    syncHost,
  );
  assert.equal(syncResult.ok, true);
  assert.equal(syncResult.outputs?.summary, "sync:synthetic");
  assert.equal(syncHost.syncCalls, 1);
  assert.equal(syncHost.asyncCalls, 0);

  const asyncHost = new AsyncReadHost();
  const asyncResult = await program.runAsync(
    "Read",
    { subject: "synthetic" },
    new DocStore(),
    asyncHost,
  );
  assert.equal(asyncResult.ok, true);
  assert.equal(asyncResult.outputs?.summary, "async:synthetic");
  assert.equal(asyncHost.syncCalls, 0);
  assert.equal(asyncHost.asyncCalls, 1);
});

const policyStepSource = (maxAttempts: string) => `
domain PolicyPack version "1.0.0"
port PolicyPort version "1.0.0" {
  out {
    status: String
  }
  effect write
}
flow PolicyRun title "Policy run" create {
  needs { PolicyPort }
  steps {
    go "Go" {
      call PolicyPort
      timeoutMs 1000
      budgetUsd 0.5
      maxAttempts ${maxAttempts}
      output {
        status: String
      }
    }
  }
  output {
    status: String from status
  }
  ui { layout form primary "Run" }
}
`;

test("step-level maxAttempts parses into the step policy (PRD 3.10.9)", () => {
  const pipeline = runPipeline(policyStepSource("5"));
  assert.equal(pipeline.ok, true);
  const step = pipeline.ast?.flows[0]?.steps[0];
  assert.equal(step?.maxAttempts, 5);
  assert.equal(step?.timeoutMs, 1000);
  assert.equal(step?.budgetUsd, 0.5);
});

test("step-level maxAttempts sanity checks reject non-positive and non-integer values", () => {
  const zero = runPipeline(policyStepSource("0"));
  assert.equal(zero.ok, false);
  assert.ok(zero.issues.some((issue) => issue.code === "E_STEP_MAX_ATTEMPTS"));

  const fractional = runPipeline(policyStepSource("2.5"));
  assert.equal(fractional.ok, false);
  assert.ok(fractional.issues.some((issue) => issue.code === "E_STEP_MAX_ATTEMPTS"));
});

const flowCapSource = (header: string) => `
domain FlowCapPack version "1.0.0"
port FlowCapPort version "1.0.0" {
  out {
    status: String
  }
  effect write
}
flow FlowCapRun title "Budget cap run" ${header} create {
  needs { FlowCapPort }
  steps {
    go "Go" {
      call FlowCapPort
      output {
        status: String
      }
    }
  }
  output {
    status: String from status
  }
  ui { layout form primary "Run" }
}
`;

test("flow-level budget declarations parse into the flow header (PRD 3.10.9)", () => {
  const pipeline = runPipeline(flowCapSource("budgetUsd 5.0 timeoutMs 2700000"));
  assert.equal(pipeline.ok, true);
  const flow = pipeline.ast?.flows[0];
  assert.equal(flow?.budgetUsd, 5.0);
  assert.equal(flow?.timeoutMs, 2700000);

  const bare = runPipeline(flowCapSource(""));
  assert.equal(bare.ok, true);
  assert.equal(bare.ast?.flows[0]?.budgetUsd, undefined);
  assert.equal(bare.ast?.flows[0]?.timeoutMs, undefined);
});

test("flow-level budget sanity checks reject negative budget and non-positive timeout", () => {
  const negativeBudget = runPipeline(flowCapSource("budgetUsd -1"));
  assert.equal(negativeBudget.ok, false);
  assert.ok(negativeBudget.issues.some((issue) => issue.code === "E_FLOW_BUDGET_USD"));

  const zeroTimeout = runPipeline(flowCapSource("timeoutMs 0"));
  assert.equal(zeroTimeout.ok, false);
  assert.ok(zeroTimeout.issues.some((issue) => issue.code === "E_FLOW_TIMEOUT_MS"));
});
