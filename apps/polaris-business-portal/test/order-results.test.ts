import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OrderResults } from "../components/commerce-operations-panel.js";

test("renders each order summary as an openable button", () => {
  const html = renderToStaticMarkup(createElement(OrderResults, {
    locale: "en-US",
    onOpenOrder: () => undefined,
    orders: [{
      amount: 42,
      currency: "USD",
      customer: "Synthetic customer",
      order_date: "2026-01-01",
      order_no: "ORD-SYNTHETIC-001",
      process_status: "draft",
      status: "draft",
      validation_error: null,
    }],
  }));

  assert.match(html, /<button[^>]*aria-label="打开订单 ORD-SYNTHETIC-001"/u);
});
