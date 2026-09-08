import { readAndValidateOrderMeta } from "../../../packages/polaris-business-core/src/operations.js";

const metaPath = process.argv[2];
if (!metaPath) {
  console.error("Usage: tsx scripts/validate-order.ts <订单管理/order_no/meta.json>");
  process.exit(1);
}

readAndValidateOrderMeta(metaPath);
console.log("order metadata valid");
