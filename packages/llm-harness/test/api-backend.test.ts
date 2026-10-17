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

const apiPreset = validatePreset({
  kind: "api",
  model: "light",
  toolBoundary: "none",
  loopCap: 1,
  outputContract: "precise-json",
  permission: "read-only",
}).preset;

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
