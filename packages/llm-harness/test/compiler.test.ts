import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { compilePreset } from "../src/compiler.js";
import { buildPatchEntries, CLH_ROUTE } from "../src/dsh-compiler.js";
import { ClhError } from "../src/errors.js";
import { readEnv, type ClhEnv } from "../src/env.js";
import type { HarnessPreset } from "../src/schema.js";
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

async function loadPresetFixture(name: string): Promise<{ preset: HarnessPreset; presetDir: string }> {
  const presetPath = path.join(fixturesDir, name);
  const raw = await readFile(presetPath, "utf8");
  const { preset } = validatePreset(parse(raw));
  return { preset, presetDir: fixturesDir };
}

test("dsh compiler emits the pi-ai provider patch with the documented shape", async () => {
  const { preset, presetDir } = await loadPresetFixture("preset-bounded.yaml");
  const compiled = await compilePreset({
    preset,
    presetDir,
    taskContext: { CVE_ID: "CVE-SYNTH-0001", LOGS: "synthetic logs" },
    env: syntheticEnv(),
    workspaceRoot: "/tmp/clh-synthetic-workspace",
  });
  assert.equal(compiled.backend, "dsh");
  const providerEntry = compiled.patchEntries.find((entry) => entry.id === "llm-pi-ai");
  assert.ok(providerEntry);
  assert.equal(providerEntry.name, "@deepseek-ai/dsh-llm-pi-ai");
  const providers = (providerEntry.config as Record<string, unknown>)["providers"] as Record<string, unknown>;
  const route = providers[CLH_ROUTE] as Record<string, unknown>;
  assert.equal(route["apiKeyEnv"], "POLARIS_CLH_API_KEY");
  assert.equal(route["api"], "openai-completions");
  assert.equal(route["baseURL"], "https://llm-gateway.example.invalid/v1");
  const models = route["models"] as Array<Record<string, unknown>>;
  assert.deepEqual(models, [{ id: "synthetic-r1-model" }]);
});

test("dsh compiler emits default-model, official provider disabled, and sandbox policy", async () => {
  const { preset, presetDir } = await loadPresetFixture("preset-open.yaml");
  const compiled = await compilePreset({
    preset,
    presetDir,
    taskContext: { CVE_ID: "CVE-SYNTH-0005", LOGS: "synthetic logs" },
    env: syntheticEnv(),
    workspaceRoot: "/tmp/clh-synthetic-workspace",
  });
  assert.equal(compiled.backend, "dsh");
  const entries = compiled.patchEntries;
  const defaultModel = entries.find((entry) => entry.id === "agent-default-model");
  assert.deepEqual(defaultModel?.config, { provider: CLH_ROUTE, model: "synthetic-flash-model" });
  const official = entries.find((entry) => entry.id === "llm-deepseek");
  assert.equal(official?.disabled, true);
  assert.equal(official?.name, "@deepseek-ai/dsh-llm-deepseek-api-key");
  const sandbox = entries.find((entry) => entry.id === "sandbox-policy");
  assert.deepEqual(sandbox?.config, { mode: "workspace-write", workspaceRoot: "/tmp/clh-synthetic-workspace" });
  // No persona prefix without prompts.system rendering an empty context: the
  // fixture templates render, so the system-prompt patch exists.
  const systemPrompt = entries.find((entry) => entry.id === "system-prompt");
  assert.ok(systemPrompt);
});

test("sandbox-policy mode maps permission for bounded and open presets", () => {
  const preset = (permission: HarnessPreset["permission"], tier: "light" | "strong"): Record<string, unknown> => {
    const entries = buildPatchEntries(
      {
        kind: permission === "workspace-write" ? "open" : "bounded",
        model: tier,
        toolBoundary: permission === "workspace-write" ? "full" : "read-only",
        loopCap: 5,
        outputContract: "artifact",
        permission,
      },
      "synthetic-model",
      syntheticEnv(),
      "/tmp/clh-synthetic-workspace",
    );
    const sandbox = entries.find((entry) => entry.id === "sandbox-policy");
    return (sandbox?.config ?? {}) as Record<string, unknown>;
  };
  assert.equal(preset("read-only", "light")["mode"], "read-only");
  assert.equal(preset("workspace-write", "strong")["mode"], "workspace-write");
});

test("compiler renders j2 templates with the task context", async () => {
  const { preset, presetDir } = await loadPresetFixture("preset-bounded.yaml");
  const compiled = await compilePreset({
    preset,
    presetDir,
    taskContext: { CVE_ID: "CVE-SYNTH-0002", LOGS: "synthetic logs", FEEDBACK: "synthetic feedback" },
    env: syntheticEnv(),
    workspaceRoot: "/tmp/clh-synthetic-workspace",
  });
  assert.equal(compiled.backend, "dsh");
  assert.match(compiled.taskPrompt, /CVE-SYNTH-0002/u);
  assert.match(compiled.taskPrompt, /synthetic feedback/u);
  assert.match(compiled.taskPrompt, /synthetic logs/u);
  assert.match(compiled.personaPrefix ?? "", /synthetic critic/u);
});

test("compiler omits the system-prompt patch without a system template", async () => {
  const entries = buildPatchEntries(
    {
      kind: "bounded",
      model: "light",
      toolBoundary: "read-only",
      loopCap: 1,
      outputContract: "precise-json",
      permission: "read-only",
    },
    "synthetic-model",
    syntheticEnv(),
    "/tmp/clh-synthetic-workspace",
  );
  assert.ok(!entries.some((entry) => entry.id === "system-prompt"));
});

test("patch YAML round-trips through the yaml parser", async () => {
  const { preset, presetDir } = await loadPresetFixture("preset-bounded.yaml");
  const compiled = await compilePreset({
    preset,
    presetDir,
    taskContext: { CVE_ID: "CVE-SYNTH-0003", LOGS: "synthetic logs" },
    env: syntheticEnv(),
    workspaceRoot: "/tmp/clh-synthetic-workspace",
  });
  const parsed = parse(compiled.patchYaml) as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(parsed));
  const ids = parsed.map((entry) => entry["id"]);
  for (const id of ["llm-pi-ai", "agent-default-model", "llm-deepseek", "sandbox-policy", "system-prompt"]) {
    assert.ok(ids.includes(id), `patch must include ${id}`);
  }
});

test("compiler fails closed on missing credentials and models", async () => {
  const { preset, presetDir } = await loadPresetFixture("preset-bounded.yaml");
  const noKey = { ...syntheticEnv(), apiKey: undefined };
  await assert.rejects(
    () =>
      compilePreset({
        preset,
        presetDir,
        taskContext: {},
        env: noKey,
        workspaceRoot: "/tmp/clh-synthetic-workspace",
      }),
    (error: unknown) => error instanceof ClhError && error.code === "CLH_MISSING_CREDENTIAL",
  );
  const noEndpoint = { ...syntheticEnv(), endpoint: undefined };
  await assert.rejects(
    () =>
      compilePreset({
        preset,
        presetDir,
        taskContext: {},
        env: noEndpoint,
        workspaceRoot: "/tmp/clh-synthetic-workspace",
      }),
    (error: unknown) => error instanceof ClhError && error.code === "CLH_MISSING_CREDENTIAL",
  );
  const noModel = { ...syntheticEnv(), models: { light: undefined, strong: undefined } };
  await assert.rejects(
    () =>
      compilePreset({
        preset,
        presetDir,
        taskContext: {},
        env: noModel,
        workspaceRoot: "/tmp/clh-synthetic-workspace",
      }),
    (error: unknown) => error instanceof ClhError && error.code === "CLH_MISSING_MODEL",
  );
});

test("compiler fails closed on unreadable prompt templates", async () => {
  const { preset, presetDir } = await loadPresetFixture("preset-bounded.yaml");
  const broken: HarnessPreset = {
    ...preset,
    prompts: { user: "templates/missing.j2" },
  };
  await assert.rejects(
    () =>
      compilePreset({
        preset: broken,
        presetDir,
        taskContext: {},
        env: syntheticEnv(),
        workspaceRoot: "/tmp/clh-synthetic-workspace",
      }),
    (error: unknown) => error instanceof ClhError && error.code === "CLH_OUTPUT_CONTRACT",
  );
});

test("api-kind presets compile to the rendered prompt artifact", async () => {
  const { preset, presetDir } = await loadPresetFixture("preset-api.yaml");
  const compiled = await compilePreset({
    preset,
    presetDir,
    taskContext: { CVE_ID: "CVE-SYNTH-0004", LOGS: "synthetic logs" },
    env: syntheticEnv(),
    workspaceRoot: "/tmp/clh-synthetic-workspace",
  });
  assert.equal(compiled.backend, "api");
  assert.equal(compiled.modelId, "synthetic-flash-model");
  assert.match(compiled.prompt, /CVE-SYNTH-0004/u);
  assert.ok(!("patchYaml" in compiled));
});

test("dispatcher seam emits the sandbox runnerCommand patch only when configured", () => {
  const without = buildPatchEntries(
    {
      kind: "open",
      model: "light",
      toolBoundary: "full",
      loopCap: 60,
      outputContract: "artifact",
      permission: "workspace-write",
    },
    "synthetic-model",
    syntheticEnv(),
    "/tmp/clh-synthetic-workspace",
  );
  assert.ok(!without.some((entry) => entry.id === "sandbox"));

  const withDispatcher = buildPatchEntries(
    {
      kind: "open",
      model: "light",
      toolBoundary: "full",
      loopCap: 60,
      outputContract: "artifact",
      permission: "workspace-write",
    },
    "synthetic-model",
    { ...syntheticEnv(), dispatcherBin: "/usr/local/bin/clh-dispatcher" },
    "/tmp/clh-synthetic-workspace",
  );
  const sandbox = withDispatcher.find((entry) => entry.id === "sandbox");
  assert.ok(sandbox);
  assert.equal(sandbox.name, "@deepseek-ai/dsh-sandbox-local");
  assert.deepEqual(sandbox.config, {
    runnerCommand: ["/usr/local/bin/clh-dispatcher"],
    runnerFailureSignatures: ["clh-dispatcher:"],
  });
});

test("readEnv picks up the documented env chain", () => {
  const env = readEnv({
    POLARIS_CLH_ENDPOINT: "https://synthetic.example.invalid/v1",
    POLARIS_CLH_API_KEY: "sk-synthetic",
    POLARIS_CLH_LIGHT_MODEL: "synthetic-light",
    POLARIS_CLH_STRONG_MODEL: "synthetic-strong",
    POLARIS_CLH_LIGHT_PRICE_INPUT_PER_MTOK: "0.5",
    POLARIS_CLH_LIGHT_PRICE_OUTPUT_PER_MTOK: "2",
    POLARIS_CLH_TIMEOUT_MS: "42",
    POLARIS_CLH_DSH_BIN: "npx",
    POLARIS_CLH_DSH_BIN_ARGS: "-y @deepseek-ai/dsh",
    POLARIS_CLH_DSH_PROFILE: "practice",
    POLARIS_CLH_DSH_HOME: "/tmp/synthetic-dsh-home",
    POLARIS_CLH_ZSTD_BIN: "/usr/bin/zstd",
    POLARIS_CLH_DISPATCHER_URL: "https://dispatcher.example.invalid/exec",
    POLARIS_CLH_DISPATCHER_BIN: "/usr/local/bin/clh-dispatcher",
  });
  assert.equal(env.endpoint, "https://synthetic.example.invalid/v1");
  assert.equal(env.models.light, "synthetic-light");
  assert.equal(env.models.strong, "synthetic-strong");
  assert.deepEqual(env.pricing.light, { inputPerMTok: 0.5, outputPerMTok: 2 });
  assert.equal(env.apiTimeoutMs, 42);
  assert.deepEqual(env.dshBinArgs, ["-y", "@deepseek-ai/dsh"]);
  assert.equal(env.dshProfile, "practice");
  assert.equal(env.dshHome, "/tmp/synthetic-dsh-home");
  assert.equal(env.dispatcherBin, "/usr/local/bin/clh-dispatcher");
});
