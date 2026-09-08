import assert from "node:assert/strict";
import test from "node:test";
import { resolveSelectedOrderNo } from "../lib/order-management-navigation.js";

test("keeps a selected order when it is in the current order list", () => {
  assert.equal(
    resolveSelectedOrderNo("ORD-SYNTHETIC-001", [
      { order_no: "ORD-SYNTHETIC-001" },
      { order_no: "ORD-SYNTHETIC-002" },
    ]),
    "ORD-SYNTHETIC-001",
  );
});

test("rejects an order deep link that is not in the current workspace", () => {
  assert.equal(
    resolveSelectedOrderNo("ORD-SYNTHETIC-MISSING", [
      { order_no: "ORD-SYNTHETIC-001" },
    ]),
    null,
  );
});
