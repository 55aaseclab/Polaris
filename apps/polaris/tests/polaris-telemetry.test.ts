import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { telemetryEnabled, telemetryRoot } from "../scripts/telemetry/client.ts";
import { resolvePolarisAppVersion } from "../scripts/telemetry/version.ts";
import {
  buildBrowserTelemetryCommonProperties,
  resolveBrowserTelemetryEnabled,
} from "../../polaris-web/src/lib/telemetry.ts";
import fs from "node:fs";
import { resolveCurrentReleaseVersion } from "../../../scripts/release-version.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("node telemetry is disabled without PostHog or Sentry config", () => {
  assert.equal(telemetryEnabled({}), false);
  assert.equal(
    telemetryEnabled({
      POLARIS_TELEMETRY_ENABLED: "false",
      POLARIS_POSTHOG_API_KEY: "phc_xxx",
    }),
    false,
  );
});

test("node telemetry is enabled when PostHog or Sentry is configured", () => {
  assert.equal(
    telemetryEnabled({
      POLARIS_POSTHOG_API_KEY: "phc_xxx",
    }),
    true,
  );
  assert.equal(
    telemetryEnabled({
      POLARIS_SENTRY_DSN: "https://example.ingest.sentry.io/1",
    }),
    true,
  );
});

test("node telemetry root prefers local deploy data root when provided", () => {
  const root = telemetryRoot({
    POLARIS_LOCAL_DEPLOY_DATA_ROOT: "/tmp/polaris-local",
  });
  assert.equal(root, "/tmp/polaris-local");
});

test("polaris app version resolves from the frozen docs version source", () => {
  const version = resolvePolarisAppVersion(new URL("../scripts/telemetry/version.ts", import.meta.url).toString());
  assert.equal(version, "0.2.7");
});

test("browser telemetry enablement honors Vite config", () => {
  assert.equal(resolveBrowserTelemetryEnabled({}), false);
  assert.equal(
    resolveBrowserTelemetryEnabled({
      VITE_POLARIS_POSTHOG_KEY: "phc_xxx",
    }),
    true,
  );
  assert.equal(
    resolveBrowserTelemetryEnabled({
      VITE_POLARIS_TELEMETRY_ENABLED: "off",
      VITE_POLARIS_SENTRY_DSN: "https://example.ingest.sentry.io/1",
    }),
    false,
  );
});

test("browser telemetry common properties include release metadata", () => {
  const properties = buildBrowserTelemetryCommonProperties({
    installId: "install-1",
    sessionId: "session-1",
    locale: "zh-CN",
    platform: "MacIntel",
    sourceEnv: {
      VITE_POLARIS_APP_VERSION: "0.2.7",
      VITE_POLARIS_RELEASE_CHANNEL: "stable",
    },
  });
  assert.deepEqual(properties, {
    install_id: "install-1",
    session_id: "session-1",
    app_version: "0.2.7",
    release_channel: "stable",
    platform: "MacIntel",
    arch: "browser",
    entry_surface: "web",
    locale: "zh-CN",
    telemetry_schema_version: "1",
  });
});

test("release script no longer defaults to a synthetic placeholder version", () => {
  const script = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/build-release.mjs"),
    "utf8",
  );
  assert.doesNotMatch(script, /0\.0\.0-dev/);
  assert.match(script, /resolveCurrentReleaseVersion/);
});

test("release version resolver follows the current release snapshot", () => {
  assert.equal(resolveCurrentReleaseVersion(REPO_ROOT), "0.2.7");
});
