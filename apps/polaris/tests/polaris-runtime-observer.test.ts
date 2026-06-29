import test from "node:test";
import assert from "node:assert/strict";

import {
  selectRuntimeMemoryEntries,
  renderWorkspaceMemory,
  renderUserMemory,
  renderSessionSnapshot,
  buildFallbackMemoryChange,
  shouldPersistMemory,
  shouldUseModelSummarizer,
  deriveAgentObservationUpdate,
} from "../scripts/evolution/runtime-memory-observer.mjs";

test("runtime memory observer selects bounded memory entries by confidence and recency", () => {
  const entries = [
    {
      id: "a",
      target: "workspace-memory",
      section: "Validation",
      key: "low",
      title: "Low",
      body: "low",
      confidence: 0.2,
      status: "active",
      updatedAt: "2026-06-21T00:00:00.000Z",
    },
    {
      id: "b",
      target: "workspace-memory",
      section: "Validation",
      key: "high-old",
      title: "High old",
      body: "high old",
      confidence: 0.9,
      status: "active",
      updatedAt: "2026-06-20T00:00:00.000Z",
    },
    {
      id: "c",
      target: "workspace-memory",
      section: "Validation",
      key: "high-new",
      title: "High new",
      body: "high new",
      confidence: 0.9,
      status: "active",
      updatedAt: "2026-06-22T00:00:00.000Z",
    },
  ];
  const selected = selectRuntimeMemoryEntries(entries, { limit: 2 });
  assert.deepEqual(selected.map((item) => item.title), ["High new", "High old"]);
});

test("runtime memory observer deduplicates equivalent memory entries", () => {
  const entries = [
    {
      id: "a",
      target: "workspace-memory",
      section: "Validation",
      key: "run-verifier-first",
      title: "Run verifier before retrying",
      body: "Use the verifier first.",
      confidence: 0.9,
      status: "active",
      updatedAt: "2026-06-23T00:00:00.000Z",
    },
    {
      id: "b",
      target: "workspace-memory",
      section: "Validation",
      key: "run-verifier-first",
      title: "Run verifier before retrying",
      body: "Use the verifier first.",
      confidence: 0.8,
      status: "active",
      updatedAt: "2026-06-22T00:00:00.000Z",
    },
  ];
  const selected = selectRuntimeMemoryEntries(entries, { limit: 5 });
  assert.equal(selected.length, 1);
});

test("runtime memory observer renders workspace memory and snapshot", () => {
  const entries = [
    {
      id: "a",
      target: "workspace-memory",
      section: "Validation",
      key: "run-verifier-first",
      title: "Run verifier before retrying",
      body: "Use the verifier before repeating the same failing command.",
      confidence: 0.8,
      status: "active",
      updatedAt: "2026-06-23T00:00:00.000Z",
    },
    {
      id: "b",
      target: "user-memory",
      section: "Preferences",
      key: "response-style",
      title: "Operator response style",
      body: "Prefer concise, direct responses unless extra detail is explicitly requested.",
      confidence: 0.8,
      status: "active",
      updatedAt: "2026-06-23T00:00:00.000Z",
    },
  ];
  assert.match(renderWorkspaceMemory(entries), /Polaris Workspace Memory/);
  assert.match(renderUserMemory(entries), /Polaris User Memory/);
  const snapshot = renderSessionSnapshot(entries);
  assert.match(snapshot, /Polaris Memory Snapshot/);
  assert.match(snapshot, /Workspace Memory/);
  assert.match(snapshot, /User Memory/);
});

test("runtime memory observer fallback memory stays memory-oriented", () => {
  const memory = buildFallbackMemoryChange(
    {
      provider: "codex",
      title: "Fix auth wiring",
      lastStatus: "error",
      lastError: "401 Unauthorized",
      cwd: "/workspace/project",
    },
    "session-1",
  );
  assert.equal(memory.target, "workspace-memory");
  assert.match(memory.title, /Runtime failure recovery/);
});

test("runtime memory observer persistence policy is conservative by default", () => {
  assert.equal(shouldPersistMemory(null, "running"), false);
  assert.equal(shouldPersistMemory("running", "idle"), true);
  assert.equal(shouldPersistMemory("running", "error"), true);
});

test("runtime memory observer summarizer policy only targets meaningful runs", () => {
  assert.equal(shouldUseModelSummarizer("running"), false);
  assert.equal(shouldUseModelSummarizer("idle"), true);
  assert.equal(shouldUseModelSummarizer("error"), true);
});

test("runtime memory observer derives memory capture from daemon-owned agent records", async () => {
  const record = {
    id: "agent-1",
    provider: "codex",
    cwd: "/workspace/project",
    title: "fix auth wiring",
    lastStatus: "idle",
    lastError: null,
    updatedAt: "2026-06-21T13:21:03.899Z",
    runtimeInfo: { sessionId: "session-1" },
    persistence: { sessionId: "session-1" },
  };
  const derived = await deriveAgentObservationUpdate("running", record);
  assert.equal(derived.sessionId, "session-1");
  assert.deepEqual(derived.events.map((event) => event.kind), ["task-output", "task-completed"]);
  assert.ok(derived.memoryEntry);
});

test("runtime memory observer infers completion when the first poll already sees idle attention", async () => {
  const record = {
    id: "agent-short",
    provider: "codex",
    cwd: "/workspace/project",
    title: "short successful run",
    lastStatus: "idle",
    lastError: null,
    updatedAt: "2026-06-21T15:21:17.997Z",
    requiresAttention: true,
    attentionReason: "finished",
    runtimeInfo: { sessionId: "session-short" },
    persistence: { sessionId: "session-short" },
  };
  const derived = await deriveAgentObservationUpdate(null, record);
  assert.equal(derived.sessionId, "session-short");
  assert.deepEqual(derived.events.map((event) => event.kind), ["task-output", "task-completed"]);
  assert.ok(derived.memoryEntry);
  assert.equal(derived.memoryEntry?.target, "user-memory");
});

test("runtime memory observer emits task-failed and workspace memory for error transitions", async () => {
  const record = {
    id: "agent-error",
    provider: "codex",
    cwd: "/workspace/project",
    title: "broken auth wiring",
    lastStatus: "error",
    lastError: "401 Unauthorized",
    updatedAt: "2026-06-21T16:00:00.000Z",
    runtimeInfo: { sessionId: "session-error" },
    persistence: { sessionId: "session-error" },
  };
  const derived = await deriveAgentObservationUpdate("running", record);
  assert.equal(derived.sessionId, "session-error");
  assert.deepEqual(derived.events.map((event) => event.kind), ["task-output", "task-failed"]);
  assert.equal(derived.memoryEntry?.target, "workspace-memory");
  assert.match(derived.memoryEntry?.body || "", /401 Unauthorized/);
});
