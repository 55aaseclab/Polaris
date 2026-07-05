export interface HarnessToolDefinition {
  id: "paseo" | "codex" | "claude" | "copilot" | "opencode" | "pi" | "openspec" | "pnpm";
  packageName: string;
  binName: string;
  harness: boolean;
}

const WORKSPACE_TOOL_CATALOG: HarnessToolDefinition[] = [
  {
    id: "paseo",
    packageName: "@getpaseo/cli@latest",
    binName: "paseo",
    harness: false,
  },
  {
    id: "codex",
    packageName: "@openai/codex",
    binName: "codex",
    harness: true,
  },
  {
    id: "claude",
    packageName: "@anthropic-ai/claude-code",
    binName: "claude",
    harness: true,
  },
  {
    id: "copilot",
    packageName: "@github/copilot",
    binName: "copilot",
    harness: true,
  },
  {
    id: "opencode",
    packageName: "opencode-ai",
    binName: "opencode",
    harness: true,
  },
  {
    id: "pi",
    packageName: "@earendil-works/pi-coding-agent",
    binName: "pi",
    harness: true,
  },
  {
    id: "openspec",
    packageName: "@fission-ai/openspec@latest",
    binName: "openspec",
    harness: false,
  },
  {
    id: "pnpm",
    packageName: "pnpm",
    binName: "pnpm",
    harness: false,
  },
];

export function workspaceToolCatalog(): HarnessToolDefinition[] {
  return [...WORKSPACE_TOOL_CATALOG];
}

export function workspaceHarnessIds(): Array<"codex" | "claude" | "copilot" | "opencode" | "pi"> {
  return WORKSPACE_TOOL_CATALOG.filter((tool) => tool.harness).map((tool) => tool.id) as Array<
    "codex" | "claude" | "copilot" | "opencode" | "pi"
  >;
}

export function workspaceToolPackageSpecs(): string[] {
  return WORKSPACE_TOOL_CATALOG.map((tool) => tool.packageName);
}

export function workspaceNonPaseoToolPackageSpecs(): string[] {
  return WORKSPACE_TOOL_CATALOG
    .filter((tool) => tool.id !== "paseo")
    .map((tool) => tool.packageName);
}

export function workspacePaseoPackageSpec(): string {
  const paseo = WORKSPACE_TOOL_CATALOG.find((tool) => tool.id === "paseo");
  if (!paseo) {
    throw new Error("Paseo tool definition is missing.");
  }
  return paseo.packageName;
}
