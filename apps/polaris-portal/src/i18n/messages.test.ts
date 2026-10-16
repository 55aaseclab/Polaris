import assert from "node:assert/strict";
import test from "node:test";
import { ERROR_MESSAGE_KEYS, interpolate, localizedError, localizedPackWarning, localizedWorkflowError, localizedWorkflowEvent, messages } from "./messages.js";

test("Chinese and English resources have identical keys", () => {
  assert.deepEqual(Object.keys(messages.zh).sort(), Object.keys(messages.en).sort());
});

test("translation resources do not contain empty values", () => {
  for (const language of Object.keys(messages) as Array<keyof typeof messages>) {
    for (const [key, value] of Object.entries(messages[language])) {
      assert.ok(value.trim().length > 0, `${language}.${key} must not be empty`);
    }
  }
});

test("localized errors resolve through the same message resources", () => {
  const error = localizedError("error.signInInvalid");
  assert.equal(error.key, "error.signInInvalid");
  assert.equal(messages.zh[error.key], "登录状态无效，请重新登录");
  assert.equal(messages.en[error.key], "The sign-in state is invalid. Please sign in again.");
});

test("i18n interpolation replaces named values", () => {
  assert.equal(interpolate("Run {count}: {name}", { count: 3, name: "demo" }), "Run 3: demo");
  assert.equal(interpolate("Missing {value}"), "Missing {value}");
});

test("workflow events use stable kinds instead of server language", () => {
  const event = { kind: "succeeded", title: "完成", detail: "服务端原文" };
  const zh = (key: keyof typeof messages.zh) => messages.zh[key];
  const en = (key: keyof typeof messages.en) => messages.en[key];
  assert.deepEqual(localizedWorkflowEvent(event, zh), {
    title: "最终产物已生成",
    detail: "运行完成，最终产物已准备好。",
  });
  assert.deepEqual(localizedWorkflowEvent(event, en), {
    title: "Final artifact ready",
    detail: "The run completed and the final artifact is ready.",
  });
  assert.deepEqual(localizedWorkflowEvent({ ...event, kind: "future-event" }, en), {
    title: "完成",
    detail: "服务端原文",
  });
});

test("known workflow errors use error-code translations", () => {
  const error = { code: "quota-denied", message: "server message" };
  assert.equal(localizedWorkflowError(error, (key) => messages.zh[key]), "已超出运行配额");
  assert.equal(localizedWorkflowError(error, (key) => messages.en[key]), "The run quota has been exceeded");
  assert.equal(localizedWorkflowError({ code: "future-error", message: "server message" }, (key) => messages.en[key]), "server message");
});

test("step-policy verdict codes interpolate their diagnostic values", () => {
  const zh = (key: keyof typeof messages.zh, values?: Record<string, string | number>) => interpolate(messages.zh[key], values);
  const en = (key: keyof typeof messages.en, values?: Record<string, string | number>) => interpolate(messages.en[key], values);
  assert.equal(
    localizedWorkflowError({ code: "step-budget-exceeded", message: "fallback" }, zh, { total: "$0.8", budget: "$0.5" }),
    "步级预算超限：累计成本 $0.8 超过预算 $0.5",
  );
  assert.equal(
    localizedWorkflowError({ code: "step-budget-exceeded", message: "fallback" }, en, { total: "$0.8", budget: "$0.5" }),
    "Step budget exceeded: cumulative cost $0.8 over budget $0.5",
  );
  assert.equal(
    localizedWorkflowError({ code: "step-attempts-exhausted", message: "fallback" }, zh, { count: 3 }),
    "步级尝试耗尽（3）",
  );
  assert.equal(
    localizedWorkflowError({ code: "step-attempt-timeout", message: "fallback" }, en, { timeout: 100 }),
    "Step attempt timed out (100ms)",
  );
  assert.equal(
    localizedWorkflowError({ code: "run-budget-exceeded", message: "fallback" }, zh, { total: "$0.8", budget: "$0.5" }),
    "运行级预算超限：累计成本 $0.8 超过预算 $0.5",
  );
  assert.equal(
    localizedWorkflowError({ code: "run-budget-exceeded", message: "fallback" }, en, { total: "$0.8", budget: "$0.5" }),
    "Run budget exceeded: cumulative cost $0.8 over budget $0.5",
  );
  assert.equal(
    localizedWorkflowError({ code: "run-timeout-exceeded", message: "fallback" }, zh, { elapsed: 400, timeout: 200 }),
    "运行级超时：运行时长 400ms 超过上限 200ms",
  );
  assert.equal(
    localizedWorkflowError({ code: "run-timeout-exceeded", message: "fallback" }, en, { elapsed: 400, timeout: 200 }),
    "Run timeout exceeded: run duration 400ms over the 200ms cap",
  );
});

test("all stable workflow error codes have centralized translations", () => {
  const codes = [
    "approval-not-available",
    "artifact-content-unavailable",
    "artifact-not-found",
    "cancel-not-available",
    "common-tool-failed",
    "delete-not-available",
    "live-adapter-disabled",
    "live-adapter-gates-incomplete",
    "live-mode-required",
    "live-vault-metadata-read-failed",
    "live-vault-metadata-timeout",
    "live-worker-binding-disabled",
    "live-worker-budget-exhausted",
    "operator-required",
    "pack-pin-unavailable",
    "release-id-required",
    "retry-not-available",
    "run-budget-exceeded",
    "run-not-found",
    "run-timeout-exceeded",
    "step-attempt-timeout",
    "step-attempts-exhausted",
    "step-budget-exceeded",
    "suggestion-not-ready",
    "vault-not-found",
    "vault-unavailable",
    "workflow-action-disabled",
    "workflow-action-not-cataloged",
    "workflow-execution-failed",
    "workflow-failed",
    "workflow-graph-not-found",
    "workflow-input-required",
    "workflow-live-worker-action-not-found",
    "workflow-live-worker-preconditions-incomplete",
    "workflow-not-found",
    "workflow-pack-not-found",
    "workflow-setup-incomplete",
    "workflow-worker-error",
  ];
  for (const code of codes) {
    assert.ok(ERROR_MESSAGE_KEYS[code], `${code} must be mapped`);
    assert.notEqual(
      localizedWorkflowError({ code, message: "server fallback" }, (key) => messages.en[key]),
      "server fallback",
      `${code} must not fall through to the server message`,
    );
  }
});

test("pack warnings keep dynamic DSL details while translating the surrounding label", () => {
  const warning = "E_FFI_TOOL: call review references unavailable tool example.tool";
  assert.equal(
    localizedPackWarning(warning, (key, values) => interpolate(messages.en[key], values)),
    "References a public tool that is not installed: call review references unavailable tool example.tool",
  );
});
