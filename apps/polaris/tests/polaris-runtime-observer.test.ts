import test from "node:test";
import assert from "node:assert/strict";

import {
  parseTriggerFlags,
  selectRuntimeLessons,
  renderContext,
  buildFallbackLesson,
  shouldPersistLesson,
  shouldUseModelSummarizer,
  deriveAgentObservationUpdate,
} from "../scripts/evolution/runtime-observer.mjs";

test("runtime observer parses explicit trigger markers", () => {
  const parsed = parseTriggerFlags(
    "POLARIS-LEARN-IT then POLARIS-RECALL but also POLARIS-DONT-LEARN and POLARIS-EPHEMERAL",
  );
  assert.deepEqual(parsed, {
    learn: true,
    recall: true,
    dontLearn: true,
    ephemeral: true,
  });
});

test("runtime observer accepts trigger aliases with underscores and learnt spelling", () => {
  const parsed = parseTriggerFlags(
    "POLARIS_LEARNT_IT then POLARIS_RECALL and POLARIS_DONT_LEARN plus POLARIS_EPHEMERAL",
  );
  assert.deepEqual(parsed, {
    learn: true,
    recall: true,
    dontLearn: true,
    ephemeral: true,
  });
});

test("runtime observer selects bounded lessons by confidence and recency", () => {
  const artifacts = [
    {
      id: "a",
      kind: "lesson",
      title: "Low",
      content: "low",
      confidence: 0.2,
      status: "active",
      updatedAt: "2026-06-21T00:00:00.000Z",
      metadata: { summary: "low", whenToUse: "", tags: [] },
    },
    {
      id: "b",
      kind: "lesson",
      title: "High old",
      content: "high old",
      confidence: 0.9,
      status: "active",
      updatedAt: "2026-06-20T00:00:00.000Z",
      metadata: { summary: "high old", whenToUse: "", tags: [] },
    },
    {
      id: "c",
      kind: "lesson",
      title: "High new",
      content: "high new",
      confidence: 0.9,
      status: "active",
      updatedAt: "2026-06-22T00:00:00.000Z",
      metadata: { summary: "high new", whenToUse: "", tags: [] },
    },
    {
      id: "d",
      kind: "lesson",
      title: "Medium",
      content: "medium",
      confidence: 0.5,
      status: "active",
      updatedAt: "2026-06-23T00:00:00.000Z",
      metadata: { summary: "medium", whenToUse: "", tags: [] },
    },
  ];
  const selected = selectRuntimeLessons(artifacts, { recallRequested: false });
  assert.equal(selected.length, 3);
  assert.deepEqual(selected.map((item) => item.title), ["High new", "High old", "Medium"]);
});

test("runtime observer deduplicates equivalent lessons before recall", () => {
  const artifacts = [
    {
      id: "a",
      kind: "lesson",
      title: "Same title",
      content: "same summary",
      confidence: 0.9,
      status: "active",
      updatedAt: "2026-06-23T00:00:00.000Z",
      metadata: { summary: "same summary", whenToUse: "same use", tags: ["codex"] },
    },
    {
      id: "b",
      kind: "lesson",
      title: "Same title",
      content: "same summary",
      confidence: 0.8,
      status: "active",
      updatedAt: "2026-06-22T00:00:00.000Z",
      metadata: { summary: "same summary", whenToUse: "same use", tags: ["codex"] },
    },
    {
      id: "c",
      kind: "lesson",
      title: "Different title",
      content: "other summary",
      confidence: 0.7,
      status: "active",
      updatedAt: "2026-06-21T00:00:00.000Z",
      metadata: { summary: "other summary", whenToUse: "", tags: [] },
    },
  ];
  const selected = selectRuntimeLessons(artifacts, { recallRequested: false });
  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map((item) => item.id), ["a", "c"]);
});

test("runtime observer renders lesson-oriented context", () => {
  const rendered = renderContext([
    {
      id: "a",
      kind: "lesson",
      title: "Codex auth fix",
      content: "copy auth",
      confidence: 0.8,
      status: "active",
      updatedAt: "2026-06-23T00:00:00.000Z",
      metadata: {
        summary: "Copy auth.json into the demo user profile.",
        whenToUse: "Codex demo runs fail with 401",
        tags: ["codex", "auth", "demo"],
      },
    },
  ]);
  assert.match(rendered, /Polaris Runtime Lessons/);
  assert.match(rendered, /Codex auth fix/);
  assert.match(rendered, /Use when: Codex demo runs fail with 401/);
  assert.match(rendered, /Tags: codex, auth, demo/);
});

test("runtime observer fallback lesson stays lesson-oriented", () => {
  const lesson = buildFallbackLesson(
    {
      provider: "codex",
      title: "POLARIS-LEARN-IT Fix auth",
      lastStatus: "error",
      lastError: "401 Unauthorized",
      cwd: "/workspace/project",
    },
    "session-1",
    { learn: true, recall: false, dontLearn: false, ephemeral: false },
  );
  assert.equal(lesson.kind, "lesson");
  assert.match(lesson.title, /Recovered failure lesson/);
  assert.match(lesson.whenToUse, /Use when codex shows the same failure pattern/i);
  assert.ok(lesson.tags.includes("codex"));
  assert.equal(lesson.trigger, "POLARIS-LEARN-IT");
});

test("runtime observer persistence policy is conservative by default", () => {
  assert.equal(
    shouldPersistLesson(
      { learn: false, recall: false, dontLearn: false, ephemeral: false },
      null,
      "running",
    ),
    false,
  );
  assert.equal(
    shouldPersistLesson(
      { learn: false, recall: false, dontLearn: false, ephemeral: false },
      "running",
      "idle",
    ),
    true,
  );
  assert.equal(
    shouldPersistLesson(
      { learn: false, recall: false, dontLearn: true, ephemeral: false },
      "running",
      "error",
    ),
    false,
  );
});

test("runtime observer model summarizer policy only targets explicit or meaningful runs", () => {
  assert.equal(
    shouldUseModelSummarizer(
      { learn: false, recall: false, dontLearn: false, ephemeral: false },
      "running",
    ),
    false,
  );
  assert.equal(
    shouldUseModelSummarizer(
      { learn: true, recall: false, dontLearn: false, ephemeral: false },
      "running",
    ),
    true,
  );
  assert.equal(
    shouldUseModelSummarizer(
      { learn: false, recall: false, dontLearn: false, ephemeral: false },
      "error",
    ),
    true,
  );
});

test("runtime observer derives lesson capture from daemon-owned agent records", async () => {
  const record = {
    id: "agent-1",
    provider: "codex",
    cwd: "/workspace/project",
    title: "POLARIS-LEARN-IT fix auth wiring",
    lastStatus: "idle",
    lastError: null,
    updatedAt: "2026-06-21T13:21:03.899Z",
    runtimeInfo: { sessionId: "session-1" },
    persistence: { sessionId: "session-1" },
  };
  const derived = await deriveAgentObservationUpdate("running", record);
  assert.equal(derived.sessionId, "session-1");
  assert.equal(derived.triggerFlags.learn, true);
  assert.deepEqual(derived.events.map((event) => event.kind), ["task-output", "task-completed"]);
  assert.ok(derived.lesson);
  assert.equal(derived.lesson?.kind, "lesson");
  assert.match(derived.lesson?.title || "", /Recovered workflow lesson/);
});

test("runtime observer infers completion when a short run is first seen as idle", async () => {
  const record = {
    id: "agent-short",
    provider: "codex",
    cwd: "/workspace/project",
    title: "Create hello-short.txt containing exactly hello from short.",
    lastStatus: "idle",
    lastError: null,
    updatedAt: "2026-06-21T15:21:17.997Z",
    requiresAttention: true,
    attentionReason: "finished",
    runtimeInfo: { sessionId: "session-short" },
    persistence: { sessionId: "session-short" },
  };
  const derived = await deriveAgentObservationUpdate(null, record);
  assert.deepEqual(derived.events.map((event) => event.kind), ["task-output", "task-completed"]);
  assert.ok(derived.lesson);
});
