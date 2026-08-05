import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../scripts/cli/main.js";
import {
  closePolarisControlStore,
  getPolarisControlStore,
} from "../scripts/portal/control-store.js";

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
    return chunks.join("");
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function captureFailure(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    await assert.rejects(fn, /Audit chain verification failed/);
    return chunks.join("");
  } finally {
    process.stdout.write = originalWrite;
  }
}

test("ops audit returns redacted events and a verified chain", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-ops-audit-"));
  const previousPath = process.env.POLARIS_CONTROL_STORE_PATH;
  process.env.POLARIS_CONTROL_STORE_PATH = path.join(root, "control.sqlite");
  closePolarisControlStore();
  try {
    const store = getPolarisControlStore(import.meta.url);
    store.recordAudit({
      actorId: "operator-a",
      tenantId: "tenant-a",
      vaultId: "vault-a",
      action: "workspace.write",
      requestId: "request-a",
      outcome: "success",
      metadata: { internalSecret: "must-not-be-listed" },
    });

    const output = await captureStdout(async () => {
      await runCli(["ops", "audit", "--limit", "10", "--verify", "--json"]);
    });
    const parsed = JSON.parse(output) as {
      events: Array<{
        id: string;
        actorId?: string;
        tenantId?: string;
        vaultId?: string;
        action: string;
        requestId?: string;
        outcome: string;
        occurredAt: string;
        eventHash: string;
      }>;
      integrity: { valid: boolean; checked: number };
    };
    assert.equal(parsed.events.length, 1);
    const event = parsed.events[0];
    assert.ok(event);
    assert.deepEqual(event, {
      id: event.id,
      actorId: "operator-a",
      tenantId: "tenant-a",
      vaultId: "vault-a",
      action: "workspace.write",
      requestId: "request-a",
      outcome: "success",
      occurredAt: event.occurredAt,
      eventHash: event.eventHash,
    });
    assert.deepEqual(parsed.integrity, { valid: true, checked: 1 });
    assert.doesNotMatch(output, /must-not-be-listed/);
  } finally {
    closePolarisControlStore();
    if (previousPath === undefined) {
      delete process.env.POLARIS_CONTROL_STORE_PATH;
    } else {
      process.env.POLARIS_CONTROL_STORE_PATH = previousPath;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ops audit exits nonzero for an invalid chain after redacted output", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-ops-audit-invalid-"));
  const previousPath = process.env.POLARIS_CONTROL_STORE_PATH;
  process.env.POLARIS_CONTROL_STORE_PATH = path.join(root, "control.sqlite");
  closePolarisControlStore();
  try {
    const store = getPolarisControlStore(import.meta.url);
    const auditId = store.recordAudit({
      action: "workspace.write",
      outcome: "success",
      metadata: { internalSecret: "must-not-be-listed" },
    });
    const rawStore = store as unknown as {
      db: {
        exec(query: string): void;
        prepare(query: string): { run(...args: unknown[]): unknown };
      };
    };
    rawStore.db.exec("DROP TRIGGER audit_events_immutable_update");
    rawStore.db.prepare("UPDATE audit_events SET event_hash = ? WHERE id = ?").run("f".repeat(64), auditId);

    const output = await captureFailure(async () => {
      await runCli(["ops", "audit", "--verify", "--json"]);
    });
    const parsed = JSON.parse(output) as {
      integrity: { valid: boolean; failedEventId?: string; reason?: string };
    };
    assert.deepEqual(parsed.integrity, {
      valid: false,
      checked: 1,
      failedEventId: auditId,
      reason: "event-hash-mismatch",
    });
    assert.doesNotMatch(output, /must-not-be-listed/);
  } finally {
    closePolarisControlStore();
    if (previousPath === undefined) {
      delete process.env.POLARIS_CONTROL_STORE_PATH;
    } else {
      process.env.POLARIS_CONTROL_STORE_PATH = previousPath;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
