import assert from "node:assert/strict";
import test from "node:test";
import { allowsLocalSmtpSettings } from "../lib/settings-runtime-policy.js";

test("settings catalog hides local SMTP configuration in Polaris mode", () => {
  const baseEnv: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    SMTP_HOST: "smtp.example.test",
    SMTP_PASSWORD: "synthetic-password",
    SMTP_PORT: "587",
    SMTP_USER: "synthetic-user",
    OUTREACH_FROM_EMAIL: "operator@example.test",
  };
  assert.equal(allowsLocalSmtpSettings({ ...baseEnv, WANGHAI_RUNTIME_MODE: "polaris" }), false);
  assert.equal(allowsLocalSmtpSettings({ ...baseEnv, WANGHAI_RUNTIME_MODE: "standalone" }), true);
  assert.equal(allowsLocalSmtpSettings({ ...baseEnv, POLARIS_BUSINESS_RUNTIME_MODE: "polaris" }), false);
  assert.equal(allowsLocalSmtpSettings({ ...baseEnv, POLARIS_BUSINESS_RUNTIME_MODE: "standalone" }), true);
});
