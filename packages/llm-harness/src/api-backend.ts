import { ClhError } from "./errors.js";
import { computeCostUsd, readEnv, requireCredentials, resolveModelId, type ClhEnv } from "./env.js";
import type { HarnessPreset } from "./schema.js";

export interface ApiCallOptions {
  preset: HarnessPreset;
  system?: string;
  prompt: string;
  env?: ClhEnv;
  /** Per-call timeout in milliseconds; overrides preset.timeoutMs and POLARIS_CLH_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Call-level retry policy (PRD 3.14.4); defaults to bounded exponential backoff. */
  retry?: ApiRetryPolicy;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ApiRetryPolicy {
  /** Total attempts including the first; default 3. */
  maxAttempts?: number;
  /** Base delay for the exponential backoff; default 500ms. */
  baseDelayMs?: number;
  /** Jitter source in [0,1); defaults to Math.random. */
  random?: () => number;
}

export interface ApiCallReceipt {
  text: string;
  model: string;
  endpoint: string;
  costUsd?: number;
  tokens?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    /** PRD 3.14.8: cache-read tokens from usage.prompt_tokens_details. */
    cachedTokens?: number;
  };
  durationMs: number;
  finishReason?: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 500;
const MAX_BACKOFF_DELAY_MS = 8_000;

/**
 * api-kind backend: one direct OpenAI-compatible chat call, streamed (SSE,
 * PRD 3.14.3) so minute-scale generations survive gateway idle cutoffs.
 * No tools, no loop, no session. Endpoint/key/model resolve from the env
 * chain; missing credentials fail closed before any request. 429 and
 * transient transport failures back off with bounded exponential + jitter
 * inside the timeoutMs budget (PRD 3.14.4); everything else fails closed.
 * costUsd reads back from the provider usage disclosure and tier pricing
 * (undefined when pricing is not configured).
 */
export async function callApiPreset(options: ApiCallOptions): Promise<ApiCallReceipt> {
  const env = options.env ?? readEnv();
  const fetchImpl = options.fetchImpl ?? fetch;
  const { endpoint, apiKey } = requireCredentials(env);
  const model = resolveModelId(options.preset.model, env);
  const timeoutMs = options.timeoutMs ?? options.preset.timeoutMs ?? env.apiTimeoutMs;

  const messages: Array<{ role: string; content: string }> = [];
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: "system", content: options.system });
  }
  messages.push({ role: "user", content: options.prompt });

  const body = JSON.stringify({
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  });
  const url = `${endpoint.replace(/\/+$/u, "")}/chat/completions`;

  const policy = options.retry ?? {};
  const maxAttempts = Math.max(1, Math.floor(policy.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const baseDelayMs = Math.max(0, policy.baseDelayMs ?? DEFAULT_BACKOFF_BASE_MS);
  const random = policy.random ?? Math.random;

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastError: ClhError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw timeoutError(timeoutMs, startedAt, options.preset.model, attempt - 1);
    }
    try {
      return await attemptOnce({
        fetchImpl,
        url,
        body,
        apiKey,
        model,
        endpoint,
        env,
        preset: options.preset,
        remainingMs,
        startedAt,
        timeoutMs,
        attempt,
      });
    } catch (error) {
      lastError = error instanceof ClhError
        ? error
        : new ClhError("CLH_API_STATUS", `LLM call failed: ${String(error)}`, { cause: String(error) });
      if (!isTransient(lastError) || attempt >= maxAttempts) {
        throw withAttempts(lastError, attempt);
      }
      const remaining = deadline - Date.now();
      const delay = backoffDelayMs(baseDelayMs, attempt, random, retryAfterOf(lastError));
      if (delay >= remaining) {
        throw withAttempts(lastError, attempt);
      }
      await sleep(delay);
    }
  }
  throw withAttempts(lastError ?? timeoutError(timeoutMs, startedAt, options.preset.model, maxAttempts), maxAttempts);
}

interface AttemptArgs {
  fetchImpl: typeof fetch;
  url: string;
  body: string;
  apiKey: string;
  model: string;
  endpoint: string;
  env: ClhEnv;
  preset: HarnessPreset;
  remainingMs: number;
  startedAt: number;
  timeoutMs: number;
  attempt: number;
}

/** One request + full body consumption; aborts map to CLH_API_TIMEOUT. */
async function attemptOnce(args: AttemptArgs): Promise<ApiCallReceipt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.remainingMs);
  try {
    let response: Response;
    try {
      response = await args.fetchImpl(args.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${args.apiKey}`,
        },
        body: args.body,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw timeoutError(args.timeoutMs, args.startedAt, args.preset.model, args.attempt);
      }
      throw new ClhError("CLH_API_STATUS", `LLM call failed: ${String(error)}`, { cause: String(error) });
    }

    if (!response.ok) {
      const snippet = (await response.text()).slice(0, 400);
      const details: Record<string, unknown> = { status: response.status, body: snippet };
      const retryAfter = retryAfterMs(response.headers);
      if (response.status === 429 && retryAfter !== undefined) {
        details["retryAfterMs"] = retryAfter;
      }
      throw new ClhError(
        "CLH_API_STATUS",
        `LLM endpoint returned ${response.status}: ${snippet}`,
        details,
      );
    }

    try {
      return await readReceipt(response, args);
    } catch (error) {
      if (controller.signal.aborted) {
        throw timeoutError(args.timeoutMs, args.startedAt, args.preset.model, args.attempt);
      }
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Parse the streamed or buffered completion body into the receipt. */
async function readReceipt(response: Response, args: AttemptArgs): Promise<ApiCallReceipt> {
  const stream = readStreamBody(response);
  const streamResult = stream
    ? await consumeSseStream(stream)
    : await consumeJsonBody(response);
  if (streamResult.text === undefined) {
    throw new ClhError("CLH_OUTPUT_CONTRACT", "LLM endpoint response carries no assistant text", {});
  }
  const receipt: ApiCallReceipt = {
    text: streamResult.text,
    model: args.model,
    endpoint: args.endpoint,
    durationMs: Date.now() - args.startedAt,
    ...(streamResult.usage ? { tokens: streamResult.usage } : {}),
  };
  if (streamResult.usage) {
    // PRD 3.14.8: OpenAI usage semantics — prompt_tokens includes the cached
    // reads, so computeCostUsd bills (input - cached) at the input rate.
    receipt.costUsd = computeCostUsd(
      {
        inputTokens: streamResult.usage.inputTokens,
        outputTokens: streamResult.usage.outputTokens,
        cachedTokens: streamResult.usage.cachedTokens,
      },
      args.preset.model,
      args.env,
      "prompt-includes-cached",
    );
  }
  if (streamResult.finishReason) receipt.finishReason = streamResult.finishReason;
  receipt.text = enforceOutputContractApi(args.preset.outputContract, receipt.text);
  return receipt;
}

/**
 * Extract the outermost JSON value from model prose. Thinking models commonly
 * wrap JSON payloads in markdown fences or lead with prose; strict parsing at
 * the platform layer would reject valid payloads (PRD 3.14 output contract).
 * Returns the normalized payload, or undefined when nothing parses.
 */
export function extractJsonPayload(text: string): string | undefined {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fence?.[1]) candidates.push(fence[1].trim());
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function readStreamBody(response: Response): ReadableStream<Uint8Array> | undefined {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) return undefined;
  return response.body ?? undefined;
}

async function consumeJsonBody(response: Response): Promise<StreamResult> {
  const payload = (await response.json()) as Record<string, unknown>;
  const choices = payload["choices"];
  const text = extractText(choices);
  const usage = readUsage(payload["usage"]);
  const finishReason = readFinishReason(choices);
  return { text, ...(usage ? { usage } : {}), ...(finishReason ? { finishReason } : {}) };
}

interface StreamResult {
  text: string | undefined;
  usage?: ApiUsage;
  finishReason?: string;
}

/** Consume an SSE body: accumulate delta content, usage disclosure, finish reason. */
async function consumeSseStream(body: ReadableStream<Uint8Array>): Promise<StreamResult> {
  const result: StreamResult = { text: undefined };
  let sawContent = false;
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  const consume = (payload: Record<string, unknown>): void => {
    const usage = readUsage(payload["usage"]);
    if (usage) result.usage = usage;
    const choices = payload["choices"];
    if (!Array.isArray(choices) || choices.length === 0) return;
    const first = choices[0];
    if (!first || typeof first !== "object") return;
    const record = first as Record<string, unknown>;
    const delta = record["delta"];
    if (delta && typeof delta === "object") {
      const content = (delta as Record<string, unknown>)["content"];
      if (typeof content === "string") {
        result.text = (result.text ?? "") + content;
        sawContent = true;
      }
    }
    const reason = record["finish_reason"];
    if (typeof reason === "string") result.finishReason = reason;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        consumeSseLine(buffer.slice(0, newlineIndex), consume);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    for (const line of buffer.split("\n")) consumeSseLine(line, consume);
  } finally {
    reader.releaseLock();
  }
  return sawContent || result.usage || result.finishReason
    ? { text: result.text ?? "", ...(result.usage ? { usage: result.usage } : {}), ...(result.finishReason ? { finishReason: result.finishReason } : {}) }
    : { text: undefined };
}

function consumeSseLine(
  rawLine: string,
  consume: (payload: Record<string, unknown>) => void,
): void {
  const line = rawLine.replace(/\r$/u, "");
  if (!line.startsWith("data:")) return;
  const payload = line.slice(5).trim();
  if (payload.length === 0 || payload === "[DONE]") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new ClhError("CLH_API_STATUS", "SSE data line is not valid JSON", {
      sseChunk: true,
      line: payload.slice(0, 200),
    });
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    consume(parsed as Record<string, unknown>);
  }
}

/** 429 and transport-level failures retry; HTTP-level contract failures do not. */
function isTransient(error: ClhError): boolean {
  if (error.code === "CLH_API_TIMEOUT") return false;
  if (error.code !== "CLH_API_STATUS") return false;
  if (error.details["sseChunk"]) return false;
  const status = error.details["status"];
  if (typeof status === "number") return status === 429;
  return true;
}

function retryAfterOf(error: ClhError): number | undefined {
  const value = error.details["retryAfterMs"];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Exponential backoff with full jitter; an explicit Retry-After wins. */
function backoffDelayMs(
  baseDelayMs: number,
  attempt: number,
  random: () => number,
  retryAfterMsValue: number | undefined,
): number {
  const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), MAX_BACKOFF_DELAY_MS);
  const jittered = random() * exponential;
  return retryAfterMsValue !== undefined
    ? Math.max(retryAfterMsValue, jittered)
    : jittered;
}

function timeoutError(timeoutMs: number, startedAt: number, tier: string, attempts: number): ClhError {
  return new ClhError("CLH_API_TIMEOUT", `LLM call exceeded timeoutMs=${timeoutMs}`, {
    timeoutMs,
    elapsedMs: Date.now() - startedAt,
    tier,
    attempts,
  });
}

function withAttempts(error: ClhError, attempts: number): ClhError {
  return error.details["attempts"] === undefined
    ? new ClhError(error.code, error.message, { ...error.details, attempts })
    : error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
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
  cachedTokens?: number;
}

function readUsage(value: unknown): ApiUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const promptTokens = record["prompt_tokens"];
  const completionTokens = record["completion_tokens"];
  if (typeof promptTokens !== "number" || typeof completionTokens !== "number") return undefined;
  const total = record["total_tokens"];
  const cachedTokens = readCachedTokens(record, promptTokens);
  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens: typeof total === "number" ? total : promptTokens + completionTokens,
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
  };
}

/** PRD 3.14.8: usage.prompt_tokens_details.cached_tokens, clamped into
 * [0, prompt_tokens]; absent or malformed details mean no cached reads. */
function readCachedTokens(record: Record<string, unknown>, promptTokens: number): number | undefined {
  const details = record["prompt_tokens_details"];
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const cached = (details as Record<string, unknown>)["cached_tokens"];
  if (typeof cached !== "number" || !Number.isFinite(cached) || cached < 0) return undefined;
  return Math.min(Math.floor(cached), promptTokens);
}

function enforceOutputContractApi(contract: HarnessPreset["outputContract"], text: string): string {
  if (contract === "precise-json") {
    const payload = extractJsonPayload(text);
    if (payload === undefined) {
      throw new ClhError("CLH_OUTPUT_CONTRACT", "precise-json contract requires the completion to parse as JSON", {});
    }
    return payload;
  }
  return text;
}
