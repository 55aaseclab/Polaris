export const MANAGED_HARNESSES = [
  "ssh",
  "codex",
  "claude",
  "copilot",
  "opencode",
  "pi",
] as const;

export type ManagedHarness = typeof MANAGED_HARNESSES[number];
export type AgentHarness = Exclude<ManagedHarness, "ssh">;

export const LIVE_SWITCHABLE_HARNESSES = [
  "ssh",
  "codex",
  "claude",
  "copilot",
  "opencode",
  "pi",
] as const;
export type LiveSwitchableHarness = typeof LIVE_SWITCHABLE_HARNESSES[number];

export interface HarnessProviderPresetSummary {
  id: string;
  label: string;
  providerName: string;
  baseUrl: string;
  model?: string;
}

export const PRESET_SOURCE_COMMIT =
  "eb847642d0b698edc19121fa13f3cdf7e695d0bb";

const DEFAULT_CODEX_MODEL = "gpt-5.5";

function preset(args: {
  id: string;
  label: string;
  providerName?: string;
  baseUrl?: string;
  model?: string;
}): HarnessProviderPresetSummary {
  return {
    id: args.id,
    label: args.label,
    providerName: args.providerName ?? args.id,
    baseUrl: args.baseUrl ?? "",
    ...(args.model ? { model: args.model } : {}),
  };
}

export const HARNESS_PROVIDER_PRESETS: Record<
  AgentHarness,
  HarnessProviderPresetSummary[]
> = {
  codex: [
    preset({
      id: "openai",
      label: "OpenAI API",
      baseUrl: "https://api.openai.com/v1",
      model: DEFAULT_CODEX_MODEL,
    }),
    preset({
      id: "rightcode",
      label: "RightCode",
      baseUrl: "https://right.codes/codex/v1",
      model: DEFAULT_CODEX_MODEL,
    }),
    preset({
      id: "shengsuanyun",
      label: "Shengsuanyun",
      baseUrl: "https://router.shengsuanyun.com/api/v1",
      model: DEFAULT_CODEX_MODEL,
    }),
    preset({
      id: "patewayai",
      label: "PatewayAI",
      baseUrl: "https://api.pateway.ai/v1",
      model: DEFAULT_CODEX_MODEL,
    }),
    preset({
      id: "ccsub",
      label: "CCSub",
      baseUrl: "https://www.ccsub.net/v1",
      model: DEFAULT_CODEX_MODEL,
    }),
    preset({
      id: "subrouter",
      label: "SubRouter",
      baseUrl: "https://subrouter.ai/v1",
      model: DEFAULT_CODEX_MODEL,
    }),
    preset({
      id: "unity2",
      label: "Unity2.ai",
      baseUrl: "https://api.unity2.ai",
      model: DEFAULT_CODEX_MODEL,
    }),
    preset({
      id: "aigocode",
      label: "AIGoCode",
      baseUrl: "https://api.aigocode.com",
      model: DEFAULT_CODEX_MODEL,
    }),
    preset({
      id: "aicodemirror",
      label: "AICodeMirror",
      baseUrl: "https://api.aicodemirror.com/api/codex/backend-api/codex",
      model: DEFAULT_CODEX_MODEL,
    }),
    preset({
      id: "crazyrouter",
      label: "CrazyRouter",
      baseUrl: "https://cn.crazyrouter.com/v1",
      model: DEFAULT_CODEX_MODEL,
    }),
    preset({
      id: "custom",
      label: "Custom",
      providerName: "custom",
      model: DEFAULT_CODEX_MODEL,
    }),
  ],
  claude: [
    preset({
      id: "anthropic",
      label: "Claude Official",
      providerName: "anthropic",
      baseUrl: "https://api.anthropic.com",
    }),
    preset({
      id: "shengsuanyun",
      label: "Shengsuanyun",
      baseUrl: "https://router.shengsuanyun.com/api",
    }),
    preset({
      id: "patewayai",
      label: "PatewayAI",
      baseUrl: "https://api.pateway.ai",
    }),
    preset({
      id: "ccsub",
      label: "CCSub",
      baseUrl: "https://www.ccsub.net",
    }),
    preset({
      id: "subrouter",
      label: "SubRouter",
      baseUrl: "https://subrouter.ai",
    }),
    preset({
      id: "unity2",
      label: "Unity2.ai",
      baseUrl: "https://api.unity2.ai",
    }),
    preset({
      id: "opencode-go",
      label: "OpenCode Go",
      providerName: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go",
    }),
    preset({
      id: "rightcode",
      label: "RightCode",
      baseUrl: "https://www.right.codes/claude",
    }),
    preset({
      id: "openrouter",
      label: "OpenRouter",
      baseUrl: "https://openrouter.ai/api",
    }),
    preset({
      id: "custom",
      label: "Custom",
      providerName: "custom",
    }),
  ],
  copilot: [
    preset({
      id: "github-copilot",
      label: "GitHub Copilot",
      providerName: "github_copilot",
      baseUrl: "https://api.githubcopilot.com",
    }),
    preset({
      id: "custom",
      label: "Custom",
      providerName: "custom",
    }),
  ],
  opencode: [
    preset({
      id: "openai",
      label: "OpenAI Responses",
      providerName: "@ai-sdk/openai",
      baseUrl: "https://api.openai.com/v1",
      model: DEFAULT_CODEX_MODEL,
    }),
    preset({
      id: "shengsuanyun",
      label: "Shengsuanyun",
      providerName: "@ai-sdk/openai-compatible",
      baseUrl: "https://router.shengsuanyun.com/api/v1",
    }),
    preset({
      id: "ccsub",
      label: "CCSub",
      providerName: "@ai-sdk/openai-compatible",
      baseUrl: "https://www.ccsub.net/v1",
    }),
    preset({
      id: "subrouter",
      label: "SubRouter",
      providerName: "@ai-sdk/openai-compatible",
      baseUrl: "https://subrouter.ai/v1",
    }),
    preset({
      id: "unity2",
      label: "Unity2.ai",
      providerName: "@ai-sdk/openai-compatible",
      baseUrl: "https://api.unity2.ai/v1",
    }),
    preset({
      id: "openrouter",
      label: "OpenRouter",
      providerName: "@ai-sdk/openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
    }),
    preset({
      id: "rightcode",
      label: "RightCode",
      providerName: "@ai-sdk/openai",
      baseUrl: "https://right.codes/codex/v1",
      model: DEFAULT_CODEX_MODEL,
    }),
    preset({
      id: "custom",
      label: "Custom",
      providerName: "@ai-sdk/openai-compatible",
    }),
  ],
  pi: [
    preset({
      id: "anthropic",
      label: "Anthropic Messages",
      providerName: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    }),
    preset({
      id: "openai-responses",
      label: "OpenAI Responses",
      providerName: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      model: DEFAULT_CODEX_MODEL,
    }),
    preset({
      id: "openai-compatible",
      label: "OpenAI Compatible",
      providerName: "openai-completions",
    }),
    preset({
      id: "github-copilot",
      label: "GitHub Copilot",
      providerName: "github_copilot",
      baseUrl: "https://api.githubcopilot.com",
    }),
    preset({
      id: "custom",
      label: "Custom",
      providerName: "custom",
    }),
  ],
};

export function isManagedHarness(value: string): value is ManagedHarness {
  return (MANAGED_HARNESSES as readonly string[]).includes(value);
}

export function isAgentHarness(value: string): value is AgentHarness {
  return value !== "ssh" && isManagedHarness(value);
}

export function supportsLiveCredentialSwitch(
  harness: string,
): harness is LiveSwitchableHarness {
  return (LIVE_SWITCHABLE_HARNESSES as readonly string[]).includes(harness);
}

export function defaultCredentialLabel(harness: ManagedHarness): string {
  switch (harness) {
    case "ssh":
      return "Default SSH key";
    case "codex":
      return "RightCode Codex";
    case "claude":
      return "Claude credential";
    case "copilot":
      return "Copilot credential";
    case "opencode":
      return "OpenCode credential";
    case "pi":
      return "pi credential";
  }
}

export function defaultCredentialProviderName(harness: AgentHarness): string {
  if (harness === "codex") {
    return "rightcode";
  }
  if (harness === "copilot") {
    return "github_copilot";
  }
  if (harness === "opencode") {
    return "@ai-sdk/openai-compatible";
  }
  if (harness === "pi") {
    return "openai-completions";
  }
  return harness;
}

export function providerPresetsForHarness(
  harness: ManagedHarness,
): HarnessProviderPresetSummary[] {
  if (harness === "ssh") {
    return [];
  }
  return HARNESS_PROVIDER_PRESETS[harness].map((presetValue) => ({
    ...presetValue,
  }));
}

export function findHarnessProviderPreset(
  harness: ManagedHarness,
  presetId?: string,
): HarnessProviderPresetSummary | null {
  if (harness === "ssh" || !presetId?.trim()) {
    return null;
  }
  return (
    HARNESS_PROVIDER_PRESETS[harness].find(
      (presetValue) => presetValue.id === presetId.trim(),
    ) ?? null
  );
}
