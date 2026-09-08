import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOutreachActionIsSurfaceOnly,
  runOutreachAction,
  WanghaiOutreachPolicyError,
} from "../lib/outreach.js";

test("integrated Wanghai rejects live outreach before invoking the tool", () => {
  const liveSend = {
    action: "send" as const,
    engagement_id: "synthetic-engagement",
    live: true,
  };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WANGHAI_RUNTIME_MODE: "polaris",
  };

  assert.throws(
    () => assertOutreachActionIsSurfaceOnly(liveSend, env),
    (error: unknown) => error instanceof WanghaiOutreachPolicyError
      && error.statusCode === 503,
  );

  const previousMode = process.env.WANGHAI_RUNTIME_MODE;
  process.env.WANGHAI_RUNTIME_MODE = "polaris";
  try {
    assert.throws(
      () => runOutreachAction("synthetic-workspace", liveSend, "synthetic-actor"),
      WanghaiOutreachPolicyError,
    );
  } finally {
    if (previousMode === undefined) delete process.env.WANGHAI_RUNTIME_MODE;
    else process.env.WANGHAI_RUNTIME_MODE = previousMode;
  }
});

test("dry-run outreach remains a Wanghai surface action", () => {
  assert.doesNotThrow(() => {
    assertOutreachActionIsSurfaceOnly(
      { action: "send", engagement_id: "synthetic-engagement" },
      { ...process.env, WANGHAI_RUNTIME_MODE: "polaris" },
    );
  });
});

test("Polaris business runtime also blocks live outreach", () => {
  assert.throws(
    () => assertOutreachActionIsSurfaceOnly(
      { action: "send", engagement_id: "synthetic-engagement", live: true },
      { ...process.env, POLARIS_BUSINESS_RUNTIME_MODE: "polaris" },
    ),
    WanghaiOutreachPolicyError,
  );
});
