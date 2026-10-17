import { readFile } from "node:fs/promises";
import path from "node:path";
import { ClhError } from "./errors.js";
import { resolveModelId, type ClhEnv } from "./env.js";
import { renderJ2 } from "./j2.js";
import { renderPatchYaml, type DshPatchEntry } from "./patch-yaml.js";
import type { HarnessPreset } from "./schema.js";

/** Stable pi-ai provider route the compiler binds the preset model to. */
export const CLH_ROUTE = "polaris-clh";
/** Stable sandbox runner-failure signature of the CLH dispatcher adapter. */
export const DISPATCHER_FAILURE_SIGNATURE = "clh-dispatcher:";

export interface DshCompileInput {
  preset: HarnessPreset;
  /** Directory of the owning preset file; prompt paths resolve against it. */
  presetDir: string;
  taskContext: Record<string, string>;
  env: ClhEnv;
  workspaceRoot: string;
}

export interface CompiledDshRun {
  route: string;
  modelId: string;
  patchYaml: string;
  patchEntries: DshPatchEntry[];
  taskPrompt: string;
  personaPrefix?: string;
  workspaceRoot: string;
}

const DSH_SANDBOX_MODE: Record<string, "read-only" | "workspace-write"> = {
  "read-only": "read-only",
  "workspace-write": "workspace-write",
};

/**
 * Compile one preset + task context into a dsh run: the patch overlay (one
 * YAML document, written to a temp file per call), the rendered prompt, and
 * the exact spawn argv. One-shot, zero persistent state.
 */
export async function compileDshRun(input: DshCompileInput): Promise<CompiledDshRun> {
  const { preset, presetDir, taskContext, env, workspaceRoot } = input;
  const modelId = resolveModelId(preset.model, env);
  if (!env.apiKey) {
    throw new ClhError("CLH_MISSING_CREDENTIAL", "No LLM API key in the environment; export POLARIS_CLH_API_KEY", {
      envVar: "POLARIS_CLH_API_KEY",
    });
  }
  if (!env.endpoint) {
    throw new ClhError("CLH_MISSING_CREDENTIAL", "No LLM endpoint in the environment; export POLARIS_CLH_ENDPOINT", {
      envVar: "POLARIS_CLH_ENDPOINT",
    });
  }

  const { taskPrompt, personaPrefix } = await renderPrompts(preset, presetDir, taskContext);

  const patchEntries = buildPatchEntries(preset, modelId, env, workspaceRoot, personaPrefix);
  const patchYaml = renderPatchYaml(patchEntries);
  assertCompileArtifact({ patchEntries, patchYaml, taskPrompt, modelId });

  return {
    route: CLH_ROUTE,
    modelId,
    patchYaml,
    patchEntries,
    taskPrompt,
    personaPrefix,
    workspaceRoot,
  };
}

/**
 * Build the patch overlay: pi-ai provider route + default model + official
 * deepseek key provider disabled + sandbox policy. The dispatcher seam appends
 * the sandbox runnerCommand patch when a dispatcher adapter is configured.
 */
export function buildPatchEntries(
  preset: HarnessPreset,
  modelId: string,
  env: ClhEnv,
  workspaceRoot: string,
  personaPrefix?: string,
): DshPatchEntry[] {
  const entries: DshPatchEntry[] = [
    {
      id: "llm-pi-ai",
      name: "@deepseek-ai/dsh-llm-pi-ai",
      config: {
        providers: {
          [CLH_ROUTE]: {
            apiKeyEnv: "POLARIS_CLH_API_KEY",
            api: "openai-completions",
            baseURL: env.endpoint as string,
            models: [{ id: modelId }],
          },
        },
      },
    },
    {
      id: "agent-default-model",
      name: "@deepseek-ai/dsh-agent-default-model",
      config: {
        provider: CLH_ROUTE,
        model: modelId,
      },
    },
    {
      id: "llm-deepseek",
      name: "@deepseek-ai/dsh-llm-deepseek-api-key",
      disabled: true,
    },
    {
      id: "sandbox-policy",
      name: "@deepseek-ai/dsh-sandbox-policy",
      config: {
        mode: DSH_SANDBOX_MODE[preset.permission],
        workspaceRoot,
      },
    },
  ];
  if (personaPrefix !== undefined) {
    entries.push({
      id: "system-prompt",
      name: "@deepseek-ai/dsh-system-prompt",
      config: {
        personaPrefix,
      },
    });
  }
  const dispatcher = buildDispatcherPatch(env);
  if (dispatcher) entries.push(dispatcher);
  return entries;
}

/**
 * Dispatcher seam (PRD 3.14.5): open-kind command execution routed through a
 * dispatcher adapter via the dsh sandbox runnerCommand override. Returns the
 * patch entry when a dispatcher adapter binary is configured; otherwise the
 * run degrades to sandbox-policy enforcement alone.
 */
export function buildDispatcherPatch(env: ClhEnv): DshPatchEntry | undefined {
  if (!env.dispatcherBin) return undefined;
  return {
    id: "sandbox",
    name: "@deepseek-ai/dsh-sandbox-local",
    config: {
      runnerCommand: [env.dispatcherBin],
      runnerFailureSignatures: [DISPATCHER_FAILURE_SIGNATURE],
    },
  };
}

async function renderPrompts(
  preset: HarnessPreset,
  presetDir: string,
  taskContext: Record<string, string>,
): Promise<{ taskPrompt: string; personaPrefix?: string }> {
  if (!preset.prompts) {
    return { taskPrompt: renderContextPrompt(taskContext) };
  }
  const userTemplate = await readTemplate(preset.prompts.user, presetDir, "prompts.user");
  const taskPrompt = renderJ2(userTemplate, taskContext);
  let personaPrefix: string | undefined;
  if (preset.prompts.system) {
    const systemTemplate = await readTemplate(preset.prompts.system, presetDir, "prompts.system");
    personaPrefix = renderJ2(systemTemplate, taskContext);
  }
  return { taskPrompt, personaPrefix };
}

/** Render one preset's prompt templates against the task context. */
export async function renderPresetPrompts(
  preset: HarnessPreset,
  presetDir: string,
  taskContext: Record<string, string>,
): Promise<{ taskPrompt: string; personaPrefix?: string }> {
  return renderPrompts(preset, presetDir, taskContext);
}

function renderContextPrompt(taskContext: Record<string, string>): string {
  return Object.entries(taskContext)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

async function readTemplate(relative: string, presetDir: string, field: string): Promise<string> {
  const resolved = path.resolve(presetDir, relative);
  let content: string;
  try {
    content = await readFile(resolved, "utf8");
  } catch (error) {
    throw new ClhError("CLH_OUTPUT_CONTRACT", `Preset ${field} template is unreadable: ${relative}`, {
      field,
      path: resolved,
      cause: String(error),
    });
  }
  return content;
}

/** Required-field validation of the compiled artifact; never silent. */
function assertCompileArtifact(artifact: {
  patchEntries: DshPatchEntry[];
  patchYaml: string;
  taskPrompt: string;
  modelId: string;
}): void {
  const requiredIds = ["llm-pi-ai", "agent-default-model", "llm-deepseek", "sandbox-policy"];
  const presentIds = new Set(artifact.patchEntries.map((entry) => entry.id));
  for (const id of requiredIds) {
    if (!presentIds.has(id)) {
      throw new ClhError("CLH_OUTPUT_CONTRACT", `Compiled patch is missing the required entry: ${id}`, {
        entryId: id,
      });
    }
  }
  if (artifact.patchYaml.trim().length === 0) {
    throw new ClhError("CLH_OUTPUT_CONTRACT", "Compiled patch YAML is empty", {});
  }
  if (artifact.taskPrompt.trim().length === 0) {
    throw new ClhError("CLH_OUTPUT_CONTRACT", "Compiled task prompt is empty", {});
  }
  if (artifact.modelId.trim().length === 0) {
    throw new ClhError("CLH_OUTPUT_CONTRACT", "Compiled model id is empty", {});
  }
}
