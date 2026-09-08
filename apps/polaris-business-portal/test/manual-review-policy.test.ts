import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertManualReviewActionIsSurfaceOnly,
  exportManualReview,
  WanghaiManualReviewPolicyError,
} from "../lib/manual-review.js";

function writeJson(filePath: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("integrated Wanghai rejects analysis completion before it writes review state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-manual-review-policy-"));
  const assetPath = "intelligence-analysis/example/outputs/manual-review-list.json";
  const stageRoot = path.join(root, "intelligence-analysis", "example");
  const statePath = path.join(stageRoot, "work", "manual-review", "review-state.json");
  const resultPath = path.join(stageRoot, "work", "manual-review", "review-result.json");
  try {
    writeJson(path.join(root, assetPath), {
      schema_version: "clue.manual-review.v2",
      review_kind: "intelligence_finding",
      review_records: [],
      review_set_id: "analysis:example:snapshot",
    });

    const previousMode = process.env.WANGHAI_RUNTIME_MODE;
    process.env.WANGHAI_RUNTIME_MODE = "polaris";
    try {
      assert.throws(
        () => exportManualReview(root, assetPath, true),
        (error: unknown) => error instanceof WanghaiManualReviewPolicyError
          && error.statusCode === 503,
      );
    } finally {
      if (previousMode === undefined) delete process.env.WANGHAI_RUNTIME_MODE;
      else process.env.WANGHAI_RUNTIME_MODE = previousMode;
    }

    assert.equal(fs.existsSync(statePath), false);
    assert.equal(fs.existsSync(resultPath), false);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("review-state export remains a surface action", () => {
  const integratedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    WANGHAI_RUNTIME_MODE: "polaris",
  };
  assert.doesNotThrow(() => assertManualReviewActionIsSurfaceOnly(false, integratedEnv));
  assert.doesNotThrow(() => assertManualReviewActionIsSurfaceOnly(true, {
    ...integratedEnv,
    WANGHAI_RUNTIME_MODE: "standalone",
  }));
});

test("Polaris business runtime blocks analysis completion", () => {
  assert.throws(
    () => assertManualReviewActionIsSurfaceOnly(true, {
      ...process.env,
      POLARIS_BUSINESS_RUNTIME_MODE: "polaris",
    }),
    WanghaiManualReviewPolicyError,
  );
});
