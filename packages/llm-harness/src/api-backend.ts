import { ClhError } from "./errors.js";
import { computeCostUsd, readEnv, requireCredentials, resolveModelId, type ClhEnv } from "./env.js";
import type { HarnessPreset } from "./schema.js";

export interface ApiCallOptions {
  preset: HarnessPreset;
  system?: string;
  prompt: string;
  env?: ClhEnv;
  /** Per-call timeout in milliseconds; overrides POLARIS_CLH_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ApiCallReceipt {
  text: string;
  model: string;
  endpoint: string;
  costUsd?: number;
  tokens?: { inputTokens: number; outputTokens: number; totalTokens?: number };
  durationMs: number;
  finishReason?: string;
}

/**
 * api-kind backend: one direct OpenAI-compatible chat call. No tools, no
 * loop, no session. Endpoint/key/model resolve from the env chain; missing
 * credentials fail closed before any request. costUsd reads back from the
 * provider usage disclosure and tier pricing (undefined when pricing is not
 * configured).
 */
export async function callApiPreset(options: ApiCallOptions): Promise<ApiCallReceipt> {
  const env = options.env ?? readEnv();
  const fetchImpl = options.fetchImpl ?? fetch;
  const { endpoint, apiKey } = requireCredentials(env);
  const model = resolveModelId(options.preset.model, env);
  const timeoutMs = options.timeoutMs ?? env.apiTimeoutMs;

  const messages: Array<{ role: string; content: string }> = [];
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: "system", content: options.system });
  }
  messages.push({ role: "user", content: options.prompt });

  const body = JSON.stringify({ model, messages, stream: false });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(`${endpoint.replace(/\/+$/u, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ClhError("CLH_API_TIMEOUT", `LLM call exceeded timeoutMs=${timeoutMs}`, { timeoutMs });
    }
    throw new ClhError("CLH_API_STATUS", `LLM call failed: ${String(error)}`, { cause: String(error) });
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - startedAt;
  if (!response.ok) {
    const snippet = (await response.text()).slice(0, 400);
    throw new ClhError("CLH_API_STATUS", `LLM endpoint returned ${response.status}: ${snippet}`, {
      status: response.status,
      body: snippet,
    });
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const choices = payload["choices"];
  const text = extractText(choices);
  if (text === undefined) {
    throw new ClhError("CLH_OUTPUT_CONTRACT", "LLM endpoint response carries no assistant text", {});
  }
  const usage = readUsage(payload["usage"]);
  const receipt: ApiCallReceipt = {
    text,
    model,
    endpoint,
    durationMs,
    tokens: usage,
  };
  if (usage) {
    receipt.costUsd = computeCostUsd(
      { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      options.preset.model,
      env,
    );
  }
  const finishReason = readFinishReason(choices);
  if (finishReason) receipt.finishReason = finishReason;
  enforceOutputContractApi(options.preset.outputContract, receipt.text);
  return receipt;
}

function extractText(choices: unknown): string | undefined {
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (!first || typeof first !== "object") return undefined;
  const message = (first as Record<string, unknown>)["message"];
  if (!message || typeof message !== "object") return undefined;
  const content = (message as Record<string, unknown>)["content"];
  return typeof content === "string" ? content : undefined;
}

function readFinishReason(choices: unknown): string | undefined {
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (!first || typeof first !== "object") return undefined;
  const reason = (first as Record<string, unknown>)["finish_reason"];
  return typeof reason === "string" ? reason : undefined;
}

interface ApiUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}

function readUsage(value: unknown): ApiUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const promptTokens = record["prompt_tokens"];
  const completionTokens = record["completion_tokens"];
  if (typeof promptTokens !== "number" || typeof completionTokens !== "number") return undefined;
  const total = record["total_tokens"];
  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens: typeof total === "number" ? total : promptTokens + completionTokens,
  };
}

function enforceOutputContractApi(contract: HarnessPreset["outputContract"], text: string): void {
  if (contract === "precise-json") {
    try {
      JSON.parse(text);
    } catch {
      throw new ClhError("CLH_OUTPUT_CONTRACT", "precise-json contract requires the completion to parse as JSON", {});
    }
  }
}
