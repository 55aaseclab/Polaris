import { ClhError } from "./errors.js";

/** PRD 3.14.2 preset schema. One preset declares one backend call. */
export interface HarnessPreset {
  id?: string;
  title?: string;
  description?: string;
  kind: PresetKind;
  /** Model tier token; resolved through the env chain (POLARIS_CLH_LIGHT_MODEL / POLARIS_CLH_STRONG_MODEL). */
  model: ModelTier;
  toolBoundary: ToolBoundary;
  loopCap: number;
  outputContract: OutputContract;
  permission: PresetPermission;
  /** Per-preset call timeout (PRD 3.14.2): api = per call, dsh = whole session.
   * Falls back to POLARIS_CLH_TIMEOUT_MS, then the built-in default. */
  timeoutMs?: number;
  prompts?: PromptSpec;
}

export type PresetKind = "api" | "bounded" | "open";
export type ModelTier = "light" | "strong";
export type ToolBoundary = "none" | "read-only" | "full";
export type OutputContract = "precise-json" | "artifact";
export type PresetPermission = "read-only" | "workspace-write";

/** Prompt template paths relative to the owning preset file. */
export interface PromptSpec {
  system?: string;
  user: string;
}

const KINDS: readonly PresetKind[] = ["api", "bounded", "open"];
const TIERS: readonly ModelTier[] = ["light", "strong"];
const TOOL_BOUNDARIES: readonly ToolBoundary[] = ["none", "read-only", "full"];
const OUTPUT_CONTRACTS: readonly OutputContract[] = ["precise-json", "artifact"];
const PERMISSIONS: readonly PresetPermission[] = ["read-only", "workspace-write"];

const KNOWN_FIELDS = new Set([
  "id",
  "title",
  "description",
  "kind",
  "model",
  "toolBoundary",
  "loopCap",
  "outputContract",
  "permission",
  "timeoutMs",
  "prompts",
]);

export interface ParsedPreset {
  preset: HarnessPreset;
  warnings: string[];
}

/**
 * Validate one preset object against the PRD 3.14.2 schema and the kind
 * consistency matrix (3.14.3). Illegal presets are rejected with a stable
 * error code; never repaired silently.
 */
export function validatePreset(input: unknown): ParsedPreset {
  const warnings: string[] = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ClhError("CLH_PRESET_INVALID", "Preset must be a YAML mapping", {
      reason: "not-a-mapping",
    });
  }
  const record = input as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (!KNOWN_FIELDS.has(field)) {
      throw new ClhError("CLH_PRESET_UNKNOWN_FIELD", `Preset field is not part of the schema: ${field}`, {
        field,
      });
    }
  }
  for (const field of ["kind", "model", "toolBoundary", "loopCap", "outputContract", "permission"] as const) {
    if (!(field in record)) {
      throw new ClhError("CLH_PRESET_MISSING_FIELD", `Preset field is required: ${field}`, { field });
    }
  }

  const kind = checkEnum(record.kind, KINDS, "kind");
  const model = checkEnum(record.model, TIERS, "model");
  const toolBoundary = checkEnum(record.toolBoundary, TOOL_BOUNDARIES, "toolBoundary");
  const outputContract = checkEnum(record.outputContract, OUTPUT_CONTRACTS, "outputContract");
  const permission = checkEnum(record.permission, PERMISSIONS, "permission");
  const loopCap = checkLoopCap(record.loopCap);
  const timeoutMs = checkTimeoutMs(record.timeoutMs);

  for (const field of ["id", "title", "description"] as const) {
    const value = record[field];
    if (value !== undefined && typeof value !== "string") {
      throw new ClhError("CLH_PRESET_INVALID", `Preset field must be a string: ${field}`, { field });
    }
  }

  const prompts = checkPrompts(record.prompts);

  checkKindConsistency(kind, toolBoundary, permission);

  const preset: HarnessPreset = {
    kind,
    model,
    toolBoundary,
    loopCap,
    outputContract,
    permission,
  };
  for (const field of ["id", "title", "description"] as const) {
    if (record[field] !== undefined) preset[field] = record[field] as string;
  }
  if (timeoutMs !== undefined) preset.timeoutMs = timeoutMs;
  if (prompts) preset.prompts = prompts;

  if (kind === "api" && loopCap !== 1) {
    warnings.push(`loopCap is ignored for api kind (no loop); preset declares ${loopCap}`);
  }

  return { preset, warnings };
}

function checkEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ClhError("CLH_PRESET_INVALID", `Preset field ${field} must be one of: ${allowed.join(", ")}`, {
      field,
      value,
      allowed,
    });
  }
  return value as T;
}

function checkLoopCap(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ClhError("CLH_PRESET_INVALID", "Preset field loopCap must be an integer >= 1", {
      field: "loopCap",
      value,
    });
  }
  return value;
}

function checkTimeoutMs(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ClhError("CLH_PRESET_INVALID", "Preset field timeoutMs must be an integer >= 1", {
      field: "timeoutMs",
      value,
    });
  }
  return value;
}

function checkPrompts(value: unknown): PromptSpec | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ClhError("CLH_PRESET_INVALID", "Preset field prompts must be a mapping", {
      field: "prompts",
    });
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "system" && key !== "user") {
      throw new ClhError("CLH_PRESET_UNKNOWN_FIELD", `Preset prompts field is not part of the schema: ${key}`, {
        field: `prompts.${key}`,
      });
    }
  }
  if (!("user" in record) || typeof record.user !== "string" || record.user.length === 0) {
    throw new ClhError("CLH_PRESET_MISSING_FIELD", "Preset prompts.user is required", {
      field: "prompts.user",
    });
  }
  if (record.system !== undefined && (typeof record.system !== "string" || record.system.length === 0)) {
    throw new ClhError("CLH_PRESET_INVALID", "Preset prompts.system must be a non-empty string", {
      field: "prompts.system",
    });
  }
  return { user: record.user, system: record.system };
}

/** PRD 3.14.3 selection rule: kind fixes tool boundary and sandbox permission. */
function checkKindConsistency(kind: PresetKind, toolBoundary: ToolBoundary, permission: PresetPermission): void {
  const violations: string[] = [];
  if (kind === "api") {
    if (toolBoundary !== "none") {
      violations.push("api kind is a pure LLM call, so toolBoundary must be none");
    }
    if (permission !== "read-only") {
      violations.push("api kind runs no sandbox session, so permission must be read-only");
    }
  }
  if (kind === "bounded") {
    if (toolBoundary === "full") {
      violations.push("bounded kind is a read-only transform, so toolBoundary must be none or read-only");
    }
    if (permission !== "read-only") {
      violations.push("bounded kind runs a read-only sandbox, so permission must be read-only");
    }
  }
  if (kind === "open") {
    if (permission !== "workspace-write") {
      violations.push("open kind runs a writable session, so permission must be workspace-write");
    }
    if (toolBoundary === "none") {
      violations.push("open kind executes with tools, so toolBoundary must be read-only or full");
    }
  }
  if (violations.length > 0) {
    throw new ClhError("CLH_PRESET_KIND_CONFLICT", violations.join("; "), {
      kind,
      toolBoundary,
      permission,
      violations,
    });
  }
}
