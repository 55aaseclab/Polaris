import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bootstrapManualReview,
  exportManualReview,
  saveManualReview,
  type ManualReviewPaths,
} from "../src/manual-review.js";

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function writeJson(filePath: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function collectionPaths(root: string): ManualReviewPaths {
  const outputs = path.join(root, "data-collections", "example", "outputs");
  return {
    manualList: path.join(outputs, "manual-review-list.json"),
    nonReview: path.join(outputs, "non-review-results.json"),
    output: path.join(outputs, "output.json"),
    state: path.join(root, "data-collections", "example", "work", "review-state.json"),
  };
}

function genericPaths(root: string): ManualReviewPaths {
  const stage = path.join(root, "intelligence-analysis", "example");
  return {
    manualList: path.join(stage, "outputs", "manual-review-list.json"),
    output: path.join(stage, "work", "manual-review", "review-result.json"),
    state: path.join(stage, "work", "manual-review", "review-state.json"),
  };
}

test("the portal backend saves and exports a customer review", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-manual-review-"));
  try {
    const paths = collectionPaths(root);
    writeJson(paths.manualList, {
      schema_version: "clue.data-collection.review-list.v1",
      collection_id: "example",
      review_records: [
        {
          record_id: "lead-001",
          deduplication: { duplicate_group_id: "candidate-001" },
          payload: { customer_lead: { company_name: "Example Buyer" } },
        },
      ],
    });
    writeJson(paths.nonReview as string, {
      schema_version: "clue.data-collection.non-review.v1",
      collection_id: "example",
      qualified_without_manual_review: [{ record_id: "lead-automatic" }],
      rejected_records: [{ record_id: "lead-rejected" }],
    });

    const loaded = bootstrapManualReview(paths);
    assert.equal((loaded.summary as Record<string, unknown>).manual_review_pending, 1);

    const saved = saveManualReview(paths, "lead-001", "approved", "Confirmed.");
    assert.equal((saved.review as Record<string, unknown>).status, "approved");

    const exported = exportManualReview(paths);
    const output = readJson(paths.output);
    const state = readJson(paths.state);
    assert.equal(exported.outreach_ready_count, 2);
    assert.equal((output.producer as Record<string, unknown>).name, "polaris-business-portal");
    assert.equal((state.reviews as Record<string, Record<string, unknown>>)["candidate:candidate-001"].status, "approved");
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("the portal backend invalidates an intelligence decision after a revision", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-manual-review-"));
  try {
    const paths = genericPaths(root);
    const document = (revisionHash: string) => ({
      schema_version: "clue.manual-review.v2",
      review_set_id: "analysis:example:snapshot",
      review_kind: "intelligence_finding",
      review_records: [
        {
          record_id: "finding-001",
          review_key: "claim:example",
          revision_hash: revisionHash,
          title: "Example finding",
          summary: "A finding requiring confirmation.",
          evidence: [
            {
              observed_at: "2026-07-25T00:00:00Z",
              source_excerpt: "Example evidence.",
              source_url: "https://example.invalid/evidence",
            },
          ],
        },
      ],
    });
    writeJson(paths.manualList, document("sha256:revision-a"));
    saveManualReview(paths, "finding-001", "approved", "Confirmed.");
    const exported = exportManualReview(paths);
    const output = readJson(paths.output);
    assert.equal(exported.approved_count, 1);
    assert.equal(output.approval_mode, "manual");

    writeJson(paths.manualList, document("sha256:revision-b"));
    const refreshed = bootstrapManualReview(paths);
    assert.equal((refreshed.summary as Record<string, unknown>).pending, 1);
    assert.deepEqual(refreshed.reviews, {});
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
