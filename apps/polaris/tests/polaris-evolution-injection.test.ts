import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { loadWorkspace } from "../scripts/config/load.js";
import { EvolutionStore } from "../scripts/evolution/store.js";
import { prepareEvolutionBootstrapContext, controlPlaneEvolutionDbPath } from "../scripts/evolution/runtime.js";
import { renderDockerWorkspace } from "../scripts/backends/docker/render.js";
import { renderPodWorkspace } from "../scripts/backends/pod/render.js";

test("prepareEvolutionBootstrapContext writes a control-plane snapshot and injects runtime paths", async () => {
  const workspace = loadWorkspace("demo@docker");
  const dbPath = controlPlaneEvolutionDbPath(workspace);
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const store = await EvolutionStore.open(dbPath);
    store.upsertArtifact({
      id: "artifact-1",
      workspaceId: workspace.identity.projectName,
      userProfileId: workspace.userProfile.id,
      kind: "workspace-playbook",
      scope: "workspace",
      title: "Verification workflow",
      content: "Run verification before retrying a failed loop.",
      confidence: 0.9,
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    });
    store.close();

    const prepared = await prepareEvolutionBootstrapContext(workspace);
    assert.ok(prepared.evolution);
    assert.ok((prepared.evolution?.artifactCount ?? 0) >= 1);
    assert.ok(prepared.evolution?.controlPlaneSnapshotPath);
    assert.equal(fs.existsSync(prepared.evolution!.controlPlaneSnapshotPath!), true);
    const snapshot = fs.readFileSync(prepared.evolution!.controlPlaneSnapshotPath!, "utf8");
    assert.match(snapshot, /Verification workflow/);
    assert.match(snapshot, /retrieved-artifacts: [1-9]/);
  } finally {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test("renderers expose evolution bootstrap context to runtime consumers", async () => {
  const workspace = loadWorkspace("demo@docker");
  const dbPath = controlPlaneEvolutionDbPath(workspace);

  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const store = await EvolutionStore.open(dbPath);
    store.upsertArtifact({
      id: `artifact-${process.pid}-${Date.now()}`,
      workspaceId: workspace.identity.projectName,
      userProfileId: workspace.userProfile.id,
      kind: "user-preference",
      scope: "user",
      title: "Operator preference",
      content: "Prefer concise, verification-first execution.",
      confidence: 0.8,
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    });
    store.close();

    const prepared = await prepareEvolutionBootstrapContext(workspace);
    const dockerRendered = renderDockerWorkspace(prepared);
    const podRendered = renderPodWorkspace(prepared);

    assert.match(dockerRendered, /POLARIS_EVOLUTION_ROOT/);
    assert.match(dockerRendered, /POLARIS_EVOLUTION_CONTEXT_FILE/);
    assert.match(dockerRendered, /bootstrap-context\.md/);
    assert.match(dockerRendered, /runtime-observer\.mjs/);
    assert.match(dockerRendered, /runtime-observer\.log/);
    assert.match(dockerRendered, /POLARIS_PASEO_DAEMON_URL/);
    assert.match(podRendered, /POLARIS_EVOLUTION_ROOT/);
    assert.match(podRendered, /POLARIS_EVOLUTION_CONTEXT_FILE/);
    assert.match(podRendered, /bootstrap-context\.md/);
  } finally {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
