import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ClhError } from "../src/errors.js";
import { runDshPreset, enforceOutputContract } from "../src/dsh-wrapper.js";
import { parseJsonl, readSessionLog, summarizeSessionLog, cwdSlug } from "../src/session-log.js";
import type { ClhEnv } from "../src/env.js";
import { validatePreset } from "../src/schema.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const syntheticEnv = (): ClhEnv => ({
  endpoint: "https://llm-gateway.example.invalid/v1",
  apiKey: "sk-synthetic-placeholder",
  models: { light: "synthetic-flash-model", strong: "synthetic-r1-model" },
  pricing: {},
  apiTimeoutMs: 1000,
  dshBin: "dsh",
  dshBinArgs: [],
  dshProfile: "headless",
  dshHome: "/tmp/clh-synthetic-dsh-home",
  zstdBin: "zstd",
});

const SYNTHETIC_EVENTS = [
  { type: "session", version: 4, id: "session-synthetic-1", createdAt: 1, cwd: "/tmp/clh-synthetic-workspace" },
  { type: "permission/preset", seq: 0, time: 1, data: { preset: "read-only" } },
  { type: "sandbox/mode", seq: 1, time: 2, data: { mode: "read-only" } },
  { type: "turn/start", seq: 2, time: 3, data: { turn: 1 } },
  { type: "tool/call", seq: 3, time: 4, data: { turn: 1, step: 1, callId: "call-1", name: "bash", arguments: "{\"command\":\"echo synthetic\"}" } },
  { type: "tool/result", seq: 4, time: 5, data: { turn: 1, step: 1, callId: "call-1" } },
  { type: "tool/call", seq: 5, time: 6, data: { turn: 1, step: 2, callId: "call-2", name: "read", arguments: "{}" } },
  {
    type: "assistant/message",
    seq: 6,
    time: 7,
    data: {
      turn: 1,
      step: 1,
      message: { role: "assistant", content: [{ type: "text", text: "intermediate" }] },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 130, cacheReadTokens: 10 },
    },
  },
  {
    type: "assistant/message",
    seq: 7,
    time: 8,
    data: {
      turn: 1,
      step: 2,
      message: { role: "assistant", content: [{ type: "reasoning", text: "hidden" }, { type: "text", text: "final answer" }] },
      usage: { inputTokens: 50, outputTokens: 10, totalTokens: 70 },
    },
  },
  { type: "turn/end", seq: 8, time: 9, data: { turn: 1, reason: { kind: "completed" } } },
];

function sessionLogFixture(): string {
  return SYNTHETIC_EVENTS.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

test("session log summary extracts tool calls, usage, turns, and final text", () => {
  const summary = summarizeSessionLog("synthetic-session.jsonl", parseJsonl(sessionLogFixture()));
  assert.equal(summary.toolCalls.length, 2);
  assert.equal(summary.toolCalls[0]?.name, "bash");
  assert.equal(summary.toolCalls[1]?.callId, "call-2");
  assert.deepEqual(summary.tokens, { inputTokens: 150, outputTokens: 30, totalTokens: 200 });
  assert.equal(summary.turnCount, 1);
  assert.equal(summary.finalText, "final answer");
  assert.equal(summary.endedReason, "completed");
  assert.equal(summary.permissionMode, "read-only");
  assert.equal(summary.sandboxMode, "read-only");
  assert.equal(summary.cwd, "/tmp/clh-synthetic-workspace");
});

test("malformed session log lines fail closed", () => {
  assert.throws(() => parseJsonl("{not json}\n"), (error: unknown) =>
    error instanceof ClhError && error.code === "CLH_SESSION_LOG_UNAVAILABLE",
  );
});

test("output contract enforcement covers precise-json and artifact", () => {
  assert.doesNotThrow(() => enforceOutputContract("precise-json", "{\"decision\":\"yes\"}", 0));
  assert.throws(
    () => enforceOutputContract("precise-json", "not json", 0),
    (error: unknown) => error instanceof ClhError && error.code === "CLH_OUTPUT_CONTRACT",
  );
  assert.throws(
    () => enforceOutputContract("precise-json", undefined, 0),
    (error: unknown) => error instanceof ClhError && error.code === "CLH_OUTPUT_CONTRACT",
  );
  assert.doesNotThrow(() => enforceOutputContract("artifact", "an artifact", 0));
  assert.doesNotThrow(() => enforceOutputContract("artifact", undefined, 2));
  assert.throws(
    () => enforceOutputContract("artifact", undefined, 0),
    (error: unknown) => error instanceof ClhError && error.code === "CLH_OUTPUT_CONTRACT",
  );
});

test("cwd slug matches the dsh session-persistence convention", () => {
  assert.equal(cwdSlug("/tmp/opencode"), "--tmp-opencode--");
  assert.equal(cwdSlug("/tmp/clh-synthetic-workspace"), "--tmp-clh-synthetic-workspace--");
});

test("zstd session logs decompress through the zstd binary", { skip: spawnSync("zstd", ["--version"]).status !== 0 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "clh-zstd-"));
  try {
    const plainPath = path.join(dir, "session.v4.jsonl");
    const zstdPath = `${plainPath}.zstd`;
    await writeFile(plainPath, sessionLogFixture(), "utf8");
    const compress = spawnSync("zstd", ["-q", "-f", plainPath, "-o", zstdPath]);
    assert.equal(compress.status, 0);
    const events = await readSessionLog(zstdPath, "zstd");
    assert.equal(events.length, SYNTHETIC_EVENTS.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wrapper dry-run compiles without spawning", async () => {
  const { preset } = validatePreset({
    kind: "bounded",
    model: "strong",
    toolBoundary: "read-only",
    loopCap: 5,
    outputContract: "artifact",
    permission: "read-only",
  });
  const receipt = await runDshPreset({
    preset,
    presetDir: fixturesDir,
    taskContext: { task: "synthetic task" },
    env: syntheticEnv(),
    workspaceRoot: "/tmp/clh-synthetic-workspace",
    dryRun: true,
  });
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.modelId, "synthetic-r1-model");
  assert.equal(receipt.toolCalls, 0);
  assert.equal(receipt.sessionLogPath, undefined);
});

test("wrapper runs a mock dsh end-to-end and parses the synthetic session log", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "clh-home-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "clh-ws-"));
  const previousKey = process.env["POLARIS_CLH_API_KEY"];
  const previousLogFixture = process.env["CLH_MOCK_LOG_FIXTURE"];
  try {
    const mockDsh = await writeMockDsh(home);
    process.env["POLARIS_CLH_API_KEY"] = "sk-synthetic-placeholder";
    process.env["CLH_MOCK_LOG_FIXTURE"] = path.join(home, "log-fixture.jsonl");
    const { preset } = validatePreset({
      kind: "open",
      model: "light",
      toolBoundary: "full",
      loopCap: 60,
      outputContract: "artifact",
      permission: "workspace-write",
    });
    const env = { ...syntheticEnv(), dshBin: mockDsh, dshHome: home };
    const receipt = await runDshPreset({
      preset,
      presetDir: fixturesDir,
      taskContext: { CVE_ID: "CVE-SYNTH-0006", LOGS: "synthetic logs" },
      env,
      workspaceRoot: workspace,
    });
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.toolCalls, 2);
    assert.deepEqual(receipt.tokens, { inputTokens: 150, outputTokens: 30, totalTokens: 200 });
    assert.equal(receipt.turnCount, 1);
    assert.equal(receipt.finalText, "final answer");
    assert.ok(receipt.sessionLogPath);
    assert.match(receipt.sessionLogPath ?? "", /session\.v4\.jsonl$/u);
  } finally {
    if (previousKey === undefined) delete process.env["POLARIS_CLH_API_KEY"];
    else process.env["POLARIS_CLH_API_KEY"] = previousKey;
    if (previousLogFixture === undefined) delete process.env["CLH_MOCK_LOG_FIXTURE"];
    else process.env["CLH_MOCK_LOG_FIXTURE"] = previousLogFixture;
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("wrapper fails closed when no session log exists", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "clh-home-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "clh-ws-"));
  const previousSkip = process.env["CLH_MOCK_SKIP_SESSION_LOG"];
  const previousLogFixture = process.env["CLH_MOCK_LOG_FIXTURE"];
  try {
    const mockDsh = await writeMockDsh(home);
    process.env["POLARIS_CLH_API_KEY"] = "sk-synthetic-placeholder";
    process.env["CLH_MOCK_SKIP_SESSION_LOG"] = "1";
    process.env["CLH_MOCK_LOG_FIXTURE"] = path.join(home, "log-fixture.jsonl");
    const { preset } = validatePreset({
      kind: "open",
      model: "light",
      toolBoundary: "full",
      loopCap: 60,
      outputContract: "artifact",
      permission: "workspace-write",
    });
    await assert.rejects(
      () =>
        runDshPreset({
          preset,
          presetDir: fixturesDir,
          taskContext: { task: "synthetic task" },
          env: { ...syntheticEnv(), dshBin: mockDsh, dshHome: home },
          workspaceRoot: workspace,
        }),
      (error: unknown) => error instanceof ClhError && error.code === "CLH_SESSION_LOG_UNAVAILABLE",
    );
  } finally {
    if (previousSkip === undefined) delete process.env["CLH_MOCK_SKIP_SESSION_LOG"];
    else process.env["CLH_MOCK_SKIP_SESSION_LOG"] = previousSkip;
    if (previousLogFixture === undefined) delete process.env["CLH_MOCK_LOG_FIXTURE"];
    else process.env["CLH_MOCK_LOG_FIXTURE"] = previousLogFixture;
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

async function writeMockDsh(home: string): Promise<string> {
  const script = [
    "#!/bin/sh",
    "# Synthetic dsh stand-in for wrapper tests; writes a fake session log.",
    `if [ -n "\${CLH_MOCK_SKIP_SESSION_LOG}" ]; then exit 0; fi`,
    "SEG=$(pwd | sed -e 's|^/||' -e 's|/$||' -e 's|/|-|g')",
    'SLUG="--$SEG--"',
    'DIR="$DSH_HOME/sessions/$SLUG/session-mock-1"',
    "mkdir -p \"$DIR\"",
    "cp \"$CLH_MOCK_LOG_FIXTURE\" \"$DIR/session.v4.jsonl\"",
    "echo 'final answer'",
  ].join("\n");
  const binPath = path.join(home, "mock-dsh.sh");
  await writeFile(binPath, script, "utf8");
  await chmod(binPath, 0o755);
  await writeFile(path.join(home, "log-fixture.jsonl"), sessionLogFixture(), "utf8");
  return binPath;
}
