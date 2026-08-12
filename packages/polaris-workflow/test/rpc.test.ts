import assert from "node:assert/strict";
import test from "node:test";
import {
  FFI_RPC_PROTOCOL_VERSION,
  builtinCall,
  checkFfiAdmission,
  mockRpcResponse,
  runPipeline,
} from "../src/index.js";

test("manual.review is a declarative built-in with a deterministic mock response", () => {
  const pipeline = runPipeline(`
domain ReviewPack version "1.0.0"
port ReviewPlan version "1.0.0" {
  builtin manual.review
  in { title: String, instructions: String }
  out { approved: Boolean, reviewId: ID }
  effect human
}
flow Review title "Review" create {
  needs { ReviewPlan }
  input { subject: String required }
  steps {
    review "Review" {
      uses { subject }
      call ReviewPlan
      output { approved: Boolean, reviewId: ID }
    }
  }
  output { approved: Boolean from approved }
  ui { layout form primary "Review" }
}
`);

  assert.equal(pipeline.ok, true);
  assert.deepEqual(builtinCall("manual.review")?.risk, "human");
  const response = mockRpcResponse({
    protocolVersion: FFI_RPC_PROTOCOL_VERSION,
    requestId: "request-synthetic-1",
    idempotencyKey: "run-synthetic-1:request-synthetic-1",
    runId: "run-synthetic-1",
    tenantId: "tenant-synthetic-1",
    vaultId: "vault-synthetic-1",
    pack: { id: "review-pack", version: "1.0.0", digest: "sha256:synthetic" },
    capabilityLease: {
      id: "lease-synthetic-1",
      packDigest: "sha256:synthetic",
      vaultId: "vault-synthetic-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    call: {
      port: "ReviewPlan",
      version: "1.0.0",
      effect: "human",
      builtin: "manual.review",
    },
    input: { title: "Synthetic review", instructions: "Synthetic instructions" },
    mode: "mock",
  });
  assert.equal(response.status, "waiting");
  assert.equal(response.output.approved, true);
  assert.equal(response.output.reviewId, "review-request-synt");
  assert.equal(response.receipt.status, "waiting");
  assert.match(response.receipt.outputDigest ?? "", /^sha256:[a-f0-9]{64}$/u);
});

test("RPC admission rejects a changed pack pin or an expired Vault lease", () => {
  const request = {
    protocolVersion: FFI_RPC_PROTOCOL_VERSION,
    requestId: "request-synthetic-2",
    idempotencyKey: "run-synthetic-2:request-synthetic-2",
    runId: "run-synthetic-2",
    tenantId: "tenant-synthetic-2",
    vaultId: "vault-synthetic-2",
    pack: { id: "review-pack", version: "1.0.0", digest: "sha256:pack-a" },
    capabilityLease: {
      id: "lease-synthetic-2",
      packDigest: "sha256:pack-b",
      vaultId: "vault-synthetic-2",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    call: { port: "ReviewPlan", version: "1.0.0", effect: "human" as const },
    input: {},
    mode: "mock" as const,
  };
  assert.deepEqual(checkFfiAdmission(request), {
    allowed: false,
    code: "pack-digest-mismatch",
    message: "FFI pack pin does not match the capability lease",
  });
  const expired = {
    ...request,
    capabilityLease: {
      ...request.capabilityLease,
      packDigest: request.pack.digest,
      expiresAt: "2020-01-01T00:00:00.000Z",
    },
  };
  const response = mockRpcResponse(expired);
  assert.equal(response.status, "denied");
  assert.equal(response.error?.code, "capability-lease-expired");
  assert.equal(response.receipt.status, "denied");
});
