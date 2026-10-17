import assert from "node:assert/strict";
import test from "node:test";
import { ClhError } from "../src/errors.js";
import { renderJ2 } from "../src/j2.js";

test("j2 renders interpolation and nested if blocks", () => {
  const template = [
    "{% if A %}",
    "a-branch {{X}}",
    "{% if B %}b-branch{% endif %}",
    "{% else %}",
    "else-branch",
    "{% endif %}",
    "tail {{Y}}",
  ].join("\n");
  assert.equal(renderJ2(template, { A: "yes", B: "yes", X: "x", Y: "y" }), "\na-branch x\nb-branch\n\ntail y");
  assert.equal(renderJ2(template, { A: "yes", X: "x", Y: "y" }), "\na-branch x\n\n\ntail y");
  assert.equal(renderJ2(template, { X: "x", Y: "y" }), "\nelse-branch\n\ntail y");
});

test("j2 matches the CVE-Genie nested else shape", () => {
  const template = [
    "{% if ERROR %}",
    "error: {{ERROR}}",
    "{% else %}",
    "normal {{LOGS}}",
    "{% if FEEDBACK %}feedback {{FEEDBACK}}{% endif %}",
    "{% endif %}",
  ].join("\n");
  const withError = renderJ2(template, { ERROR: "boom", LOGS: "l", FEEDBACK: "f" });
  assert.match(withError, /^error: boom$/mu);
  assert.doesNotMatch(withError, /feedback/u);
  const withoutError = renderJ2(template, { LOGS: "l", FEEDBACK: "f" });
  assert.match(withoutError, /normal l\nfeedback f/u);
  const noFeedback = renderJ2(template, { LOGS: "l" });
  assert.match(noFeedback, /normal l$/mu);
});

test("j2 fails closed on undefined variables", () => {
  assert.throws(
    () => renderJ2("{{MISSING}}", {}),
    (error: unknown) => error instanceof ClhError && error.code === "CLH_PRESET_INVALID",
  );
});

test("j2 rejects unbalanced tags", () => {
  assert.throws(
    () => renderJ2("{% if A %}x", { A: "yes" }),
    (error: unknown) => error instanceof ClhError && error.code === "CLH_PRESET_INVALID",
  );
  assert.throws(
    () => renderJ2("{% endif %}"),
    (error: unknown) => error instanceof ClhError && error.code === "CLH_PRESET_INVALID",
  );
  assert.throws(
    () => renderJ2("{% else %}x{% endif %}"),
    (error: unknown) => error instanceof ClhError && error.code === "CLH_PRESET_INVALID",
  );
  assert.throws(
    () => renderJ2("{% if A %}x{% else %}y", { A: "yes" }),
    (error: unknown) => error instanceof ClhError && error.code === "CLH_PRESET_INVALID",
  );
});
