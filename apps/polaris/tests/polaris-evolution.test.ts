import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EvolutionStore } from "../scripts/evolution/store.js";
import { reviewExecutionCandidate } from "../scripts/evolution/reviewer.js";
import { retrieveEvolutionContext, renderRetrievedArtifacts } from "../scripts/evolution/retriever.js";
import { applyCuratorResult } from "../scripts/evolution/curator.js";
import { PaseoManagerAdapter } from "../scripts/evolution/adapter.js";
import { loadWorkspace } from "../scripts/config/load.js";

test("evolution store records events and retrieves curated artifacts", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-evolution-"));
  const dbPath = path.join(tempDir, "store.db");
  const store = await EvolutionStore.open(dbPath);

  try {
    store.recordEvent({
      id: "evt-1",
      workspaceId: "demo",
      managerId: "paseo",
      sessionId: "session-1",
      kind: "task-failed",
      timestamp: "2026-06-21T11:00:00.000Z",
      payload: {
        message: "Prefer shorter answers and use the verifier before retrying the same command.",
      },
    });

    const events = store.listEventsForSession("demo", "session-1");
    assert.equal(events.length, 1);

    const review = await reviewExecutionCandidate({
      workspaceId: "demo",
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
      workspaceId: "demo",
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
  const workspace = loadWorkspace("demo");
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
  assert.equal(events[0]?.workspaceId, "demo");
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
        workspaceId: "demo",
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
        workspaceId: "demo",
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
        workspaceId: "demo",
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
      workspaceId: "demo",
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

test("evolution store filters, archives, and summarizes artifacts across scopes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-evolution-filters-"));
  const dbPath = path.join(tempDir, "store.db");
  const store = await EvolutionStore.open(dbPath);
  try {
    const now = new Date().toISOString();
    store.upsertArtifact({
      id: "workspace-1",
      workspaceId: "demo",
      userProfileId: "user-1",
      kind: "workspace-playbook",
      scope: "workspace",
      title: "Verifier workflow",
      content: "Run verifier before retrying.",
      confidence: 0.9,
      status: "active",
      sourceSessionId: "session-1",
      createdAt: now,
      updatedAt: now,
      metadata: {
        retrieval: { reasons: ["workspace-scoped"] },
        explainability: { existsBecause: "Captured from a successful retry flow." },
        curator: { action: "promoted", reason: "high confidence" },
      },
    });
    store.upsertArtifact({
      id: "user-1-artifact",
      workspaceId: "demo",
      userProfileId: "user-1",
      kind: "lesson",
      scope: "user",
      title: "User preference",
      content: "Prefer concise reviews.",
      confidence: 0.8,
      status: "active",
      sourceSessionId: "session-2",
      createdAt: now,
      updatedAt: now,
      metadata: {
        explainability: { suppressedBecause: "not actually suppressed" },
      },
    });
    store.upsertArtifact({
      id: "other-user-artifact",
      workspaceId: "demo",
      userProfileId: "user-2",
      kind: "lesson",
      scope: "user",
      title: "Other user secret",
      content: "Should stay hidden",
      confidence: 0.7,
      status: "active",
      sourceSessionId: "session-3",
      createdAt: now,
      updatedAt: now,
      metadata: {},
    });

    const filtered = store.queryArtifacts({
      workspaceId: "demo",
      userProfileId: "user-1",
      kinds: ["workspace-playbook"],
      text: "verifier",
      limit: 5,
    });
    assert.deepEqual(filtered.map((artifact) => artifact.id), ["workspace-1"]);

    const noUserSummary = store.summarize("demo");
    assert.equal(noUserSummary.activeUserArtifacts, 0);

    const summary = store.summarize("demo", "user-1");
    assert.equal(summary.artifactCount, 3);
    assert.equal(summary.activeWorkspaceArtifacts, 1);
    assert.equal(summary.activeUserArtifacts, 1);
    assert.ok(summary.latestTitles.includes("Verifier workflow"));
    const latest = summary.latestArtifacts.find((artifact) => artifact.title === "Verifier workflow");
    assert.deepEqual(latest?.whyRetrieved, ["workspace-scoped"]);
    assert.equal(latest?.whyExists, "Captured from a successful retry flow.");
    assert.equal(latest?.curatorAction, "promoted");
    assert.equal(latest?.curatorReason, "high confidence");

    store.archiveArtifacts([]);
    store.archiveArtifacts(["workspace-1"]);
    const afterArchive = store.queryArtifacts({
      workspaceId: "demo",
      userProfileId: "user-1",
      limit: 10,
    });
    assert.equal(afterArchive.some((artifact) => artifact.id === "workspace-1"), false);
    assert.equal(afterArchive.some((artifact) => artifact.id === "user-1-artifact"), true);
    assert.equal(afterArchive.some((artifact) => artifact.id === "other-user-artifact"), false);
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
