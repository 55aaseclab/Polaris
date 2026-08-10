import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { DockerDriver } from "../src/docker/driver.js";
import { KubevirtDriver } from "../src/kubevirt/driver.js";
import { PodDriver } from "../src/pod/driver.js";
import type { RuntimeDriverDependencies } from "../src/types.js";
import {
  createKubevirtTemplateDirectory,
  createRuntimeSpec,
} from "./fixtures.js";

const TEST_MANIFEST_PATH = path.join(os.tmpdir(), "vault-runtime-test-manifest.yaml");

function fakeDependencies() {
  const commands: string[][] = [];
  const manifests: string[] = [];
  const dependencies: RuntimeDriverDependencies = {
    writeManifest: (_spec, yamlText) => {
      manifests.push(yamlText);
      return TEST_MANIFEST_PATH;
    },
    runCommand: (command, args) => {
      commands.push([command, ...args]);
    },
    logInfo: () => undefined,
    withDockerCapacity: async (_spec, operation) => operation(),
  };
  return { commands, manifests, dependencies };
}

function hasCommand(commands: string[][], expected: string[]): boolean {
  return commands.some((command) =>
    command.length === expected.length && command.every((part, index) => part === expected[index]));
}

test("Pod driver lifecycle and reconcile actions use the runtime dependency boundary", async () => {
  const { commands, manifests, dependencies } = fakeDependencies();
  const spec = createRuntimeSpec({ backendKind: "pod" });
  const driver = new PodDriver(dependencies);

  await driver.create(spec);
  await driver.start(spec);
  await driver.stop(spec);
  await driver.restart(spec);
  await driver.rebuild(spec);
  await driver.render(spec);
  await driver.apply(spec);
  await driver.executeReconcilePlan(spec, {
    project: spec.identity.projectName,
    backend: spec.backend.kind,
    safe: true,
    requiresRestart: true,
    destructive: false,
    actions: [
      { kind: "restart-runtime" },
      { kind: "repair-runtime-assembly" },
    ],
  });

  assert.equal(manifests.length, 5);
  assert.ok(hasCommand(commands, ["kubectl", "apply", "-f", TEST_MANIFEST_PATH]));
  assert.ok(hasCommand(commands, ["kubectl", "-n", "tenant-a-synthetic-vault", "scale", "deployment", "tenant-a-synthetic-vault", "--replicas=0"]));
  assert.ok(hasCommand(commands, ["kubectl", "-n", "tenant-a-synthetic-vault", "rollout", "restart", "deployment", "tenant-a-synthetic-vault"]));
});

test("Docker driver keeps manifest rendering and capacity behind injected dependencies", async () => {
  const { commands, manifests, dependencies } = fakeDependencies();
  const spec = createRuntimeSpec({ backendKind: "docker" });
  const driver = new DockerDriver(dependencies);

  await driver.create(spec);
  await driver.render(spec);
  await driver.executeReconcilePlan(spec, {
    project: spec.identity.projectName,
    backend: spec.backend.kind,
    safe: true,
    requiresRestart: true,
    destructive: false,
    actions: [{ kind: "restart-runtime" }],
  });

  assert.equal(manifests.length, 3);
  assert.ok(hasCommand(commands, [
    "docker",
    "compose",
    "-f",
    TEST_MANIFEST_PATH,
    "restart",
  ]));
});

test("KubeVirt driver renders and applies through injected dependencies", async () => {
  const { commands, manifests, dependencies } = fakeDependencies();
  const spec = createRuntimeSpec({ backendKind: "kubevirt-vm" });
  const driver = new KubevirtDriver(dependencies);

  const fixture = createKubevirtTemplateDirectory();
  try {
    spec.integration.kubevirtTemplates = { fallbackDir: fixture.directory };
    await driver.create(spec);
    await driver.render(spec);
    await driver.executeReconcilePlan(spec, {
      project: spec.identity.projectName,
      backend: spec.backend.kind,
      safe: true,
      requiresRestart: false,
      destructive: false,
      actions: [{ kind: "apply" }],
    });
  } finally {
    fixture.cleanup();
  }

  assert.equal(manifests.length, 3);
  assert.ok(hasCommand(commands, ["kubectl", "apply", "-f", TEST_MANIFEST_PATH]));
});
