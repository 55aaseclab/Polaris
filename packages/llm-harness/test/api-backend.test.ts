import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import test from "node:test";
import { callApiPreset } from "../src/api-backend.js";
import { ClhError } from "../src/errors.js";
import type { ClhEnv } from "../src/env.js";
import { validatePreset } from "../src/schema.js";

const syntheticEnv = (endpoint: string, pricing = true): ClhEnv => ({
  endpoint,
  apiKey: "sk-synthetic-placeholder",
  models: { light: "synthetic-flash-model", strong: "synthetic-r1-model" },
  pricing: pricing
    ? { light: { inputPerMTok: 0.5, outputPerMTok: 2 }, strong: { inputPerMTok: 1, outputPerMTok: 4 } }
    : {},
  apiTimeoutMs: 2000,
  dshBin: "dsh",
  dshBinArgs: [],
  dshProfile: "headless",
  zstdBin: "zstd",
});

const apiPresetBase = {
  kind: "api",
  model: "light",
  toolBoundary: "none",
  loopCap: 1,
  outputContract: "precise-json",
  permission: "read-only",
};

const apiPreset = validatePreset(apiPresetBase).preset;
const artifactPreset = validatePreset({ ...apiPresetBase, outputContract: "artifact" }).preset;

interface Started {
  server: Server;
  url: string;
  requests: Array<Record<string, unknown>>;
}

function startMockServer(handler: (req: unknown, body: Record<string, unknown>) => unknown): Promise<Started> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push(body);
      const payload = handler(req, body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${address.port}/v1`, requests });
    });
  });
}

test("api backend reads usage back and computes costUsd from tier pricing", async () => {
  const started = await startMockServer(() => ({
    choices: [{ message: { role: "assistant", content: "{\"decision\":\"yes\"}" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 400000, completion_tokens: 100000, total_tokens: 500000 },
  }));
  try {
    const receipt = await callApiPreset({
      preset: apiPreset,
      system: "You are a synthetic critic.",
      prompt: "Review the synthetic logs.",
      env: syntheticEnv(started.url),
      fetchImpl: fetch,
    });
    assert.equal(receipt.model, "synthetic-flash-model");
    assert.equal(receipt.text, "{\"decision\":\"yes\"}");
    assert.deepEqual(receipt.tokens, { inputTokens: 400000, outputTokens: 100000, totalTokens: 500000 });
    assert.equal(receipt.costUsd, (400000 / 1e6) * 0.5 + (100000 / 1e6) * 2);
    assert.equal(receipt.finishReason, "stop");
    const sent = started.requests[0] ?? {};
    assert.equal(sent["model"], "synthetic-flash-model");
    const messages = sent["messages"] as Array<Record<string, unknown>>;
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.["role"], "system");
    assert.equal(messages[1]?.["role"], "user");
  } finally {
    started.server.close();
  }
});

test("api backend costUsd is undefined without pricing env", async () => {
  const started = await startMockServer(() => ({
    choices: [{ message: { role: "assistant", content: "synthetic text" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }));
  try {
    const artifactPreset = validatePreset({
      kind: "api",
      model: "strong",
      toolBoundary: "none",
      loopCap: 1,
      outputContract: "artifact",
      permission: "read-only",
    }).preset;
    const receipt = await callApiPreset({
      preset: artifactPreset,
      prompt: "synthetic prompt",
      env: syntheticEnv(started.url, false),
    });
    assert.equal(receipt.costUsd, undefined);
    assert.equal(receipt.model, "synthetic-r1-model");
  } finally {
    started.server.close();
  }
});

test("api backend fails closed on missing credentials", async () => {
  const started = await startMockServer(() => ({}));
  try {
    await assert.rejects(
      () => callApiPreset({ preset: apiPreset, prompt: "p", env: { ...syntheticEnv(started.url), apiKey: undefined } }),
      (error: unknown) => error instanceof ClhError && error.code === "CLH_MISSING_CREDENTIAL",
    );
    await assert.rejects(
      () => callApiPreset({ preset: apiPreset, prompt: "p", env: { ...syntheticEnv(started.url), endpoint: undefined } }),
      (error: unknown) => error instanceof ClhError && error.code === "CLH_MISSING_CREDENTIAL",
    );
    await assert.rejects(
      () => callApiPreset({ preset: apiPreset, prompt: "p", env: { ...syntheticEnv(started.url), models: { light: undefined, strong: undefined } } }),
      (error: unknown) => error instanceof ClhError && error.code === "CLH_MISSING_MODEL",
    );
    await assert.rejects(
      () => callApiPreset({ preset: apiPreset, prompt: "p", env: { ...syntheticEnv(started.url), endpoint: "not-a-url" } }),
      (error: unknown) => error instanceof ClhError && error.code === "CLH_ENDPOINT_INVALID",
    );
  } finally {
    started.server.close();
  }
});

test("api backend rejects non-2xx responses with CLH_API_STATUS", async () => {
  const server = createServer((req, res) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "synthetic rate limit" } }));
  });
  const started = await new Promise<Started>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${address.port}/v1`, requests: [] });
    });
  });
  try {
    await assert.rejects(
      () => callApiPreset({ preset: apiPreset, prompt: "p", env: syntheticEnv(started.url) }),
      (error: unknown) => error instanceof ClhError && error.code === "CLH_API_STATUS",
    );
  } finally {
    server.close();
  }
});

test("api backend times out per call with CLH_API_TIMEOUT", async () => {
  const server = createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    }, 300);
  });
  const started = await new Promise<Started>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${address.port}/v1`, requests: [] });
    });
  });
  try {
    await assert.rejects(
      () => callApiPreset({ preset: apiPreset, prompt: "p", env: syntheticEnv(started.url), timeoutMs: 50 }),
      (error: unknown) => error instanceof ClhError && error.code === "CLH_API_TIMEOUT",
    );
  } finally {
    server.close();
  }
});

test("api backend enforces the precise-json output contract", async () => {
  const started = await startMockServer(() => ({
    choices: [{ message: { role: "assistant", content: "plain text, not json" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }));
  try {
    await assert.rejects(
      () => callApiPreset({ preset: apiPreset, prompt: "p", env: syntheticEnv(started.url) }),
      (error: unknown) => error instanceof ClhError && error.code === "CLH_OUTPUT_CONTRACT",
    );
  } finally {
    started.server.close();
  }
});

test("api backend streams the completion over SSE and keeps receipt semantics", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      requests.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "text/event-stream" });
      // One delta split across two writes exercises the SSE line buffer.
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`);
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "{\"decision\":" } }] })}\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "\"yes\"}" } }] })}\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n`);
        res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 400000, completion_tokens: 100000, total_tokens: 500000 } })}\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }, 20);
    });
  });
  const started = await listen(server);
  try {
    const receipt = await callApiPreset({
      preset: apiPreset,
      prompt: "Review the synthetic logs.",
      env: syntheticEnv(started.url),
    });
    assert.equal(receipt.text, "{\"decision\":\"yes\"}");
    assert.deepEqual(receipt.tokens, { inputTokens: 400000, outputTokens: 100000, totalTokens: 500000 });
    assert.equal(receipt.costUsd, (400000 / 1e6) * 0.5 + (100000 / 1e6) * 2);
    assert.equal(receipt.finishReason, "stop");
    assert.equal(requests[0]?.["stream"], true);
    assert.deepEqual(requests[0]?.["stream_options"], { include_usage: true });
  } finally {
    server.close();
  }
});

test("api backend fails closed on a malformed SSE data line without retrying", async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: {not json}\n\n");
    res.end();
  });
  const started = await listen(server);
  try {
    await assert.rejects(
      () => callApiPreset({ preset: apiPreset, prompt: "p", env: syntheticEnv(started.url) }),
      (error: unknown) =>
        error instanceof ClhError
        && error.code === "CLH_API_STATUS"
        && error.details["sseChunk"] === true,
    );
    assert.equal(hits, 1);
  } finally {
    server.close();
  }
});

test("api backend backs off 429 with bounded retries and succeeds", async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    if (hits < 3) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ error: { message: "synthetic rate limit" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  const started = await listen(server);
  try {
    const receipt = await callApiPreset({
      preset: artifactPreset,
      prompt: "p",
      env: syntheticEnv(started.url),
      retry: { maxAttempts: 3, baseDelayMs: 20, random: () => 0.5 },
    });
    assert.equal(hits, 3);
    assert.equal(receipt.text, "ok");
    assert.ok(receipt.durationMs < 2000, `backoff exceeded the budget: ${receipt.durationMs}ms`);
  } finally {
    server.close();
  }
});

test("api backend stops retrying when the backoff would exceed the timeoutMs budget", async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "synthetic rate limit" } }));
  });
  const started = await listen(server);
  try {
    const startedAt = Date.now();
    await assert.rejects(
      () => callApiPreset({
        preset: apiPreset,
        prompt: "p",
        env: syntheticEnv(started.url),
        timeoutMs: 300,
        retry: { maxAttempts: 3, baseDelayMs: 10_000, random: () => 0.5 },
      }),
      (error: unknown) =>
        error instanceof ClhError
        && error.code === "CLH_API_STATUS"
        && error.details["status"] === 429,
    );
    assert.equal(hits, 1);
    assert.ok(Date.now() - startedAt < 2000, "budget-bound backoff must not sleep past the deadline");
  } finally {
    server.close();
  }
});

test("api backend fails closed after the bounded attempts are exhausted", async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "synthetic rate limit" } }));
  });
  const started = await listen(server);
  try {
    await assert.rejects(
      () => callApiPreset({
        preset: apiPreset,
        prompt: "p",
        env: syntheticEnv(started.url),
        retry: { maxAttempts: 3, baseDelayMs: 10, random: () => 0.1 },
      }),
      (error: unknown) =>
        error instanceof ClhError
        && error.code === "CLH_API_STATUS"
        && error.details["status"] === 429
        && error.details["attempts"] === 3,
    );
    assert.equal(hits, 3);
  } finally {
    server.close();
  }
});

test("api backend retries a transient transport failure and succeeds", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "recovered" }, finish_reason: "stop" }] })}\n`,
      "data: [DONE]\n\n",
    ]);
  };
  const receipt = await callApiPreset({
    preset: artifactPreset,
    prompt: "p",
    env: syntheticEnv("http://127.0.0.1:1/v1"),
    retry: { maxAttempts: 3, baseDelayMs: 10, random: () => 0.5 },
    fetchImpl,
  });
  assert.equal(calls, 2);
  assert.equal(receipt.text, "recovered");
});

test("api backend does not retry permanent statuses", async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "synthetic bad request" } }));
  });
  const started = await listen(server);
  try {
    await assert.rejects(
      () => callApiPreset({ preset: apiPreset, prompt: "p", env: syntheticEnv(started.url) }),
      (error: unknown) =>
        error instanceof ClhError
        && error.code === "CLH_API_STATUS"
        && error.details["status"] === 400,
    );
    assert.equal(hits, 1);
  } finally {
    server.close();
  }
});

test("api backend timeout error carries elapsedMs and tier for error threading", async () => {
  const server = createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: [DONE]\n\n");
    }, 300);
  });
  const started = await listen(server);
  try {
    await assert.rejects(
      () => callApiPreset({ preset: apiPreset, prompt: "p", env: syntheticEnv(started.url), timeoutMs: 50 }),
      (error: unknown) => {
        assert.ok(error instanceof ClhError && error.code === "CLH_API_TIMEOUT");
        assert.equal(error.details["timeoutMs"], 50);
        assert.equal(error.details["tier"], "light");
        assert.equal(error.details["attempts"], 1);
        assert.equal(typeof error.details["elapsedMs"], "number");
        return true;
      },
    );
  } finally {
    server.close();
  }
});

test("api backend resolves the timeout as explicit option over preset over env", async () => {
  const server = createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "slow but fine" }, finish_reason: "stop" }] })}\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }, 200);
  });
  const started = await listen(server);
  const shortEnv = { ...syntheticEnv(started.url), apiTimeoutMs: 50 };
  const longPreset = validatePreset({ ...apiPresetBase, outputContract: "artifact", timeoutMs: 10_000 }).preset;
  try {
    // preset.timeoutMs overrides the env fallback.
    const receipt = await callApiPreset({ preset: longPreset, prompt: "p", env: shortEnv });
    assert.equal(receipt.text, "slow but fine");
    // The env fallback applies when the preset declares no timeoutMs.
    await assert.rejects(
      () => callApiPreset({ preset: apiPreset, prompt: "p", env: shortEnv }),
      (error: unknown) => error instanceof ClhError && error.code === "CLH_API_TIMEOUT",
    );
    // An explicit per-call option overrides the preset declaration.
    await assert.rejects(
      () => callApiPreset({ preset: longPreset, prompt: "p", env: shortEnv, timeoutMs: 50 }),
      (error: unknown) => error instanceof ClhError && error.code === "CLH_API_TIMEOUT",
    );
  } finally {
    server.close();
  }
});

test("api backend extracts cached_tokens from the streamed usage details", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n`);
    // The closing usage disclosure carries prompt_tokens_details (OpenAI
    // semantics: prompt_tokens includes cached_tokens).
    res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 922000, completion_tokens: 25000, total_tokens: 947000, prompt_tokens_details: { cached_tokens: 888000 } } })}\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  const started = await listen(server);
  try {
    const receipt = await callApiPreset({
      preset: artifactPreset,
      prompt: "p",
      env: syntheticEnv(started.url),
    });
    assert.deepEqual(receipt.tokens, {
      inputTokens: 922000,
      outputTokens: 25000,
      totalTokens: 947000,
      cachedTokens: 888000,
    });
    // (922000 - 888000) x $0.5 + 888000 x $0.5 + 25000 x $2 for the synthetic
    // light-tier env pricing where cached defaults to the input rate.
    assert.equal(receipt.costUsd, (922000 / 1e6) * 0.5 + (25000 / 1e6) * 2);
  } finally {
    server.close();
  }
});

test("api backend treats missing or zero cached details as zero cache reads", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n`);
    // No prompt_tokens_details at all.
    res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 400000, completion_tokens: 100000, total_tokens: 500000 } })}\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  const started = await listen(server);
  try {
    const receipt = await callApiPreset({
      preset: artifactPreset,
      prompt: "p",
      env: syntheticEnv(started.url),
    });
    assert.deepEqual(receipt.tokens, { inputTokens: 400000, outputTokens: 100000, totalTokens: 500000 });
    assert.equal(receipt.costUsd, (400000 / 1e6) * 0.5 + (100000 / 1e6) * 2);
  } finally {
    server.close();
  }
});

test("api backend bills a disclosed zero cached split at the input rate", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n`);
    res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 500000, completion_tokens: 100000, total_tokens: 600000, prompt_tokens_details: { cached_tokens: 0 } } })}\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  const started = await listen(server);
  const env: ClhEnv = {
    ...syntheticEnv(started.url),
    pricing: {
      light: { inputPerMTok: 0.3, cachedInputPerMTok: 0.006, outputPerMTok: 1.2 },
      strong: { inputPerMTok: 1, outputPerMTok: 4 },
    },
  };
  try {
    const receipt = await callApiPreset({
      preset: artifactPreset,
      prompt: "p",
      env,
    });
    assert.deepEqual(receipt.tokens, {
      inputTokens: 500000,
      outputTokens: 100000,
      totalTokens: 600000,
      cachedTokens: 0,
    });
    assert.equal(receipt.costUsd, (500000 / 1e6) * 0.3 + (100000 / 1e6) * 1.2);
  } finally {
    server.close();
  }
});

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function listen(server: Server): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${address.port}/v1` });
    });
  });
}

test("extractJsonPayload normalizes fence-wrapped and prose-wrapped JSON", async () => {
  const { extractJsonPayload } = await import("../src/api-backend.js");
  assert.equal(extractJsonPayload('{"decision":"approve"}'), '{"decision":"approve"}');
  assert.equal(
    extractJsonPayload('```json\n{"decision":"approve"}\n```'),
    '{"decision":"approve"}',
  );
  assert.deepEqual(
    JSON.parse(extractJsonPayload('Here is my decision:\n{"decision":"approve","note":"ok"}') ?? ""),
    { decision: "approve", note: "ok" },
  );
  assert.equal(extractJsonPayload("no json at all"), undefined);
});
