import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * PRD 3.14.8 built-in model pricing catalog. Prices are data: entries are
 * updated through surgical PRs, each anchored by an official sourceUrl and an
 * asOf date. A family (or model) prefix maps to per-MTok input / cached-input
 * / output prices in USD; gateway model ids resolve by longest prefix match
 * and a miss means the pricing is unresolvable (fail-closed for
 * budget-declaring runs, honest undefined otherwise).
 */
export interface ModelPricingEntry {
  /** Case-sensitive gateway model id prefix; longest match wins. */
  prefix: string;
  /** USD per million input tokens (cache-miss / uncached reads). */
  inputPerMTok: number;
  /** USD per million cached-read input tokens. */
  cachedInputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  currency: string;
  sourceUrl: string;
  asOf: string;
  note?: string;
}

interface CatalogFile {
  schemaVersion: number;
  billingSemantics: Record<string, string>;
  entries: ModelPricingEntry[];
}

let cachedCatalog: CatalogFile | undefined;

function loadCatalog(): CatalogFile {
  if (!cachedCatalog) {
    const file = fileURLToPath(new URL("./model-pricing.json", import.meta.url));
    cachedCatalog = JSON.parse(readFileSync(file, "utf8")) as CatalogFile;
  }
  return cachedCatalog;
}

/** Every catalog entry (for tests and audits). */
export function catalogEntries(): ModelPricingEntry[] {
  return loadCatalog().entries;
}

/** Longest-prefix catalog lookup; no hit means unresolvable (never guessed). */
export function catalogPricingFor(modelId: string): ModelPricingEntry | undefined {
  let best: ModelPricingEntry | undefined;
  for (const entry of loadCatalog().entries) {
    if (
      modelId.startsWith(entry.prefix)
      && (best === undefined || entry.prefix.length > best.prefix.length)
    ) {
      best = entry;
    }
  }
  return best;
}
