import assert from "node:assert/strict";
import test from "node:test";
import {
  createMockHost,
  DslInterpreter,
  DocStore,
  flattenDomain,
  runPipeline,
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
