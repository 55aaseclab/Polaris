import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogEntries,
  catalogPricingFor,
  computeCostUsd,
  resolvePricing,
  type ClhEnv,
} from "../src/index.js";

const DEEPSEEK_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";
const GLM_MODEL = "zai-org/GLM-5.3-Flash";
const GLM_X_MODEL = "zai-org/GLM-5.3-FlashX";
const UNCATALOGED_MODEL = "openai/gpt-oss-20b";

function envWith(input: {
  strongModel?: string;
  strongPricing?: ClhEnv["pricing"]["strong"];
}): ClhEnv {
  return {
    models: { light: "synthetic-flash-model", strong: input.strongModel },
    pricing: { strong: input.strongPricing },
    apiTimeoutMs: 2000,
    dshBin: "dsh",
    dshBinArgs: [],
    dshProfile: "headless",
    zstdBin: "zstd",
  };
}

function approxEqual(actual: number | undefined, expected: number, epsilon = 1e-12): void {
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < epsilon,
    `expected ~${expected}, got ${actual}`,
  );
}

test("catalog resolves gateway model ids by longest prefix match", () => {
  const deepseek = catalogPricingFor(DEEPSEEK_MODEL);
  assert.ok(deepseek);
  assert.equal(deepseek.inputPerMTok, 0.3);
  assert.equal(deepseek.cachedInputPerMTok, 0.006);
  assert.equal(deepseek.outputPerMTok, 1.2);
  // The FlashX entry must win over the shorter Flash prefix.
  const flashX = catalogPricingFor(GLM_X_MODEL);
  assert.ok(flashX);
  assert.equal(flashX.inputPerMTok, 0.37);
  const flash = catalogPricingFor(GLM_MODEL);
  assert.ok(flash);
  assert.equal(flash.inputPerMTok, 0.15);
  assert.equal(flash.outputPerMTok, 0.5);
});

test("catalog has no entry for families without a verifiable official price", () => {
  assert.equal(catalogPricingFor(UNCATALOGED_MODEL), undefined);
  assert.equal(catalogPricingFor("swiss-ai/APT-Synthetic-Model"), undefined);
  // Mistral Small 3.2 no longer appears on the current mistral.ai pricing page.
  assert.equal(catalogPricingFor("mistralai/Mistral-Small-3.2"), undefined);
});

test("every catalog entry carries USD pricing with an official source and as-of date", () => {
  const entries = catalogEntries();
  assert.ok(entries.length >= 3);
  for (const entry of entries) {
    assert.equal(entry.currency, "USD");
    assert.match(entry.sourceUrl, /^https:\/\//u);
    assert.match(entry.asOf, /^\d{4}-\d{2}-\d{2}$/u);
    assert.ok(entry.inputPerMTok > 0);
    assert.ok(entry.cachedInputPerMTok > 0);
    assert.ok(entry.outputPerMTok > 0);
  }
});

test("pricing resolution order is env override, then catalog, then unresolvable", () => {
  const override: NonNullable<ClhEnv["pricing"]["strong"]> = {
    inputPerMTok: 9,
    cachedInputPerMTok: 0.9,
    outputPerMTok: 90,
  };
  const envOverride = envWith({ strongModel: GLM_MODEL, strongPricing: override });
  const resolvedOverride = resolvePricing("strong", envOverride);
  assert.ok(resolvedOverride);
  assert.equal(resolvedOverride.source, "env");
  assert.equal(resolvedOverride.inputPerMTok, 9);
  assert.equal(resolvedOverride.outputPerMTok, 90);

  const envCatalog = envWith({ strongModel: GLM_MODEL });
  const resolvedCatalog = resolvePricing("strong", envCatalog);
  assert.ok(resolvedCatalog);
  assert.equal(resolvedCatalog.source, "catalog");
  assert.equal(resolvedCatalog.inputPerMTok, 0.15);
  assert.equal(resolvedCatalog.cachedInputPerMTok, 0.03);
  assert.equal(resolvedCatalog.outputPerMTok, 0.5);

  const envNone = envWith({ strongModel: UNCATALOGED_MODEL });
  assert.equal(resolvePricing("strong", envNone), undefined);
  assert.equal(resolvePricing("strong", envWith({})), undefined);
});

test("an env override without a cached rate defaults cached reads to the input rate", () => {
  const env = envWith({
    strongModel: UNCATALOGED_MODEL,
    strongPricing: { inputPerMTok: 0.3, outputPerMTok: 1.2 },
  });
  const resolved = resolvePricing("strong", env);
  assert.ok(resolved);
  assert.equal(resolved.source, "env");
  assert.equal(resolved.cachedInputPerMTok, 0.3);
  approxEqual(
    computeCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 400_000 }, "strong", env),
    0.3,
  );
});

test("api semantics (prompt includes cached) price the 888K cached split at the cached rate", () => {
  // Live-run shape: 922K prompt tokens of which 888K were cache reads, 25K out.
  const env = envWith({ strongModel: DEEPSEEK_MODEL });
  const costUsd = computeCostUsd(
    { inputTokens: 922_000, outputTokens: 25_000, cachedTokens: 888_000 },
    "strong",
    env,
    "prompt-includes-cached",
  );
  // (922000 - 888000) x $0.3 + 888000 x $0.006 + 25000 x $1.2, all per MTok.
  approxEqual(costUsd, 0.0102 + 0.005328 + 0.03);
  // The 50x deviation guard: billing the cached bucket at the input rate
  // (the silent failure mode) would overshoot by exactly the cached tokens
  // times the rate gap.
  const mispriced = 0.0102 + (888_000 / 1e6) * 0.3 + 0.03;
  approxEqual(mispriced - (costUsd as number), (888_000 / 1e6) * (0.3 - 0.006));
});

test("dsh semantics (cached separate bucket) bill input and cached independently", () => {
  const env = envWith({ strongModel: DEEPSEEK_MODEL });
  // dsh session-log shape: total = input + output + cached; input already
  // excludes the 888K cached reads.
  const costUsd = computeCostUsd(
    { inputTokens: 34_000, outputTokens: 25_000, cachedTokens: 888_000 },
    "strong",
    env,
    "cached-separate",
  );
  approxEqual(costUsd, 0.0102 + 0.005328 + 0.03);
});

test("cached extraction three states feed both billing semantics", () => {
  const env = envWith({ strongModel: DEEPSEEK_MODEL });
  // Disclosed cached reads.
  approxEqual(
    computeCostUsd({ inputTokens: 500, outputTokens: 100, cachedTokens: 300 }, "strong", env, "prompt-includes-cached"),
    (200 / 1e6) * 0.3 + (300 / 1e6) * 0.006 + (100 / 1e6) * 1.2,
  );
  // No disclosure: cached defaults to zero, every input token bills at the input rate.
  approxEqual(
    computeCostUsd({ inputTokens: 500, outputTokens: 100 }, "strong", env, "prompt-includes-cached"),
    (500 / 1e6) * 0.3 + (100 / 1e6) * 1.2,
  );
  approxEqual(
    computeCostUsd({ inputTokens: 500, outputTokens: 100, cachedTokens: undefined }, "strong", env, "cached-separate"),
    (500 / 1e6) * 0.3 + (100 / 1e6) * 1.2,
  );
  // Disclosed zero: same as no disclosure.
  approxEqual(
    computeCostUsd({ inputTokens: 500, outputTokens: 100, cachedTokens: 0 }, "strong", env, "prompt-includes-cached"),
    (500 / 1e6) * 0.3 + (100 / 1e6) * 1.2,
  );
  // Semantics mismatch must be visible: feeding the dsh shape through the api
  // semantics clamps the negative uncached input side to zero instead of
  // billing cached reads twice.
  approxEqual(
    computeCostUsd({ inputTokens: 34_000, outputTokens: 25_000, cachedTokens: 888_000 }, "strong", env, "prompt-includes-cached"),
    (888_000 / 1e6) * 0.006 + (25_000 / 1e6) * 1.2,
  );
});

test("costUsd stays honestly undefined when pricing is unresolvable", () => {
  const env = envWith({ strongModel: UNCATALOGED_MODEL });
  assert.equal(
    computeCostUsd({ inputTokens: 500, outputTokens: 100, cachedTokens: 300 }, "strong", env),
    undefined,
  );
});
