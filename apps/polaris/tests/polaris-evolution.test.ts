import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PaseoManagerAdapter } from "../scripts/evolution/adapter.js";
import { applyCuratorResult, curateMemoryEntries } from "../scripts/evolution/curator.js";
import { ensureDir, parseMemoryMarkdown, renderMemoryMarkdown, summarizeMemory, writePendingMemoryChanges } from "../scripts/evolution/files.js";
import { loadVaultFromConfigPath, resolveVaultConfigPath } from "../scripts/config/load.js";
import { retrieveMemoryContext, renderMemoryEntries } from "../scripts/evolution/retriever.js";
import { reviewExecutionCandidate } from "../scripts/evolution/reviewer.js";

function loadVaultFromRefForTest(projectRef: string) {
  const resolved = resolveVaultConfigPath(projectRef);
  return loadVaultFromConfigPath(
    resolved.configPath,
    resolved.project,
    resolved.backendHint,
    resolved.profileHint,
  );
}

test("memory retrieval renders relevant entries from markdown files", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-memory-"));
  const memoryPath = path.join(tempDir, "MEMORY.md");
  const userPath = path.join(tempDir, "USER.md");
  try {
    fs.writeFileSync(memoryPath, [
      "# Polaris Vault Memory",
      "",
      "- Project: demo",
      "- User profile: user-1",
      "- Target: vault-memory",
      "",
      "## Validation",
      "",
      "- `run-verifier-first` Run verifier before retrying.",
      "  Use the verifier before repeating the same failing command.",
      "  Source: session-1. Updated: 2026-06-23T00:00:00.000Z.",
      "",
    ].join("\n"), "utf8");
    fs.writeFileSync(userPath, [
      "# Polaris User Memory",
      "",
      "- Project: demo",
      "- User profile: user-1",
      "- Target: user-memory",
      "",
      "## Preferences",
      "",
      "- `response-style` Operator response style.",
      "  Prefer concise responses.",
      "  Source: session-2. Updated: 2026-06-23T00:00:00.000Z.",
      "",
    ].join("\n"), "utf8");

    const entries = [
      ...parseMemoryMarkdown({ filePath: memoryPath, vaultId: "demo", userProfileId: "user-1", target: "vault-memory" }),
      ...parseMemoryMarkdown({ filePath: userPath, vaultId: "demo", userProfileId: "user-1", target: "user-memory" }),
    ];
    const retrieved = await retrieveMemoryContext(entries, {
      vaultId: "demo",
      userProfileId: "user-1",
      prompt: "verifier",
      limit: 5,
    });
    assert.equal(retrieved.length, 2);
    assert.match(renderMemoryEntries(retrieved), /Run verifier before retrying/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("paseo manager adapter normalizes transcript events and runtime paths", () => {
  const vault = loadVaultFromRefForTest("demo");
  const adapter = new PaseoManagerAdapter();
  assert.equal(adapter.supports(vault), true);
  const runtimePaths = adapter.buildRuntimePaths(vault);
  assert.equal(runtimePaths.stateRoot, vault.agent.runtime.stateRoot);
  assert.equal(runtimePaths.evolutionRoot, vault.agent.runtime.evolutionRoot);
  const events = adapter.normalizeTranscript({
    vault,
    sessionId: "session-2",
    transcript: [{ timestamp: "2026-06-21T11:00:01.000Z", role: "assistant", content: "Implemented the fix and ran verification." }],
  });
  assert.equal(events.length, 1);
});

test("review derives pending memory changes", async () => {
  const review = await reviewExecutionCandidate({
    vaultId: "demo",
    userProfileId: "user-1",
    managerId: "paseo",
    sessionId: "session-1",
    events: [{
      id: "evt-1",
      vaultId: "demo",
      managerId: "paseo",
      sessionId: "session-1",
      kind: "task-failed",
      timestamp: "2026-06-21T11:00:00.000Z",
      payload: { message: "Prefer shorter answers and use the verifier before retrying the same command." },
    }],
  });
  assert.ok(review.changes.length >= 1);
});

test("curator promotes and suppresses memory entries", () => {
  const now = new Date().toISOString();
  const entries = [
    {
      id: "promoted-1",
      vaultId: "demo",
      userProfileId: "user-1",
      target: "vault-memory" as const,
      section: "Validation",
      key: "run-verifier-first",
      title: "Run verifier before retrying",
      body: "Use the verifier first.",
      confidence: 0.95,
      status: "active" as const,
      sourceSessionId: "session-p",
      createdAt: now,
      updatedAt: now,
      metadata: {},
    },
    {
      id: "suppressed-1",
      vaultId: "demo",
      userProfileId: "user-1",
      target: "vault-memory" as const,
      section: "Validation",
      key: "weak-signal",
      title: "Weak signal",
      body: "Weak signal.",
      confidence: 0.1,
      status: "active" as const,
      sourceSessionId: "session-s",
      createdAt: now,
      updatedAt: now,
      metadata: {},
    },
  ];
  const result = curateMemoryEntries(entries);
  assert.ok(result.promotedIds.includes("promoted-1"));
  assert.ok(result.suppressedIds.includes("suppressed-1"));
  const applied = applyCuratorResult(entries);
  assert.equal(applied.find((entry) => entry.id === "suppressed-1")?.status, "suppressed");
});

test("file-first summary counts vault, user, and pending changes", () => {
  const now = new Date().toISOString();
  const vaultEntries = [{
    id: "vault-1",
    vaultId: "demo",
    userProfileId: "user-1",
    target: "vault-memory" as const,
    section: "Validation",
    key: "run-verifier-first",
    title: "Run verifier before retrying",
    body: "Run verifier before retrying.",
    confidence: 0.9,
    status: "active" as const,
    sourceSessionId: "session-1",
    createdAt: now,
    updatedAt: now,
    metadata: {},
  }];
  const userEntries = [{
    id: "user-1-entry",
    vaultId: "demo",
    userProfileId: "user-1",
    target: "user-memory" as const,
    section: "Preferences",
    key: "response-style",
    title: "Prefer concise reviews",
    body: "Prefer concise reviews.",
    confidence: 0.8,
    status: "active" as const,
    sourceSessionId: "session-2",
    createdAt: now,
    updatedAt: now,
    metadata: {},
  }];
  const pending = [{
    id: "pending-1",
    vaultId: "demo",
    userProfileId: "user-1",
    target: "vault-memory" as const,
    operation: "replace" as const,
    section: "Validation",
    key: "run-verifier-first",
    candidate: { title: "Run verifier before retrying", body: "Use the verifier first." },
    reason: "reviewed",
    confidence: 0.7,
    sourceSessionId: "session-3",
    sourceRunIds: ["session-3"],
    createdAt: now,
    updatedAt: now,
    status: "pending" as const,
    metadata: {},
  }];
  const summary = summarizeMemory({ vaultEntries, userEntries, pendingChanges: pending });
  assert.equal(summary.artifactCount, 2);
  assert.equal(summary.activeVaultArtifacts, 1);
  assert.equal(summary.activeUserArtifacts, 1);
  assert.equal(summary.pendingMemoryChanges, 1);
});
