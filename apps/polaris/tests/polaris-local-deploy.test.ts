import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveDefaultLocalDeployDataRoot,
  resolveLocalDeployConfig,
} from "../scripts/local-deploy/paths.ts";
import { LOCAL_DEPLOY_ACTIONS } from "../scripts/local-deploy/types.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("local deploy actions expose one shared lifecycle model", () => {
  assert.deepEqual(LOCAL_DEPLOY_ACTIONS, [
    "install",
    "start",
    "stop",
    "restart",
    "status",
    "open",
    "logs",
    "doctor",
    "upgrade",
    "uninstall",
    "desktop",
  ]);
});

test("local deploy default data root follows platform conventions", () => {
  assert.match(
    resolveDefaultLocalDeployDataRoot("linux", {}),
    /\.local[\/\\]share[\/\\]polaris$/,
  );
  assert.match(
    resolveDefaultLocalDeployDataRoot("darwin", {}),
    /Library[\/\\]Application Support[\/\\]Polaris$/,
  );
  assert.match(
    resolveDefaultLocalDeployDataRoot("win32", { LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local" }),
    /AppData\\Local[\/\\]Polaris$/,
  );
});

test("local deploy config resolves a dedicated compose bundle", () => {
  const config = resolveLocalDeployConfig(import.meta.url, {
    POLARIS_LOCAL_DEPLOY_PORT: "19081",
  });
  assert.match(config.composeFile, /deploy[\/\\]local-deploy[\/\\]docker-compose\.yml$/);
  assert.equal(config.gatewayPort, 19081);
  assert.equal(config.gatewayUrl, "http://127.0.0.1:19081");
});

test("local deployment docs separate deployment from development", () => {
  const doc = fs.readFileSync(
    path.join(REPO_ROOT, "apps/docs/site/latest/polaris/local-deployment.md"),
    "utf8",
  );
  assert.match(doc, /not the same thing as local development/i);
  assert.match(doc, /polaris start/);
  assert.match(doc, /Polaris` app icon/);
  assert.match(doc, /Debian `polaris_<version>_amd64\.deb`/);
  assert.match(doc, /Windows `polaris_<version>_win_x64\.zip`/);
  assert.match(doc, /PostHog/);
  assert.match(doc, /Sentry/);
  assert.match(doc, /telemetry configuration is baked into the release\s+image at build time/);
  assert.match(doc, /They are not the default stage-one local deployment path\./);
});

test("local deployment compose bundle avoids development servers and host network", () => {
  const compose = fs.readFileSync(
    path.join(REPO_ROOT, "deploy/local-deploy/docker-compose.yml"),
    "utf8",
  );
  assert.doesNotMatch(compose, /network_mode:\s*host/);
  assert.doesNotMatch(compose, /vite|tsx watch/);
  assert.match(compose, /polaris-webportal:/);
  assert.match(compose, /polaris-local-gateway:/);
  assert.match(compose, /image: \$\{POLARIS_LOCAL_DEPLOY_CONTROL_PLANE_IMAGE\}/);
  assert.match(compose, /node apps\/polaris\/dist\/scripts\/polaris\.js server 8787 0\.0\.0\.0/);
});

test("packaging workflow and release bundle artifacts are defined", () => {
  const workflow = fs.readFileSync(
    path.join(REPO_ROOT, ".github/workflows/release.yml"),
    "utf8",
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "deploy/local-deploy/release.json"), "utf8"),
  ) as { images: Record<string, string> };
  assert.match(workflow, /polaris_.*_amd64\.deb/);
  assert.match(workflow, /polaris_.*_win_x64\.zip/);
  assert.match(workflow, /polaris_.*_macos_x64\.zip/);
  assert.equal(manifest.images.controlPlane, "polaris-local/polaris-control-plane:0.2.6");
  assert.equal(manifest.images.webPortal, "polaris-local/polaris-webportal:0.2.6");
  assert.equal(manifest.images.paseoApp, "polaris-local/paseo-app:0.2.6");
});
