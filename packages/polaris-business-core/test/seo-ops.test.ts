import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  createManualMetricsSnapshot,
  createSeoSite,
  listSeoSites,
  patchSeoSite,
  seoSiteDetail,
  setSeoTaskState,
} from "../src/seo-ops.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seo-ops-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "产品管理"), { recursive: true });
  return root;
}

describe("seo-ops", () => {
  it("creates multiple sites and tracks playbook tasks", () => {
    const ws = makeWorkspace();
    createSeoSite(ws, {
      site_id: "site-alpha",
      name: "Alpha Tools",
      primary_domain: "https://alpha.example/",
      markets: ["US", "EU"],
    });
    createSeoSite(ws, {
      site_id: "site-beta",
      name: "Beta AI",
      primary_domain: "beta.example.com",
    });
    createSeoSite(ws, {
      site_id: "site-gamma",
      name: "Gamma",
      primary_domain: "gamma.test",
      status: "live",
    });

    const listed = listSeoSites(ws);
    assert.equal(listed.length, 3);
    assert.equal(listed[0]?.primary_domain, "alpha.example");

    setSeoTaskState(ws, "site-alpha", "foundation.icp", "done", "ICP drafted");
    setSeoTaskState(ws, "site-alpha", "onpage_tech.basics", "doing");
    const detail = seoSiteDetail(ws, "site-alpha");
    assert.ok(detail.summary.progress.done >= 1);
    assert.equal(detail.summary.progress.doing, 1);
    assert.ok(detail.sections.length >= 4);

    patchSeoSite(ws, "site-alpha", {
      integrations: { ga4_property_id: "properties/123" },
    });
    const metrics = createManualMetricsSnapshot(ws, "site-alpha", {
      period_start: "2026-07-01",
      period_end: "2026-07-07",
      totals: { sessions: 1200, organic_sessions: 400 },
    });
    assert.equal(metrics.totals.sessions, 1200);
    assert.equal(seoSiteDetail(ws, "site-alpha").metrics[0]?.totals.organic_sessions, 400);
  });

  it("rejects bad site ids", () => {
    const ws = makeWorkspace();
    assert.throws(() =>
      createSeoSite(ws, { site_id: "Bad_ID", name: "x", primary_domain: "x.com" }),
    );
  });
});
