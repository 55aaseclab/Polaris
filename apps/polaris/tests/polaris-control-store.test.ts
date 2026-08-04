import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PolarisControlStore } from "../scripts/portal/control-store.js";

function temporaryStore(): { root: string; filePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-control-store-"));
  return { root, filePath: path.join(root, "state", "control.sqlite") };
}

test("control store keeps launch tickets single-use across reopen", () => {
  const fixture = temporaryStore();
  try {
    const first = PolarisControlStore.open(fixture.filePath);
    assert.equal(first.redeemGatewayTicket("ticket-a", 2_000, 1_000), true);
    assert.equal(first.redeemGatewayTicket("ticket-a", 2_000, 1_000), false);
    first.close();

    const reopened = PolarisControlStore.open(fixture.filePath);
    assert.equal(reopened.redeemGatewayTicket("ticket-a", 2_000, 1_001), false);
    assert.equal(reopened.redeemGatewayTicket("ticket-b", 2_000, 1_001), true);
    reopened.close();
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("control store persists fixed-window gateway rate limits", () => {
  const fixture = temporaryStore();
  try {
    const first = PolarisControlStore.open(fixture.filePath);
    assert.deepEqual(first.consumeGatewayRateLimit({
      bucketKey: "synthetic-rate-bucket",
      limit: 2,
      windowSeconds: 60,
      nowSeconds: 120,
    }), {
      allowed: true,
      limit: 2,
      remaining: 1,
      resetAt: 180,
    });
    assert.equal(first.consumeGatewayRateLimit({
      bucketKey: "synthetic-rate-bucket",
      limit: 2,
      windowSeconds: 60,
      nowSeconds: 121,
    }).allowed, true);
    first.close();

    const reopened = PolarisControlStore.open(fixture.filePath);
    assert.equal(reopened.consumeGatewayRateLimit({
      bucketKey: "synthetic-rate-bucket",
      limit: 2,
      windowSeconds: 60,
      nowSeconds: 122,
    }).allowed, false);
    assert.deepEqual(reopened.consumeGatewayRateLimit({
      bucketKey: "synthetic-rate-bucket",
      limit: 2,
      windowSeconds: 60,
      nowSeconds: 180,
    }), {
      allowed: true,
      limit: 2,
      remaining: 1,
      resetAt: 240,
    });
    reopened.close();
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("control store claims, retries, and completes durable jobs", () => {
  const fixture = temporaryStore();
  try {
    const store = PolarisControlStore.open(fixture.filePath);
    const queued = store.enqueueJob({
      kind: "vault-provision",
      dedupeKey: "tenant-a:vault-a",
      tenantId: "tenant-a",
      vaultId: "vault-a",
      payload: { startAfterCreate: true },
      maxAttempts: 2,
    });
    assert.equal(store.enqueueJob({
      kind: "vault-provision",
      dedupeKey: "tenant-a:vault-a",
      payload: { ignored: true },
    }).id, queued.id);

    const claimed = store.claimNextJob("worker-a", 10_000);
    assert.equal(claimed?.id, queued.id);
    assert.equal(claimed?.status, "running");
    const retried = store.failJob(queued.id, "worker-a", "temporary", "provider unavailable", 0);
    assert.equal(retried?.status, "queued");
    const reclaimed = store.claimNextJob("worker-b", 10_000);
    assert.equal(reclaimed?.attempts, 2);
    assert.equal(store.completeJob(queued.id, "worker-b"), true);
    assert.equal(store.getJob(queued.id)?.status, "succeeded");
    store.close();
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("control store cancels queued jobs and prevents a cancelled lease from completing", () => {
  const fixture = temporaryStore();
  try {
    const store = PolarisControlStore.open(fixture.filePath);
    const queued = store.enqueueJob({
      kind: "vault-provision",
      dedupeKey: "tenant-a:cancel-queued",
      tenantId: "tenant-a",
      vaultId: "cancel-queued",
    });
    assert.equal(store.requestJobCancellation("tenant-a:cancel-queued"), true);
    assert.equal(store.getJob(queued.id)?.status, "failed");
    assert.equal(store.getJob(queued.id)?.cancelRequested, true);
    assert.equal(
      store.enqueueJob({
        kind: "vault-provision",
        dedupeKey: "tenant-a:cancel-queued",
      }).status,
      "failed",
    );
    assert.equal(store.getJob(queued.id)?.cancelRequested, true);
    assert.equal(store.claimNextJob("worker-a"), null);

    const running = store.enqueueJob({
      kind: "vault-provision",
      dedupeKey: "tenant-a:cancel-running",
      tenantId: "tenant-a",
      vaultId: "cancel-running",
    });
    assert.equal(store.claimNextJob("worker-a")?.id, running.id);
    assert.equal(store.requestJobCancellation("tenant-a:cancel-running"), true);
    assert.equal(store.isJobCancellationRequested(running.id), true);
    assert.equal(store.heartbeatJob(running.id, "worker-a"), false);
    assert.equal(store.completeJob(running.id, "worker-a"), false);
    assert.equal(
      store.failJob(running.id, "worker-a", "temporary", "should be cancelled")?.status,
      "failed",
    );
    assert.equal(store.getJob(running.id)?.errorCode, "vault-provision-cancelled");

    const terminal = store.enqueueJob({
      kind: "vault-provision",
      dedupeKey: "tenant-a:terminal",
      tenantId: "tenant-a",
      vaultId: "terminal",
    });
    assert.equal(store.claimNextJob("worker-a")?.id, terminal.id);
    assert.equal(
      store.failJobPermanently(terminal.id, "worker-a", "tenant-not-found", "tenant removed")?.status,
      "failed",
    );
    assert.equal(store.listPendingJobsForTenant("tenant-a").length, 0);
    assert.equal(store.deleteTerminalProvisionJob("tenant-a", "terminal"), true);
    assert.equal(store.getJob(terminal.id), null);
    store.close();
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("control store lists pending jobs by exact tenant and vault", () => {
  const fixture = temporaryStore();
  try {
    const store = PolarisControlStore.open(fixture.filePath);
    const matching = store.enqueueJob({
      kind: "vault-provision",
      dedupeKey: "tenant-a:vault-a",
      tenantId: "tenant-a",
      vaultId: "vault-a",
    });
    store.enqueueJob({
      kind: "vault-provision",
      dedupeKey: "tenant-a:vault-b",
      tenantId: "tenant-a",
      vaultId: "vault-b",
    });
    store.enqueueJob({
      kind: "vault-provision",
      dedupeKey: "tenant-b:vault-a",
      tenantId: "tenant-b",
      vaultId: "vault-a",
    });

    assert.deepEqual(
      store.listPendingJobsForVault("tenant-a", "vault-a").map((job) => job.id),
      [matching.id],
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("control store persists replayable idempotency responses", () => {
  const fixture = temporaryStore();
  const fingerprint = "a".repeat(64);
  try {
    const first = PolarisControlStore.open(fixture.filePath);
    assert.equal(
      first.beginIdempotencyFingerprint("mutation-scope", "mutation-a", fingerprint),
      "started",
    );
    first.completeIdempotencyResponse("mutation-scope", "mutation-a", {
      statusCode: 201,
      contentType: "application/json; charset=utf-8",
      body: Buffer.from('{"created":true}\n', "utf8"),
    });
    assert.deepEqual(first.readIdempotencyResponse("mutation-scope", "mutation-a"), {
      status: "completed",
      response: {
        statusCode: 201,
        contentType: "application/json; charset=utf-8",
        body: Buffer.from('{"created":true}\n', "utf8"),
      },
    });
    first.close();

    const reopened = PolarisControlStore.open(fixture.filePath);
    assert.equal(
      reopened.beginIdempotencyFingerprint("mutation-scope", "mutation-a", fingerprint),
      "existing",
    );
    assert.throws(
      () => reopened.beginIdempotencyFingerprint("mutation-scope", "mutation-a", "b".repeat(64)),
      /different request/u,
    );
    reopened.close();
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("control store enforces idempotency, workspace ownership, and immutable audit", () => {
  const fixture = temporaryStore();
  try {
    const store = PolarisControlStore.open(fixture.filePath);
    assert.equal(store.beginIdempotency("outreach", "request-1", { sku: "A" }), "started");
    assert.equal(store.beginIdempotency("outreach", "request-1", { sku: "A" }), "existing");
    assert.throws(() => store.beginIdempotency("outreach", "request-1", { sku: "B" }), /different request/u);
    store.completeIdempotency("outreach", "request-1", { accepted: true });
    assert.deepEqual(store.readIdempotency("outreach", "request-1"), {
      status: "completed",
      result: { accepted: true },
    });

    assert.equal(store.acquireWorkspaceLock({
      tenantId: "tenant-a", vaultId: "vault-a", workspaceId: "workspace-a", owner: "writer-a",
    }), true);
    assert.equal(store.acquireWorkspaceLock({
      tenantId: "tenant-a", vaultId: "vault-a", workspaceId: "workspace-a", owner: "writer-b",
    }), false);
    assert.equal(store.heartbeatWorkspaceLock({
      tenantId: "tenant-a", vaultId: "vault-a", workspaceId: "workspace-a", owner: "writer-a",
    }), true);
    assert.equal(store.heartbeatWorkspaceLock({
      tenantId: "tenant-a", vaultId: "vault-a", workspaceId: "workspace-a", owner: "writer-b",
    }), false);
    assert.equal(store.releaseWorkspaceLock("tenant-a", "vault-a", "workspace-a", "writer-a"), true);

    const auditId = store.recordAudit({
      actorId: "user-a",
      tenantId: "tenant-a",
      vaultId: "vault-a",
      action: "workspace.write",
      requestId: "request-1",
      outcome: "success",
      metadata: { workspaceId: "workspace-a" },
    });
    assert.equal(store.listAuditEvents()[0]?.id, auditId);
    const rawStore = store as unknown as {
      db: { prepare(query: string): { run(...args: unknown[]): unknown } };
    };
    assert.throws(
      () => rawStore.db.prepare("DELETE FROM audit_events WHERE id = ?").run(auditId),
      /immutable/u,
    );
    store.close();
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
