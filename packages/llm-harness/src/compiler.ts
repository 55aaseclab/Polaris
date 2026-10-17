import { ClhError } from "./errors.js";
import { requireCredentials, resolveModelId, type ClhEnv } from "./env.js";
import {
  compileDshRun,
  renderPresetPrompts,
  type CompiledDshRun,
} from "./dsh-compiler.js";
import type { HarnessPreset } from "./schema.js";

export interface CompileInput {
  preset: HarnessPreset;
  /** Directory of the owning preset file; prompt paths resolve against it. */
  presetDir: string;
  taskContext: Record<string, string>;
  env: ClhEnv;
  workspaceRoot: string;
}

export type CompiledRun =
  | { backend: "api"; modelId: string; prompt: string; system?: string; warnings: string[] }
  | ({ backend: "dsh"; warnings: string[] } & CompiledDshRun);

/**
 * Compile one preset + task context into its backend artifact. api kind
 * yields the rendered prompt/system pair; bounded/open yield the dsh patch
 * overlay plus the rendered prompt. Both branches fail closed on missing
 * credentials and validate their required artifact fields.
 */
export async function compilePreset(input: CompileInput): Promise<CompiledRun> {
  const { preset, env } = input;
  if (preset.kind === "api") {
    // Fail closed on missing credentials before rendering.
    requireCredentials(env);
    const modelId = resolveModelId(preset.model, env);
    const { taskPrompt, personaPrefix } = await renderPresetPrompts(
      preset,
      input.presetDir,
      input.taskContext,
    );
    assertPromptArtifact(modelId, taskPrompt);
    return {
      backend: "api",
      modelId,
      prompt: taskPrompt,
      system: personaPrefix,
      warnings: [],
    };
  }
  const compiled = await compileDshRun(input);
  return { backend: "dsh", warnings: [], ...compiled };
}

function assertPromptArtifact(modelId: string, prompt: string): void {
  if (modelId.trim().length === 0) {
    throw new ClhError("CLH_OUTPUT_CONTRACT", "Compiled model id is empty", {});
  }
  if (prompt.trim().length === 0) {
    throw new ClhError("CLH_OUTPUT_CONTRACT", "Compiled prompt is empty", {});
  }
}
