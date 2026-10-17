import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { createPortalServer } from "../scripts/portal/server.js";
import { closePolarisControlStore } from "../scripts/portal/control-store.js";
import { addDomainPack } from "../scripts/config/domain-packs.js";

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

async function withEnv(
  name: string,
  value: string,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

/**
 * API idempotency key (PRD KR2): repeated POSTs to /api/workflow-runs
 * carrying the same key return the same run instead of enqueueing a
 * duplicate.
 */
test("workflow run submission dedupes under an idempotency key", { concurrency: false }, async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-idempotency-"));
  const previousDataRoot = process.env.POLARIS_DATA_ROOT;
  const previousControlStorePath = process.env.POLARIS_CONTROL_STORE_PATH;
  process.env.POLARIS_DATA_ROOT = dataRoot;
  process.env.POLARIS_CONTROL_STORE_PATH = path.join(dataRoot, "control.sqlite");
  try {
    const sourcePath = path.join(dataRoot, "idempotency-workflow.ord");
    fs.writeFileSync(sourcePath, `domain IdempotencyWorkflow version "1.0.0"
title "Idempotency Workflow"
port SummarizeValue version "1.0.0" {
  in { subject: String }
  out { summary: String }
  effect pure
}
flow Summarize title "Summarize" create {
  input { subject: String required }
  steps {
    summarize "Summarize" {
      uses { subject }
      output { summary: String }
    }
  }
  output { summary: String from summary }
  ui { layout form primary "Run" }
}
`, "utf8");
    await addDomainPack(import.meta.url, sourcePath);

    await withEnv("POLARIS_AUTH_MODE", "disabled", async () => {
      await withEnv("POLARIS_AUTH_DEFAULT_USER_ID", uniqueName("idempotency-user"), async () => {
        const server = createPortalServer(0);
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Portal server did not expose a TCP address");
        }
        const submit = async (idempotencyKey: string | undefined): Promise<{
          status: number;
          runId: string | undefined;
        }> => {
          const response = await fetch(`http://127.0.0.1:${address.port}/api/workflow-runs`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
            },
            body: JSON.stringify({
              packId: "IdempotencyWorkflow",
              flowId: "Summarize",
              driver: "none",
              values: { subject: "synthetic request" },
            }),
          });
          const payload = (await response.json()) as { run?: { id?: string } };
          return { status: response.status, runId: payload.run?.id };
        };
        try {
          // Header idempotency key: same key twice -> same run.
          const first = await submit("submit-synthetic-1");
          const replay = await submit("submit-synthetic-1");
          assert.equal(first.status, 202);
          assert.equal(replay.status, 202);
          assert.ok(first.runId);
          assert.equal(replay.runId, first.runId);

          // Body field idempotency key: same key -> the same run.
          const bodyResponse = await fetch(`http://127.0.0.1:${address.port}/api/workflow-runs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              packId: "IdempotencyWorkflow",
              flowId: "Summarize",
              driver: "none",
              idempotencyKey: "submit-synthetic-1",
              values: { subject: "synthetic request" },
            }),
          });
          assert.equal(bodyResponse.status, 202);
          const bodyPayload = (await bodyResponse.json()) as { run?: { id?: string } };
          assert.equal(bodyPayload.run?.id, first.runId);

          // A different key enqueues a different run.
          const second = await submit("submit-synthetic-2");
          assert.ok(second.runId);
          assert.notEqual(second.runId, first.runId);

          // Submissions without a key stay non-idempotent (unchanged behavior).
          const plainA = await submit(undefined);
          const plainB = await submit(undefined);
          assert.notEqual(plainB.runId, plainA.runId);

          // Invalid keys are rejected.
          const invalidResponse = await fetch(`http://127.0.0.1:${address.port}/api/workflow-runs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              packId: "IdempotencyWorkflow",
              flowId: "Summarize",
              driver: "none",
              idempotencyKey: "bad key with spaces",
              values: { subject: "synthetic request" },
            }),
          });
          assert.equal(invalidResponse.status, 400);
        } finally {
          server.close();
          await once(server, "close");
        }
      });
    });
  } finally {
    closePolarisControlStore();
    if (previousDataRoot === undefined) delete process.env.POLARIS_DATA_ROOT;
    else process.env.POLARIS_DATA_ROOT = previousDataRoot;
    if (previousControlStorePath === undefined) delete process.env.POLARIS_CONTROL_STORE_PATH;
    else process.env.POLARIS_CONTROL_STORE_PATH = previousControlStorePath;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
