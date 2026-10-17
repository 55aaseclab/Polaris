import { ClhError } from "./errors.js";
import type { ModelTier } from "./schema.js";

/**
 * CLH env chain. Every endpoint, key, and model id arrives from the process
 * environment; nothing is hardcoded. Missing credentials fail closed.
 *
 * - POLARIS_CLH_ENDPOINT          OpenAI-compatible base URL (api backend + dsh pi-ai patch).
 * - POLARIS_CLH_API_KEY           API key value (api backend + dsh credentials env).
 * - POLARIS_CLH_LIGHT_MODEL       Model id for the light tier (Flash-class).
 * - POLARIS_CLH_STRONG_MODEL      Model id for the strong tier (R1-class).
 * - POLARIS_CLH_LIGHT_PRICE_INPUT_PER_MTOK / _OUTPUT_PER_MTOK     Light-tier pricing (USD per million tokens); optional.
 * - POLARIS_CLH_STRONG_PRICE_INPUT_PER_MTOK / _OUTPUT_PER_MTOK    Strong-tier pricing (USD per million tokens); optional.
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
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

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

/** Cost readback: tokens x tier pricing; unset pricing yields undefined (honest null). */
export function computeCostUsd(
  tokens: { inputTokens: number; outputTokens: number },
  tier: ModelTier,
  env: ClhEnv = readEnv(),
): number | undefined {
  const pricing = env.pricing[tier];
  if (!pricing) return undefined;
  return (
    (tokens.inputTokens / 1_000_000) * pricing.inputPerMTok +
    (tokens.outputTokens / 1_000_000) * pricing.outputPerMTok
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
  return { inputPerMTok, outputPerMTok };
}
