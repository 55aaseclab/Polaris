import { ClhError } from "./errors.js";
import { catalogPricingFor, type ModelPricingEntry } from "./pricing.js";
import type { ModelTier } from "./schema.js";

/**
 * CLH env chain. Every endpoint, key, and model id arrives from the process
 * environment; nothing is hardcoded. Missing credentials fail closed.
 *
 * - POLARIS_CLH_ENDPOINT          OpenAI-compatible base URL (api backend + dsh pi-ai patch).
 * - POLARIS_CLH_API_KEY           API key value (api backend + dsh credentials env).
 * - POLARIS_CLH_LIGHT_MODEL       Model id for the light tier (Flash-class).
 * - POLARIS_CLH_STRONG_MODEL      Model id for the strong tier (R1-class).
 * - POLARIS_CLH_LIGHT_PRICE_INPUT_PER_MTOK / _CACHED_PER_MTOK / _OUTPUT_PER_MTOK   Light-tier pricing overrides (USD per million tokens); optional.
 * - POLARIS_CLH_STRONG_PRICE_INPUT_PER_MTOK / _CACHED_PER_MTOK / _OUTPUT_PER_MTOK  Strong-tier pricing overrides (USD per million tokens); optional.
 *   Pricing resolution (PRD 3.14.8): env override > built-in catalog > none.
 *   A cached-price override defaults to the input price (conservative).
 * - POLARIS_CLH_TIMEOUT_MS        Default per-call timeout for the api backend.

 * - POLARIS_CLH_DSH_BIN           dsh launcher (default "dsh"; e.g. "npx" plus POLARIS_CLH_DSH_BIN_ARGS).
 * - POLARIS_CLH_DSH_BIN_ARGS      Extra launcher args appended before dsh flags (e.g. "-y @deepseek-ai/dsh").
 * - POLARIS_CLH_DSH_PROFILE       dsh profile name under $DSH_HOME/profiles (default "headless").
 * - POLARIS_CLH_DSH_HOME          DSH_HOME value passed to the dsh child process.
 * - POLARIS_CLH_ZSTD_BIN          zstd binary for decompressing durable session logs (default "zstd").
 * - POLARIS_CLH_DISPATCHER_URL    Dispatcher endpoint the exec adapter forwards commands to.
 * - POLARIS_CLH_DISPATCHER_BIN    Exec adapter binary emitted into the dsh sandbox runnerCommand seam.
 */
export interface ClhEnv {
  endpoint?: string;
  apiKey?: string;
  models: Record<ModelTier, string | undefined>;
  pricing: Partial<Record<ModelTier, TokenPricing>>;
  apiTimeoutMs: number;
  dshBin: string;
  dshBinArgs: string[];
  dshProfile: string;
  dshHome?: string;
  zstdBin: string;
  dispatcherUrl?: string;
  dispatcherBin?: string;
}

export interface TokenPricing {
  /** USD per million input tokens (cache-miss / uncached reads). */
  inputPerMTok: number;
  /** USD per million cached-read input tokens; defaults to inputPerMTok. */
  cachedInputPerMTok?: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

/** How the usage disclosure relates cached reads to prompt tokens (PRD 3.14.8).
 * - prompt-includes-cached: OpenAI semantics; prompt_tokens covers cached_tokens,
 *   so the uncached input side is (input - cached).
 * - cached-separate: dsh session-log semantics; cached is its own bucket
 *   (total = input + output + cached) and inputTokens already excludes it. */
export type UsageSemantics = "prompt-includes-cached" | "cached-separate";

/** Token usage disclosure with the cache-read split (PRD 3.14.8). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Cache-read tokens; 0/undefined when the source disclosed none. */
  cachedTokens?: number;
}

/** One resolved pricing decision: where it came from and the effective rates. */
export type ResolvedPricing =
  | {
      source: "env";
      tier: ModelTier;
      inputPerMTok: number;
      cachedInputPerMTok: number;
      outputPerMTok: number;
    }
  | ({ source: "catalog" } & ModelPricingEntry);

export const DEFAULT_API_TIMEOUT_MS = 120_000;
export const DEFAULT_DSH_BIN = "dsh";
export const DEFAULT_DSH_PROFILE = "headless";
export const DEFAULT_ZSTD_BIN = "zstd";

export function readEnv(env: NodeJS.ProcessEnv = process.env): ClhEnv {
  return {
    endpoint: optionalString(env["POLARIS_CLH_ENDPOINT"]),
    apiKey: optionalString(env["POLARIS_CLH_API_KEY"]),
    models: {
      light: optionalString(env["POLARIS_CLH_LIGHT_MODEL"]),
      strong: optionalString(env["POLARIS_CLH_STRONG_MODEL"]),
    },
    pricing: {
      light: readPricing(env, "LIGHT"),
      strong: readPricing(env, "STRONG"),
    },
    apiTimeoutMs: readInt(env["POLARIS_CLH_TIMEOUT_MS"], DEFAULT_API_TIMEOUT_MS),
    dshBin: optionalString(env["POLARIS_CLH_DSH_BIN"]) ?? DEFAULT_DSH_BIN,
    dshBinArgs: parseArgs(env["POLARIS_CLH_DSH_BIN_ARGS"]),
    dshProfile: optionalString(env["POLARIS_CLH_DSH_PROFILE"]) ?? DEFAULT_DSH_PROFILE,
    dshHome: optionalString(env["POLARIS_CLH_DSH_HOME"]),
    zstdBin: optionalString(env["POLARIS_CLH_ZSTD_BIN"]) ?? DEFAULT_ZSTD_BIN,
    dispatcherUrl: optionalString(env["POLARIS_CLH_DISPATCHER_URL"]),
    dispatcherBin: optionalString(env["POLARIS_CLH_DISPATCHER_BIN"]),
  };
}

/**
 * Resolve one preset model tier to a concrete model id. Missing tier
 * environment entries fail closed (PRD 3.11.4) — no silent fallback.
 */
export function resolveModelId(tier: ModelTier, env: ClhEnv = readEnv()): string {
  const model = env.models[tier];
  if (!model) {
    throw new ClhError("CLH_MISSING_MODEL", `Model tier ${tier} has no environment entry; export POLARIS_CLH_${tier.toUpperCase()}_MODEL`, {
      tier,
      envVar: `POLARIS_CLH_${tier.toUpperCase()}_MODEL`,
    });
  }
  return model;
}

/** Endpoint + key fail closed before any backend call. */
export function requireCredentials(env: ClhEnv = readEnv()): { endpoint: string; apiKey: string } {
  if (!env.endpoint) {
    throw new ClhError("CLH_MISSING_CREDENTIAL", "No LLM endpoint in the environment; export POLARIS_CLH_ENDPOINT", {
      envVar: "POLARIS_CLH_ENDPOINT",
    });
  }
  if (!env.apiKey) {
    throw new ClhError("CLH_MISSING_CREDENTIAL", "No LLM API key in the environment; export POLARIS_CLH_API_KEY", {
      envVar: "POLARIS_CLH_API_KEY",
    });
  }
  assertEndpoint(env.endpoint);
  return { endpoint: env.endpoint, apiKey: env.apiKey };
}

export function assertEndpoint(endpoint: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ClhError("CLH_ENDPOINT_INVALID", `LLM endpoint is not a valid URL: ${endpoint}`, {
      endpoint,
    });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ClhError("CLH_ENDPOINT_INVALID", `LLM endpoint must use http(s): ${endpoint}`, {
      endpoint,
    });
  }
}

/**
 * PRD 3.14.8 pricing resolution for one tier's gateway model id:
 * env override > built-in catalog (longest prefix match) > unresolvable.
 * Returns undefined when the tier model id is unset or no source covers it;
 * callers decide between honest-undefined cost readback and fail-closed.
 */
export function resolvePricing(
  tier: ModelTier,
  env: ClhEnv = readEnv(),
): ResolvedPricing | undefined {
  const modelId = env.models[tier];
  if (!modelId) return undefined;
  const override = env.pricing[tier];
  if (override) {
    return {
      source: "env",
      tier,
      inputPerMTok: override.inputPerMTok,
      // Without a catalog entry the cached rate is unknowable; billing cached
      // reads at the input rate is the conservative default (over-estimates,
      // never under-bills).
      cachedInputPerMTok: override.cachedInputPerMTok ?? override.inputPerMTok,
      outputPerMTok: override.outputPerMTok,
    };
  }
  const entry = catalogPricingFor(modelId);
  if (!entry) return undefined;
  return { source: "catalog", ...entry };
}

/** Cost readback (PRD 3.14.8): tokens x resolved pricing under the source's
 * usage semantics; unresolved pricing yields undefined (honest null). */
export function computeCostUsd(
  tokens: TokenUsage,
  tier: ModelTier,
  env: ClhEnv = readEnv(),
  semantics: UsageSemantics = "prompt-includes-cached",
): number | undefined {
  const resolved = resolvePricing(tier, env);
  if (!resolved) return undefined;
  const cachedTokens = tokens.cachedTokens !== undefined && Number.isFinite(tokens.cachedTokens)
    ? Math.max(0, tokens.cachedTokens)
    : 0;
  // prompt-includes-cached: the uncached input side is what prompt_tokens
  // reports minus the cached reads; cached-separate: inputTokens already
  // excludes cached reads, so every input token bills at the input rate.
  const uncachedInputTokens = semantics === "prompt-includes-cached"
    ? Math.max(0, tokens.inputTokens - cachedTokens)
    : tokens.inputTokens;
  return (
    (uncachedInputTokens / 1_000_000) * resolved.inputPerMTok
    + (cachedTokens / 1_000_000) * resolved.cachedInputPerMTok
    + (tokens.outputTokens / 1_000_000) * resolved.outputPerMTok
  );
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/\s+/u).filter((part) => part.length > 0);
}

function readPricing(env: NodeJS.ProcessEnv, tier: string): TokenPricing | undefined {
  const input = optionalString(env[`POLARIS_CLH_${tier}_PRICE_INPUT_PER_MTOK`]);
  const output = optionalString(env[`POLARIS_CLH_${tier}_PRICE_OUTPUT_PER_MTOK`]);
  if (!input || !output) return undefined;
  const inputPerMTok = Number.parseFloat(input);
  const outputPerMTok = Number.parseFloat(output);
  if (!Number.isFinite(inputPerMTok) || !Number.isFinite(outputPerMTok)) return undefined;
  const cached = optionalString(env[`POLARIS_CLH_${tier}_PRICE_CACHED_PER_MTOK`]);
  if (cached === undefined) {
    return { inputPerMTok, outputPerMTok };
  }
  const cachedInputPerMTok = Number.parseFloat(cached);
  if (!Number.isFinite(cachedInputPerMTok) || cachedInputPerMTok < 0) {
    return { inputPerMTok, outputPerMTok };
  }
  return { inputPerMTok, cachedInputPerMTok, outputPerMTok };
}
