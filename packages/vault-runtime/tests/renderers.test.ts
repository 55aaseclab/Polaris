import test from "node:test";
import assert from "node:assert/strict";
import { renderDockerVault } from "../src/docker/render.js";
import { renderKubevirtVault } from "../src/kubevirt/render.js";
import { renderPodVault } from "../src/pod/render.js";
import { vaultRuntimeResourceName, vaultRuntimeScopeName } from "../src/core/vault-name.js";
import {
  createKubevirtTemplateDirectory,
  createPrivateSurface,
  createRuntimeSpec,
} from "./fixtures.js";

async function withKubevirtTemplates<T>(fn: (directory: string) => T | Promise<T>): Promise<T> {
  const fixture = createKubevirtTemplateDirectory();
  try {
    return await fn(fixture.directory);
  } finally {
    fixture.cleanup();
  }
}

async function withTemplates<T>(spec: ReturnType<typeof createRuntimeSpec>, fn: () => T | Promise<T>): Promise<T> {
  return withKubevirtTemplates((directory) => {
    spec.integration.kubevirtTemplates = { fallbackDir: directory };
    return fn();
  });
}

test("Docker and Pod renderers preserve isolated scope and attachment roots", () => {
  const docker = renderDockerVault(createRuntimeSpec({ backendKind: "docker" }));
  const podSpec = createRuntimeSpec({ backendKind: "pod" });
  podSpec.attachments.vaultData.source = {
    kind: "netfs",
    server: "netfs.example.test",
    exportPath: "/exports/vault-data",
    subPath: "tenant-a/synthetic-vault",
  };
  const pod = renderPodVault(podSpec);
  const scope = vaultRuntimeScopeName("tenant-a", "synthetic-vault");

  assert.match(docker, new RegExp(`${scope}-docker`));
  assert.match(docker, /\/vault\/workspaces/);
  assert.match(docker, /synthetic-vault-data/);
  assert.match(pod, new RegExp(`runtimeClassName: gvisor`));
  assert.match(pod, new RegExp(`name: ${scope}`));
  assert.match(pod, /server: netfs\.example\.test/);
  assert.match(pod, /path: \/exports\/vault-data\/tenant-a\/synthetic-vault/);
  assert.match(pod, /\/identity/);
});

test("agent bootstrap prepares Paseo pairing before starting the daemon", () => {
  const dockerSpec = createRuntimeSpec({ backendKind: "docker" });
  dockerSpec.agent.enabled = true;
  dockerSpec.agent.managerId = "paseo";
  dockerSpec.agent.capabilities.requiresDaemon = true;

  const podSpec = createRuntimeSpec({ backendKind: "pod" });
  podSpec.agent.enabled = true;
  podSpec.agent.managerId = "paseo";
  podSpec.agent.capabilities.requiresDaemon = true;

  for (const rendered of [renderDockerVault(dockerSpec), renderPodVault(podSpec)]) {
    const pairingCall = rendered.indexOf("paseo_sync_pairing || true");
    const daemonStart = rendered.indexOf(
      "PASEO_HOME=/root/.paseo paseo daemon start --listen 0.0.0.0:6767",
    );

    assert.ok(pairingCall >= 0, "bootstrap must prepare a pairing file");
    assert.ok(daemonStart >= 0, "bootstrap must start the daemon");
    assert.ok(
      pairingCall < daemonStart,
      "pairing generation must happen before the daemon can capture the RPC hang",
    );
    assert.match(rendered, /timeout 30s env PASEO_HOME=\/root\/\.paseo paseo daemon pair --json/);
    assert.match(
      rendered,
      /pairing\.json.*grep -q '\"url\"\[\[:space:\]\]\*:' .*return 0/,
    );
  }
});

test("KubeVirt renderer is testable with package-owned template fixtures", async () => {
  const spec = createRuntimeSpec({ backendKind: "kubevirt-vm" });
  const rendered = await withTemplates(spec, () => renderKubevirtVault(spec));
  const scope = vaultRuntimeScopeName("tenant-a", "synthetic-vault");

  assert.match(rendered, new RegExp(`name: ${scope}-vm`));
  assert.match(rendered, /synthetic-runtime-state/);
  assert.match(rendered, /synthetic-probe-password/);
  assert.doesNotMatch(rendered, /__[A-Z0-9_]+__/);
});

test("private surfaces remain separate from public service ports on every backend", async () => {
  const surface = createPrivateSurface();
  const docker = renderDockerVault(createRuntimeSpec({
    backendKind: "docker",
    privateSurface: surface,
  }));
  const pod = renderPodVault(createRuntimeSpec({
    backendKind: "pod",
    privateSurface: surface,
  }));
  const kubevirtSpec = createRuntimeSpec({
    backendKind: "kubevirt-vm",
    privateSurface: surface,
  });
  const kubevirt = await withTemplates(kubevirtSpec, () => renderKubevirtVault(kubevirtSpec));
  const surfaceName = vaultRuntimeResourceName("tenant-a", "synthetic-vault", "surface");

  for (const rendered of [docker, pod, kubevirt]) {
    assert.match(rendered, /SURFACE_MODE/);
    assert.match(rendered, /surface/);
    assert.match(rendered, /9090/);
  }
  assert.match(pod, /surface-private/);
  assert.match(kubevirt, new RegExp(surfaceName));
  assert.match(kubevirt, /assertion-secret/);
});
