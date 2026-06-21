import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EvolutionStore } from "../scripts/polaris/evolution/store.js";
import { reviewExecutionCandidate } from "../scripts/polaris/evolution/reviewer.js";
import { retrieveEvolutionContext, renderRetrievedArtifacts } from "../scripts/polaris/evolution/retriever.js";
import { applyCuratorResult } from "../scripts/polaris/evolution/curator.js";
import { PaseoManagerAdapter } from "../scripts/polaris/evolution/adapter.js";
import { loadWorkspace } from "../scripts/polaris/config/load.js";

test("evolution store records events and retrieves curated artifacts", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-evolution-"));
  const dbPath = path.join(tempDir, "store.db");
  const store = await EvolutionStore.open(dbPath);

  try {
    store.recordEvent({
      id: "evt-1",
      workspaceId: "morpheus",
      managerId: "paseo",
      sessionId: "session-1",
      kind: "task-failed",
      timestamp: "2026-06-21T11:00:00.000Z",
      payload: {
        message: "Prefer shorter answers and use the verifier before retrying the same command.",
      },
    });

    const events = store.listEventsForSession("morpheus", "session-1");
    assert.equal(events.length, 1);

    const review = await reviewExecutionCandidate({
      workspaceId: "morpheus",
      userProfileId: "100000000000000001",
      managerId: "paseo",
      sessionId: "session-1",
      events,
    });
    assert.ok(review.artifacts.length >= 1);

    for (const artifact of review.artifacts) {
      store.upsertArtifact(artifact);
    }

    const retrieved = await retrieveEvolutionContext(store, {
      workspaceId: "morpheus",
      userProfileId: "100000000000000001",
      prompt: "prefer verifier",
      limit: 5,
    });
    assert.ok(retrieved.length >= 1);
    assert.match(renderRetrievedArtifacts(retrieved), /Relevant prior lessons:/);
    assert.ok(Array.isArray((retrieved[0]?.metadata as Record<string, unknown>)?.retrieval?.reasons));
    assert.match(renderRetrievedArtifacts(retrieved), /why retrieved:/);

    const curatorResult = applyCuratorResult(store, retrieved);
    assert.ok(Array.isArray(curatorResult.archivedIds));
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("paseo manager adapter normalizes transcript events and runtime paths", () => {
  const workspace = loadWorkspace("morpheus");
  const adapter = new PaseoManagerAdapter();
  assert.equal(adapter.supports(workspace), true);

  const runtimePaths = adapter.buildRuntimePaths(workspace);
  assert.equal(runtimePaths.stateRoot, workspace.agent.runtime.stateRoot);
  assert.equal(runtimePaths.evolutionRoot, workspace.agent.runtime.evolutionRoot);

  const events = adapter.normalizeTranscript({
    workspace,
    sessionId: "session-2",
    transcript: [
      {
        timestamp: "2026-06-21T11:00:01.000Z",
        role: "assistant",
        content: "Implemented the fix and ran verification.",
      },
    ],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.managerId, "paseo");
  assert.equal(events[0]?.workspaceId, "morpheus");
});

test("curator records promotion, suppression, and decay decisions with explainability", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-curation-"));
  const dbPath = path.join(tempDir, "store.db");
  const store = await EvolutionStore.open(dbPath);
  try {
    const now = new Date();
    const stale = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const artifacts = [
      {
        id: "promoted-1",
        workspaceId: "morpheus",
        userProfileId: "100000000000000001",
        kind: "workspace-playbook" as const,
        scope: "workspace" as const,
        title: "High confidence lesson",
        content: "Use the verifier first.",
        confidence: 0.95,
        status: "active" as const,
        sourceSessionId: "session-p",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        metadata: {},
      },
      {
        id: "suppressed-1",
        workspaceId: "morpheus",
        userProfileId: "100000000000000001",
        kind: "workspace-playbook" as const,
        scope: "workspace" as const,
        title: "Low confidence lesson",
        content: "Weak signal.",
        confidence: 0.1,
        status: "active" as const,
        sourceSessionId: "session-s",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        metadata: {},
      },
      {
        id: "decayed-1",
        workspaceId: "morpheus",
        userProfileId: "100000000000000001",
        kind: "workspace-playbook" as const,
        scope: "workspace" as const,
        title: "Stale medium lesson",
        content: "Old and weak.",
        confidence: 0.3,
        status: "active" as const,
        sourceSessionId: "session-d",
        createdAt: stale,
        updatedAt: stale,
        metadata: {},
      },
    ];
    for (const artifact of artifacts) {
      store.upsertArtifact(artifact);
    }

    const result = applyCuratorResult(store, artifacts);
    assert.ok(result.promotedIds?.includes("promoted-1"));
    assert.ok(result.suppressedIds.includes("suppressed-1"));
    assert.ok(result.decayedIds?.includes("decayed-1"));

    const queried = store.queryArtifacts({
      workspaceId: "morpheus",
      userProfileId: "100000000000000001",
      limit: 10,
    });
    const promoted = queried.find((artifact) => artifact.id === "promoted-1");
    assert.equal(promoted?.metadata.curator?.action, "promoted");
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
