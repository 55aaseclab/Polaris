import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogRows,
  filterToolPortalCatalogRows,
  parseToolPortalRoute,
  toolDetail,
} from "./tool-portal-model.js";
import type { PolarisToolPortalCatalogRow } from "polaris-tools/source";

test("tool portal routes stay under the Polaris /tools base path", () => {
  assert.deepEqual(parseToolPortalRoute("/tools"), {});
  assert.deepEqual(parseToolPortalRoute("/tools/console"), {});
  assert.deepEqual(parseToolPortalRoute("/tools/publisher"), {});
  assert.deepEqual(parseToolPortalRoute("/tools/manual-review"), {
    slug: "manual-review",
  });
});

test("catalog rows are inspect-only and do not point at Wanghai", () => {
  const rows = catalogRows();
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.href.startsWith("/tools/")));
  assert.ok(rows.every((row) => row.scope === "common"));
  assert.ok(rows.every((row) => row.scopeLabel === "Common"));
  assert.ok(rows.every((row) => row.toolCalls.length > 0));
  assert.ok(rows.every((row) => !row.href.includes("wanghai")));
  assert.ok(rows.every((row) => row.liveState === "mock-only" || row.liveState === "disabled-live-boundary"));
});

test("detail and registry models expose no execution secrets", () => {
  const detail = toolDetail("manual-review");
  assert.equal(detail?.actionId, "manual.review");
  assert.equal(detail?.href, "/tools/manual-review");
  assert.ok(catalogRows().every((row) => !("executionUrl" in row)));
  assert.ok(catalogRows().every((row) => !("credentialValue" in row)));
});

test("catalog filters match scope, pack, and call text", () => {
  const rows = [
    catalogRow({
      id: "manual.review",
      name: "Manual Review",
      scope: "common",
      scopeLabel: "Common",
      toolCalls: [{
        id: "manual.review",
        port: "manual.review",
        version: "1.0.0",
        effect: "human",
        mappedToolId: "manual-review",
        unresolved: false,
      }],
    }),
    catalogRow({
      id: "domain-pack:AfaDtc:GrowthBottleneck",
      name: "增长瓶颈突破",
      scope: "domain-pack",
      scopeLabel: "AFA DTC Growth",
      domainPack: {
        id: "AfaDtc",
        name: "AFA DTC Growth",
        version: "2.4.7",
        digest: "sha256:test",
      },
      toolCalls: [{
        id: "TrackMetrics",
        port: "TrackMetrics",
        version: "1.0.0",
        effect: "read",
        unresolved: false,
      }],
    }),
  ];

  assert.deepEqual(
    filterToolPortalCatalogRows(rows, { query: "", scope: "common", packId: "" })
      .map((row) => row.id),
    ["manual.review"],
  );
  assert.deepEqual(
    filterToolPortalCatalogRows(rows, { query: "", scope: "domain-pack", packId: "AfaDtc" })
      .map((row) => row.id),
    ["domain-pack:AfaDtc:GrowthBottleneck"],
  );
  assert.deepEqual(
    filterToolPortalCatalogRows(rows, { query: "trackmetrics", scope: "all", packId: "" })
      .map((row) => row.id),
    ["domain-pack:AfaDtc:GrowthBottleneck"],
  );
  assert.deepEqual(
    filterToolPortalCatalogRows(rows, { query: "manual", scope: "domain-pack", packId: "" }),
    [],
  );
});

function catalogRow(
  overrides: Partial<PolarisToolPortalCatalogRow> & Pick<
    PolarisToolPortalCatalogRow,
    "id" | "name" | "scope" | "scopeLabel" | "toolCalls"
  >,
): PolarisToolPortalCatalogRow {
  return {
    slug: overrides.id,
    summary: "Synthetic row",
    category: "workflow",
    tags: [],
    publisherName: "Polaris",
    firstParty: true,
    effect: "human",
    risk: "human",
    liveState: "mock-only",
    href: `/tools/${overrides.id}`,
    ...overrides,
  };
}
