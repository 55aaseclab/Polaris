import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { readEnv, resolvePricing, type ModelTier } from "@polaris/llm-harness";

/**
 * PRD 3.14.8 run-start pricing gate: when a flow/run budget is declared, every
 * preset model tier the pack's harness could bill must have resolvable pricing
 * (env override or built-in catalog). Unresolvable pricing means the budget
 * could accrue invisibly (the CVE-2024-4340 live-run finding), so the run
 * fails closed before its first step with the stable code CLH_PRICING_UNRESOLVED.
 * Without a declared budget the gate is a no-op and costUsd stays honestly
 * undefined (behavior unchanged).
 */
export const PRICING_UNRESOLVED_CODE = "CLH_PRICING_UNRESOLVED";

const TIERS: readonly ModelTier[] = ["light", "strong"];

export interface RunPricingGateInput {
  /** Vendored harness preset directory of the pinned pack; undefined = no presets. */
  harnessRoot?: string;
  /** Run-level budget in USD (flow declaration overrides the env fallback); undefined disables the gate. */
  budgetUsd?: number;
  environment: Record<string, string | undefined>;
}

export interface RunPricingGateFailure {
  code: typeof PRICING_UNRESOLVED_CODE;
  values: Record<string, string | number>;
}

/** Stable-code gate verdict: null = run may start, failure = run rejected. */
export function evaluateRunPricingGate(input: RunPricingGateInput): RunPricingGateFailure | null {
  if (input.budgetUsd === undefined) return null;
  const env = readEnv(input.environment);
  const unresolvable: string[] = [];
  for (const tier of harnessPresetTiers(input.harnessRoot)) {
    const modelId = env.models[tier];
    // An unset tier model is not a pricing defect; the CLH_MISSING_MODEL
    // fail-closed path owns it at call time.
    if (!modelId) continue;
    if (!resolvePricing(tier, env)) {
      unresolvable.push(modelId);
    }
  }
  if (unresolvable.length === 0) return null;
  return {
    code: PRICING_UNRESOLVED_CODE,
    values: {
      budgetUsd: input.budgetUsd,
      unresolvedModels: unresolvable.join(","),
    },
  };
}

/** Distinct preset model tiers declared in the pack harness dir. The harness
 * dir is pack-wide (tools resolve presets from it), so it is the preset
 * universe any flow of the pack could bill. Invalid preset files are skipped:
 * preset loading failures stay owned by the tool layer (CVE_PRESET_UNAVAILABLE). */
export function harnessPresetTiers(harnessRoot: string | undefined): ModelTier[] {
  if (!harnessRoot) return [];
  let names: string[];
  try {
    names = fs.readdirSync(harnessRoot).filter((name) => name.endsWith(".yaml")).sort();
  } catch {
    return [];
  }
  const tiers = new Set<ModelTier>();
  for (const name of names) {
    let parsed: unknown;
    try {
      parsed = yaml.load(fs.readFileSync(path.join(harnessRoot, name), "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const model = (parsed as Record<string, unknown>)["model"];
    if (typeof model === "string" && (TIERS as readonly string[]).includes(model)) {
      tiers.add(model as ModelTier);
    }
  }
  return [...tiers];
}
