import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { renderDockerWorkspace } from "../scripts/backends/docker/render.js";
import { renderPodWorkspace } from "../scripts/backends/pod/render.js";
import { loadWorkspaceFromConfigPath, resolveWorkspaceConfigPath } from "../scripts/config/load.js";
import {
  appendEvolutionEvent,
  controlPlaneEvolutionDbPath,
  controlPlanePendingMemoryPath,
  controlPlaneSessionSnapshotPath,
  controlPlaneUserMemoryPath,
  controlPlaneWorkspaceMemoryPath,
  finalizeEvolutionSession,
  prepareEvolutionMemorySnapshot,
} from "../scripts/evolution/runtime.js";
import { EvolutionStore } from "../scripts/evolution/store.js";

function loadWorkspaceFromRefForTest(projectRef: string) {
  const resolved = resolveWorkspaceConfigPath(projectRef);
  return loadWorkspaceFromConfigPath(
    resolved.configPath,
    resolved.project,
    resolved.backendHint,
    resolved.profileHint,
  );
}

test("prepareEvolutionMemorySnapshot writes control-plane memory files and snapshot", async () => {
  const workspace = loadWorkspaceFromRefForTest("demo@docker");
  const workspaceMemoryPath = controlPlaneWorkspaceMemoryPath(workspace);
  const userMemoryPath = controlPlaneUserMemoryPath(workspace);
  const snapshotPath = controlPlaneSessionSnapshotPath(workspace, "session-1");
  try {
    fs.mkdirSync(path.dirname(workspaceMemoryPath), { recursive: true });
    fs.mkdirSync(path.dirname(userMemoryPath), { recursive: true });
    fs.writeFileSync(workspaceMemoryPath, [
      "# Polaris Workspace Memory",
      "",
      `- Project: ${workspace.identity.projectName}`,
      `- User profile: ${workspace.userProfile.id}`,
      "- Target: workspace-memory",
      "",
      "## Validation",
      "",
      "- `run-verifier-first` Run verifier before retrying.",
      "  Run verification before retrying a failed loop.",
      "  Source: session-1. Updated: 2026-06-23T00:00:00.000Z.",
      "",
    ].join("\n"), "utf8");
    fs.writeFileSync(userMemoryPath, [
      "# Polaris User Memory",
      "",
      `- Project: ${workspace.identity.projectName}`,
      `- User profile: ${workspace.userProfile.id}`,
      "- Target: user-memory",
      "",
      "## Preferences",
      "",
      "- `response-style` Operator response style.",
      "  Prefer concise, verification-first execution.",
      "  Source: session-2. Updated: 2026-06-23T00:00:00.000Z.",
      "",
    ].join("\n"), "utf8");

    const prepared = await prepareEvolutionMemorySnapshot(workspace, "session-1");
    assert.ok(prepared.evolution);
    assert.equal(fs.existsSync(snapshotPath), true);
    const snapshot = fs.readFileSync(snapshotPath, "utf8");
    assert.match(snapshot, /Polaris Memory Snapshot/);
    assert.match(snapshot, /Workspace Memory/);
    assert.match(snapshot, /User Memory/);
    assert.match(prepared.evolution!.workspaceMemoryFile, /\.polaris\/MEMORY\.md/);
    assert.match(prepared.evolution!.userMemoryFile, /polaris\/USER\.md/);
    assert.match(prepared.evolution!.sessionSnapshotFile, /sessions\/session-1\/memory-snapshot\.md/);
  } finally {
    fs.rmSync(path.dirname(path.dirname(workspaceMemoryPath)), { recursive: true, force: true });
  }
});

test("prepareEvolutionMemorySnapshot imports existing markdown memory into the DB", async () => {
  const workspace = loadWorkspaceFromRefForTest("demo@docker");
  const workspaceMemoryPath = controlPlaneWorkspaceMemoryPath(workspace);
  const userMemoryPath = controlPlaneUserMemoryPath(workspace);
  const dbPath = controlPlaneEvolutionDbPath(workspace);
  try {
    fs.mkdirSync(path.dirname(workspaceMemoryPath), { recursive: true });
    fs.mkdirSync(path.dirname(userMemoryPath), { recursive: true });
    fs.writeFileSync(workspaceMemoryPath, [
      "# Polaris Workspace Memory",
      "",
      `- Project: ${workspace.identity.projectName}`,
      `- User profile: ${workspace.userProfile.id}`,
      "- Target: workspace-memory",
      "",
      "## Validation",
      "",
      "- `run-verifier-first` Run verifier before retrying.",
      "  Run verification before retrying a failed loop.",
      "  Source: session-1. Updated: 2026-06-23T00:00:00.000Z.",
      "",
    ].join("\n"), "utf8");
    fs.writeFileSync(userMemoryPath, [
      "# Polaris User Memory",
      "",
      `- Project: ${workspace.identity.projectName}`,
      `- User profile: ${workspace.userProfile.id}`,
      "- Target: user-memory",
      "",
      "## Preferences",
      "",
      "- `response-style` Operator response style.",
      "  Prefer concise, verification-first execution.",
      "  Source: session-2. Updated: 2026-06-23T00:00:00.000Z.",
      "",
    ].join("\n"), "utf8");
    fs.rmSync(dbPath, { force: true });

    await prepareEvolutionMemorySnapshot(workspace, "session-import");

    assert.equal(fs.existsSync(dbPath), true);
    const workspaceMemory = fs.readFileSync(workspaceMemoryPath, "utf8");
    const userMemory = fs.readFileSync(userMemoryPath, "utf8");
    assert.match(workspaceMemory, /run-verifier-first/);
    assert.match(userMemory, /response-style/);
  } finally {
    fs.rmSync(path.dirname(path.dirname(workspaceMemoryPath)), { recursive: true, force: true });
  }
});

test("finalizeEvolutionSession preserves the full mirrored event history", async () => {
  const workspace = loadWorkspaceFromRefForTest("demo@docker");
  const workspaceMemoryPath = controlPlaneWorkspaceMemoryPath(workspace);
  const eventsPath = path.join(path.dirname(workspaceMemoryPath), "execution-events.jsonl");
  try {
    fs.rmSync(path.dirname(path.dirname(workspaceMemoryPath)), { recursive: true, force: true });

    await appendEvolutionEvent(workspace, "session-1", "task-started", { command: "start" });
    await appendEvolutionEvent(workspace, "session-1", "task-completed", { command: "start" });
    await finalizeEvolutionSession(workspace, "session-1");

    await appendEvolutionEvent(workspace, "session-2", "task-started", { command: "status" });
    await appendEvolutionEvent(workspace, "session-2", "task-completed", { command: "status" });
    await finalizeEvolutionSession(workspace, "session-2");

    const events = fs.readFileSync(eventsPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((event) => event.sessionId),
      ["session-1", "session-1", "session-2", "session-2"],
    );
  } finally {
    fs.rmSync(path.dirname(path.dirname(workspaceMemoryPath)), { recursive: true, force: true });
  }
});

test("finalizeEvolutionSession stages reviewed memory changes by default", async () => {
  const workspace = loadWorkspaceFromRefForTest("demo@docker");
  const workspaceMemoryPath = controlPlaneWorkspaceMemoryPath(workspace);
  const pendingPath = controlPlanePendingMemoryPath(workspace);
  const dbPath = controlPlaneEvolutionDbPath(workspace);
  const previousPolicy = process.env.POLARIS_MEMORY_WRITE_POLICY;
  delete process.env.POLARIS_MEMORY_WRITE_POLICY;
  try {
    fs.rmSync(path.dirname(path.dirname(workspaceMemoryPath)), { recursive: true, force: true });

    await appendEvolutionEvent(workspace, "session-stage", "task-failed", {
      message: "Prefer shorter answers and use the verifier before retrying the same command.",
    });
    await finalizeEvolutionSession(workspace, "session-stage");

    const store = await EvolutionStore.open(dbPath);
    try {
      const pending = store.listPendingMemoryChanges(workspace.identity.projectName);
      const committed = store.queryMemoryEntries({
        workspaceId: workspace.identity.projectName,
        target: "workspace-memory",
        limit: 20,
      });
      assert.ok(pending.length >= 1);
      assert.ok(pending.some((change) => change.status === "pending"));
      assert.equal(committed.length, 0);
    } finally {
      store.close();
    }

    const pendingJson = JSON.parse(fs.readFileSync(pendingPath, "utf8")) as Array<{ status: string }>;
    assert.ok(pendingJson.some((change) => change.status === "pending"));
  } finally {
    if (previousPolicy === undefined) {
      delete process.env.POLARIS_MEMORY_WRITE_POLICY;
    } else {
      process.env.POLARIS_MEMORY_WRITE_POLICY = previousPolicy;
    }
    fs.rmSync(path.dirname(path.dirname(workspaceMemoryPath)), { recursive: true, force: true });
  }
});

test("auto-applied memory updates do not rewrite an existing session snapshot", async () => {
  const workspace = loadWorkspaceFromRefForTest("demo@docker");
  const workspaceMemoryPath = controlPlaneWorkspaceMemoryPath(workspace);
  const snapshotPath = controlPlaneSessionSnapshotPath(workspace, "session-frozen");
  const dbPath = controlPlaneEvolutionDbPath(workspace);
  const previousPolicy = process.env.POLARIS_MEMORY_WRITE_POLICY;
  process.env.POLARIS_MEMORY_WRITE_POLICY = "auto";
  try {
    fs.rmSync(path.dirname(path.dirname(workspaceMemoryPath)), { recursive: true, force: true });

    const prepared = await prepareEvolutionMemorySnapshot(workspace, "session-frozen");
    assert.ok(prepared.evolution);
    const frozenSnapshot = fs.readFileSync(snapshotPath, "utf8");
    assert.doesNotMatch(frozenSnapshot, /Run verifier before retrying/);

    await appendEvolutionEvent(workspace, "session-auto", "task-failed", {
      message: "Use the verifier before retrying the same command.",
    });
    await finalizeEvolutionSession(workspace, "session-auto");

    const store = await EvolutionStore.open(dbPath);
    try {
      const pending = store.listPendingMemoryChanges(workspace.identity.projectName);
      const committed = store.queryMemoryEntries({
        workspaceId: workspace.identity.projectName,
        target: "workspace-memory",
        limit: 20,
      });
      assert.ok(pending.some((change) => change.status === "applied"));
      assert.ok(committed.some((entry) => entry.key === "run-verifier-first"));
    } finally {
      store.close();
    }

    const workspaceMemory = fs.readFileSync(workspaceMemoryPath, "utf8");
    assert.match(workspaceMemory, /Run verifier before retrying/);
    const frozenSnapshotAfter = fs.readFileSync(snapshotPath, "utf8");
    assert.equal(frozenSnapshotAfter, frozenSnapshot);
  } finally {
    if (previousPolicy === undefined) {
      delete process.env.POLARIS_MEMORY_WRITE_POLICY;
    } else {
      process.env.POLARIS_MEMORY_WRITE_POLICY = previousPolicy;
    }
    fs.rmSync(path.dirname(path.dirname(workspaceMemoryPath)), { recursive: true, force: true });
  }
});

test("renderers expose memory files and session snapshot paths to runtime consumers", async () => {
  const workspace = loadWorkspaceFromRefForTest("demo@docker");
  const workspaceMemoryPath = controlPlaneWorkspaceMemoryPath(workspace);
  try {
    fs.mkdirSync(path.dirname(workspaceMemoryPath), { recursive: true });
    fs.writeFileSync(workspaceMemoryPath, [
      "# Polaris Workspace Memory",
      "",
      `- Project: ${workspace.identity.projectName}`,
      `- User profile: ${workspace.userProfile.id}`,
      "- Target: workspace-memory",
      "",
      "## Validation",
      "",
      "- `run-verifier-first` Run verifier before retrying.",
      "  Run verifier before retrying.",
      "  Source: session-1. Updated: 2026-06-23T00:00:00.000Z.",
      "",
    ].join("\n"), "utf8");

    const prepared = await prepareEvolutionMemorySnapshot(workspace, "session-2");
    const dockerRendered = renderDockerWorkspace(prepared);
    const podRendered = renderPodWorkspace(prepared);

    assert.match(dockerRendered, /POLARIS_WORKSPACE_MEMORY_FILE/);
    assert.match(dockerRendered, /POLARIS_USER_MEMORY_FILE/);
    assert.match(dockerRendered, /POLARIS_MEMORY_SNAPSHOT_FILE/);
    assert.match(dockerRendered, /\.polaris\/MEMORY\.md/);
    assert.match(dockerRendered, /runtime-memory-observer\.mjs/);
    assert.match(dockerRendered, /status-observer\.mjs/);
    assert.match(podRendered, /POLARIS_WORKSPACE_MEMORY_FILE/);
    assert.match(podRendered, /POLARIS_USER_MEMORY_FILE/);
    assert.match(podRendered, /POLARIS_MEMORY_SNAPSHOT_FILE/);
  } finally {
    fs.rmSync(path.dirname(path.dirname(workspaceMemoryPath)), { recursive: true, force: true });
  }
});
