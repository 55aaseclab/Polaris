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
