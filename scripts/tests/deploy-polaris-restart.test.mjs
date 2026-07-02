import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function runHelperScript(rootDir, envFile, script) {
  return execFileSync(
    "bash",
    [
      "-lc",
      `
        set -euo pipefail
        source "${path.resolve("scripts/lib/polaris-deploy-restart.sh")}"
        root_dir=${JSON.stringify(rootDir)}
        env_file=${JSON.stringify(envFile)}
        ${script}
      `,
    ],
    { encoding: "utf8" },
  ).trim();
}

test("deploy restart fingerprints only restart changed executor or bridge services", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-deploy-restart-"));
  const envFile = path.join(rootDir, "polaris.env");
  try {
    fs.mkdirSync(path.join(rootDir, "apps/polaris/dist"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "apps/polaris"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "apps/polaris/dist/server.js"), "console.log('executor');\n");
    fs.writeFileSync(path.join(rootDir, "apps/polaris/package.json"), "{\"name\":\"polaris\"}\n");
    fs.writeFileSync(path.join(rootDir, "package.json"), "{\"name\":\"root\"}\n");
    fs.writeFileSync(path.join(rootDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    fs.writeFileSync(path.join(rootDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    fs.writeFileSync(path.join(rootDir, "scripts/run-polaris-executor-host.sh"), "#!/usr/bin/env bash\n");
    fs.writeFileSync(path.join(rootDir, "scripts/run-polaris-executor-bridge-proxy.sh"), "#!/usr/bin/env bash\n");
    fs.writeFileSync(envFile, "POLARIS_EXECUTOR_SHARED_SECRET=test\n");

    const first = runHelperScript(
      rootDir,
      envFile,
      `
        executor="$(polaris_deploy_executor_fingerprint "$root_dir" "$env_file")"
        bridge="$(polaris_deploy_bridge_fingerprint "$root_dir")"
        printf '%s\\n%s\\n%s\\n%s' \
          "$(polaris_deploy_service_changed "$root_dir" polaris-executor "$executor" && echo changed || echo same)" \
          "$(polaris_deploy_service_changed "$root_dir" polaris-executor-bridge-proxy "$bridge" && echo changed || echo same)" \
          "$executor" \
          "$bridge"
      `,
    ).split("\n");
    assert.equal(first[0], "changed");
    assert.equal(first[1], "changed");

    runHelperScript(
      rootDir,
      envFile,
      `
        polaris_deploy_record_fingerprint "$root_dir" polaris-executor "$(polaris_deploy_executor_fingerprint "$root_dir" "$env_file")"
        polaris_deploy_record_fingerprint "$root_dir" polaris-executor-bridge-proxy "$(polaris_deploy_bridge_fingerprint "$root_dir")"
      `,
    );

    const second = runHelperScript(
      rootDir,
      envFile,
      `
        executor="$(polaris_deploy_executor_fingerprint "$root_dir" "$env_file")"
        bridge="$(polaris_deploy_bridge_fingerprint "$root_dir")"
        printf '%s\\n%s' \
          "$(polaris_deploy_service_changed "$root_dir" polaris-executor "$executor" && echo changed || echo same)" \
          "$(polaris_deploy_service_changed "$root_dir" polaris-executor-bridge-proxy "$bridge" && echo changed || echo same)"
      `,
    ).split("\n");
    assert.equal(second[0], "same");
    assert.equal(second[1], "same");

    fs.writeFileSync(path.join(rootDir, "apps/polaris/dist/server.js"), "console.log('executor changed');\n");
    const executorChanged = runHelperScript(
      rootDir,
      envFile,
      `
        executor="$(polaris_deploy_executor_fingerprint "$root_dir" "$env_file")"
        bridge="$(polaris_deploy_bridge_fingerprint "$root_dir")"
        printf '%s\\n%s' \
          "$(polaris_deploy_service_changed "$root_dir" polaris-executor "$executor" && echo changed || echo same)" \
          "$(polaris_deploy_service_changed "$root_dir" polaris-executor-bridge-proxy "$bridge" && echo changed || echo same)"
      `,
    ).split("\n");
    assert.equal(executorChanged[0], "changed");
    assert.equal(executorChanged[1], "same");

    runHelperScript(
      rootDir,
      envFile,
      `
        polaris_deploy_record_fingerprint "$root_dir" polaris-executor "$(polaris_deploy_executor_fingerprint "$root_dir" "$env_file")"
      `,
    );
    fs.writeFileSync(path.join(rootDir, "scripts/run-polaris-executor-bridge-proxy.sh"), "#!/usr/bin/env bash\necho bridge\n");
    const bridgeChanged = runHelperScript(
      rootDir,
      envFile,
      `
        executor="$(polaris_deploy_executor_fingerprint "$root_dir" "$env_file")"
        bridge="$(polaris_deploy_bridge_fingerprint "$root_dir")"
        printf '%s\\n%s' \
          "$(polaris_deploy_service_changed "$root_dir" polaris-executor "$executor" && echo changed || echo same)" \
          "$(polaris_deploy_service_changed "$root_dir" polaris-executor-bridge-proxy "$bridge" && echo changed || echo same)"
      `,
    ).split("\n");
    assert.equal(bridgeChanged[0], "same");
    assert.equal(bridgeChanged[1], "changed");

    runHelperScript(
      rootDir,
      envFile,
      `
        polaris_deploy_record_fingerprint "$root_dir" polaris-executor-bridge-proxy "$(polaris_deploy_bridge_fingerprint "$root_dir")"
      `,
    );
    fs.writeFileSync(envFile, "POLARIS_EXECUTOR_SHARED_SECRET=changed\n");
    const envChanged = runHelperScript(
      rootDir,
      envFile,
      `
        executor="$(polaris_deploy_executor_fingerprint "$root_dir" "$env_file")"
        bridge="$(polaris_deploy_bridge_fingerprint "$root_dir")"
        printf '%s\\n%s' \
          "$(polaris_deploy_service_changed "$root_dir" polaris-executor "$executor" && echo changed || echo same)" \
          "$(polaris_deploy_service_changed "$root_dir" polaris-executor-bridge-proxy "$bridge" && echo changed || echo same)"
      `,
    ).split("\n");
    assert.equal(envChanged[0], "changed");
    assert.equal(envChanged[1], "same");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
