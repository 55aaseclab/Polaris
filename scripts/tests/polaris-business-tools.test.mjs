import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(".");
const INVENTORY_PATH = path.join(ROOT, "tools", "business-tool-inventory.json");

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    ...options,
  });
}

test("business inventory is Polaris-owned and points to present entrypoints", () => {
  const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf8"));
  assert.equal(inventory.schema_version, "polaris.business-tool-inventory.v1");
  assert.equal(inventory.owner, "polaris");
  assert.equal(inventory.integrated_execution, "polaris-durable-action-required");
  assert.equal(inventory.direct_wanghai_dependency, false);
  assert.equal(inventory.tools.length, 7);

  for (const tool of inventory.tools) {
    const entrypoint = path.join(ROOT, tool.entrypoint);
    assert.ok(fs.existsSync(entrypoint), `${tool.id}: missing ${tool.entrypoint}`);
    if (tool.kind === "executable") {
      assert.equal(fs.statSync(entrypoint).isFile(), true, `${tool.id}: not a file`);
      assert.equal(fs.accessSync(entrypoint, fs.constants.X_OK), undefined);
    }
  }
});

test("business Dockerfile installs and carries the shared business package", () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, "apps/polaris/Dockerfile"), "utf8");
  assert.match(dockerfile, /packages\/polaris-business-core\/package\.json/);
  assert.match(dockerfile, /COPY packages\/polaris-business-core \.\/packages\/polaris-business-core/);
  assert.match(dockerfile, /COPY --from=build \/vault\/packages\/polaris-business-core \.\/packages\/polaris-business-core/);
  assert.match(dockerfile, /--filter @polaris\/business-core\.\.\./);
  assert.match(dockerfile, /--filter @polaris\/content-production\.\.\./);
  assert.match(dockerfile, /--filter @polaris\/product-video\.\.\./);
});

test("business shell entrypoints pass syntax checks", () => {
  const wrappers = [
    "tools/business-load-env.sh",
    "tools/google-map/clue-gogole-map-cli",
    "tools/industry-directories/clue-industry-directory-cli",
    "tools/outreach/clue-outreach",
    "tools/social-publish/clue-social-publish",
    "tools/content-production/polaris-content-production",
    "tools/product-video/polaris-product-video",
  ];
  for (const wrapper of wrappers) {
    const result = run("bash", ["-n", wrapper]);
    assert.equal(result.status, 0, `${wrapper}: ${result.stderr}`);
  }
});

test("read-only business version commands work without migrated backends", () => {
  const commands = [
    ["tools/google-map/clue-gogole-map-cli", ["version"]],
    ["tools/industry-directories/clue-industry-directory-cli", ["version"]],
    ["tools/outreach/clue-outreach", ["version"]],
    ["tools/social-publish/clue-social-publish", ["version"]],
    ["tools/content-production/polaris-content-production", ["version"]],
    ["tools/product-video/polaris-product-video", ["version"]],
  ];
  for (const [command, args] of commands) {
    const result = run(command, args);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  }
});

test("integrated business wrappers reject direct mutations", () => {
  const environment = {
    ...process.env,
    POLARIS_BUSINESS_RUNTIME_MODE: "polaris",
  };
  const cases = [
    ["tools/google-map/clue-gogole-map-cli", ["run", "--dry-run", "--query", "synthetic"]],
    ["tools/industry-directories/clue-industry-directory-cli", ["batch", "--input", "synthetic.json", "--output", "synthetic-run"]],
    ["tools/outreach/clue-outreach", ["draft", "--workspace", "synthetic", "--lead-id", "lead"]],
    ["tools/social-publish/clue-social-publish", ["publish", "--input", "tools/social-publish/examples/publish-note.example.json"]],
    ["tools/content-production/polaris-content-production", ["run", "--workspace-root", ".", "--input", "synthetic.json"]],
    ["tools/product-video/polaris-product-video", ["run", "--workspace-root", ".", "--input", "synthetic.json"]],
  ];
  for (const [command, args] of cases) {
    const result = run(command, args, { env: environment });
    assert.notEqual(result.status, 0, `${command} unexpectedly ran in integrated mode`);
    assert.match(`${result.stdout}\n${result.stderr}`, /integrated .*requires|durable action service/u);
  }
});
