import assert from "node:assert/strict";
import test from "node:test";
import { ClhError } from "../src/errors.js";
import { validatePreset } from "../src/schema.js";

function expectCode(fn: () => unknown, code: string): ClhError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ClhError, `expected ClhError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected ClhError ${code}, but the call succeeded`);
}

const validBase = {
  kind: "bounded",
  model: "strong",
  toolBoundary: "read-only",
  loopCap: 5,
  outputContract: "precise-json",
  permission: "read-only",
};

test("schema accepts valid presets for all three kinds", () => {
  const bounded = validatePreset({ ...validBase });
  assert.equal(bounded.preset.kind, "bounded");
  assert.equal(bounded.warnings.length, 0);

  const api = validatePreset({
    kind: "api",
    model: "light",
    toolBoundary: "none",
    loopCap: 1,
    outputContract: "artifact",
    permission: "read-only",
  });
  assert.equal(api.preset.kind, "api");
  assert.equal(api.warnings.length, 0);

  const open = validatePreset({
    kind: "open",
    model: "strong",
    toolBoundary: "full",
    loopCap: 60,
    outputContract: "artifact",
    permission: "workspace-write",
  });
  assert.equal(open.preset.kind, "open");

  const withPrompts = validatePreset({
    ...validBase,
    id: "synthetic-review",
    prompts: { system: "templates/system.j2", user: "templates/user.j2" },
  });
  assert.equal(withPrompts.preset.prompts?.user, "templates/user.j2");
});

test("schema rejects unknown and missing fields with stable codes", () => {
  expectCode(
    () => validatePreset({ ...validBase, surprises: true }),
    "CLH_PRESET_UNKNOWN_FIELD",
  );
  expectCode(
    () => validatePreset({ ...validBase, prompts: { user: "a.j2", extra: 1 } }),
    "CLH_PRESET_UNKNOWN_FIELD",
  );
  const missing = { ...validBase } as Record<string, unknown>;
  delete missing["loopCap"];
  expectCode(() => validatePreset(missing), "CLH_PRESET_MISSING_FIELD");
  expectCode(
    () => validatePreset({ ...validBase, prompts: {} }),
    "CLH_PRESET_MISSING_FIELD",
  );
});

test("schema rejects non-conforming values with stable codes", () => {
  expectCode(() => validatePreset({ ...validBase, kind: "wild" }), "CLH_PRESET_INVALID");
  expectCode(() => validatePreset({ ...validBase, model: "gpt-5" }), "CLH_PRESET_INVALID");
  expectCode(() => validatePreset({ ...validBase, toolBoundary: "full" }), "CLH_PRESET_KIND_CONFLICT");
  expectCode(() => validatePreset({ ...validBase, loopCap: 0 }), "CLH_PRESET_INVALID");
  expectCode(() => validatePreset({ ...validBase, loopCap: 1.5 }), "CLH_PRESET_INVALID");
  expectCode(() => validatePreset(null), "CLH_PRESET_INVALID");
  expectCode(() => validatePreset([validBase]), "CLH_PRESET_INVALID");
});

test("kind consistency matrix enforces PRD 3.14.3", () => {
  expectCode(
    () =>
      validatePreset({
        kind: "api",
        model: "light",
        toolBoundary: "read-only",
        loopCap: 1,
        outputContract: "artifact",
        permission: "read-only",
      }),
    "CLH_PRESET_KIND_CONFLICT",
  );
  expectCode(
    () =>
      validatePreset({
        kind: "api",
        model: "light",
        toolBoundary: "none",
        loopCap: 1,
        outputContract: "artifact",
        permission: "workspace-write",
      }),
    "CLH_PRESET_KIND_CONFLICT",
  );
  expectCode(
    () =>
      validatePreset({
        kind: "bounded",
        model: "light",
        toolBoundary: "full",
        loopCap: 1,
        outputContract: "artifact",
        permission: "read-only",
      }),
    "CLH_PRESET_KIND_CONFLICT",
  );
  expectCode(
    () =>
      validatePreset({
        kind: "bounded",
        model: "light",
        toolBoundary: "read-only",
        loopCap: 1,
        outputContract: "artifact",
        permission: "workspace-write",
      }),
    "CLH_PRESET_KIND_CONFLICT",
  );
  expectCode(
    () =>
      validatePreset({
        kind: "open",
        model: "light",
        toolBoundary: "full",
        loopCap: 1,
        outputContract: "artifact",
        permission: "read-only",
      }),
    "CLH_PRESET_KIND_CONFLICT",
  );
  expectCode(
    () =>
      validatePreset({
        kind: "open",
        model: "light",
        toolBoundary: "none",
        loopCap: 1,
        outputContract: "artifact",
        permission: "workspace-write",
      }),
    "CLH_PRESET_KIND_CONFLICT",
  );
});

test("api kind warns that loopCap is ignored", () => {
  const result = validatePreset({
    kind: "api",
    model: "light",
    toolBoundary: "none",
    loopCap: 7,
    outputContract: "precise-json",
    permission: "read-only",
  });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /loopCap is ignored/u);
});

test("schema accepts an optional positive-integer timeoutMs", () => {
  const without = validatePreset({ ...validBase });
  assert.equal(without.preset.timeoutMs, undefined);
  const withTimeout = validatePreset({ ...validBase, timeoutMs: 600000 });
  assert.equal(withTimeout.preset.timeoutMs, 600000);
  assert.equal(withTimeout.warnings.length, 0);
});

test("schema rejects illegal timeoutMs values with a stable code", () => {
  for (const value of [0, -5, 1.5, "600000", null, true]) {
    const error = expectCode(
      () => validatePreset({ ...validBase, timeoutMs: value }),
      "CLH_PRESET_INVALID",
    );
    assert.equal(error.details["field"], "timeoutMs");
  }
});
