import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { captureCpuProfile, type CpuProfileArtifact } from "./cpu-profile.js";
import { createManagedSshCredential } from "../config/credentials.js";
import {
  scaffoldDockerVault,
  scaffoldUserProfileById,
} from "../config/scaffold.js";
import { resumeDurableVaultJobs } from "../control-plane/operations.js";
import {
  closePolarisControlStore,
  getPolarisControlStore,
  PolarisControlStore,
} from "../portal/control-store.js";
import { polarisUsersRoot } from "../utils/paths.js";

const DEFAULT_SAMPLES = 100;
const DEFAULT_WARMUP_SAMPLES = 10;
const WORKER_ENV = "POLARIS_CONTROL_PLANE_PERFORMANCE_BENCHMARK_WORKER";
const TENANT_ID = "performance-control-tenant";
const VAULT_ID = "performance-control-vault";
const QUOTA_LIMIT_BYTES = 256 * 1024 * 1024;
const WORKER_BASE_IMAGE = `registry.example.test/wanghai@sha256:${"a".repeat(64)}`;
const WORKER_GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";
const USER_ROOT = polarisUsersRoot(import.meta.url);

type Operation = "control-store.mutation-admission" | "worker.provision";

export interface ControlPlanePerformanceBenchmarkOptions {
  samples?: number;
  warmupSamples?: number;
  profileDir?: string;
}

export interface ControlPlaneOperationSummary {
  count: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface ControlPlaneProcessSummary {
  systemCpuMs: number;
  userCpuMs: number;
  peakRssBytes: number;
  eventLoopDelay: {
    maxMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  };
}

export interface ControlPlanePerformanceBenchmarkResult {
  kind: "polaris-control-plane-performance-benchmark";
  recordedAt: string;
  fixture: {
    samples: number;
    warmupSamples: number;
  };
  runtime: {
    node: string;
    platform: string;
    release: string;
  };
  operations: Record<Operation, ControlPlaneOperationSummary>;
  errors: Record<Operation, number>;
  profiles?: {
    controlStore: CpuProfileArtifact;
    worker: CpuProfileArtifact;
  };
  process: ControlPlaneProcessSummary;
}

class ControlPlaneBenchmarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneBenchmarkError";
  }
}

function uniqueName(prefix: string, index: number): string {
  return `${prefix}-${process.pid}-${Date.now()}-${index}`;
}

function positiveInteger(value: number | undefined, label: string, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new ControlPlaneBenchmarkError(`${label} must be a positive integer`);
  }
  return resolved;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function nanosecondsToMilliseconds(value: number): number {
  return rounded(value / 1_000_000);
}

function percentile(samples: number[], percentileValue: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * percentileValue) - 1);
  return rounded(sorted[index] ?? 0);
}

function summarize(samples: number[]): ControlPlaneOperationSummary {
  return {
    count: samples.length,
    maxMs: rounded(Math.max(...samples)),
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
  };
}

function setEnv(name: string, value: string): () => void {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

function mutationFingerprint(index: number): string {
  return createHash("sha256")
    .update(JSON.stringify({
      action: "workspace.create",
      body: {
        workspace_id: `benchmark-workspace-${index}`,
        workspace_type: "research",
      },
      version: 1,
    }))
    .digest("hex");
}

function runControlStoreMutation(store: PolarisControlStore, index: number): void {
  const idempotencyScope = "v1-performance-control-store-workspace-create";
  const idempotencyKey = `control-store-mutation-${index}`;
  const requestId = `control-store-request-${index}`;
  const workspaceId = `benchmark-workspace-${index}`;
  const requestHash = mutationFingerprint(index);
  const started = store.beginIdempotencyFingerprint(
    idempotencyScope,
    idempotencyKey,
    requestHash,
  );
  if (started !== "started") {
    throw new ControlPlaneBenchmarkError("Synthetic mutation idempotency key was reused");
  }

  const lockInput = {
    tenantId: TENANT_ID,
    vaultId: VAULT_ID,
    workspaceId,
    owner: requestId,
    leaseMs: 120_000,
  };
  if (!store.acquireWorkspaceLock(lockInput)) {
    throw new ControlPlaneBenchmarkError("Synthetic workspace lock was not acquired");
  }

  let reservationId: string | undefined;
  let reconciled = false;
  try {
    const reservation = store.reserveQuota({
      tenantId: TENANT_ID,
      vaultId: VAULT_ID,
      category: "active_workspace",
      action: "workspace.create",
      idempotencyScope,
      idempotencyKey,
      limitBytes: QUOTA_LIMIT_BYTES,
      measuredUsageBytes: 1_024,
      reservedBytes: 4_096,
      leaseMs: 120_000,
    });
    if (!reservation.allowed || !reservation.reservation) {
      throw new ControlPlaneBenchmarkError("Synthetic workspace quota was exhausted");
    }
    reservationId = reservation.reservation.id;
    store.recordAudit({
      actorId: TENANT_ID,
      tenantId: TENANT_ID,
      vaultId: VAULT_ID,
      action: "wanghai.surface.quota.reservation.accepted",
      requestId,
      outcome: "success",
      metadata: { action: "workspace.create", category: "active_workspace" },
    });
    store.recordAudit({
      actorId: TENANT_ID,
      tenantId: TENANT_ID,
      vaultId: VAULT_ID,
      action: "wanghai.surface.action.workspace.create.accepted",
      requestId,
      outcome: "success",
      metadata: { workspaceId },
    });
    store.reconcileQuotaReservation({
      reservationId,
      actualUsageBytes: 1_024,
    });
    reconciled = true;
    store.recordAudit({
      actorId: TENANT_ID,
      tenantId: TENANT_ID,
      vaultId: VAULT_ID,
      action: "wanghai.surface.quota.reconciliation.completed",
      requestId,
      outcome: "success",
      metadata: { actualUsageBytes: 1_024 },
    });
    store.completeIdempotencyResponse(idempotencyScope, idempotencyKey, {
      statusCode: 200,
      contentType: "application/json; charset=utf-8",
      body: Buffer.from(JSON.stringify({ workspace_id: workspaceId, created: true }), "utf8"),
    });
    store.recordAudit({
      actorId: TENANT_ID,
      tenantId: TENANT_ID,
      vaultId: VAULT_ID,
      action: "wanghai.surface.action.workspace.create.completed",
      requestId,
      outcome: "success",
      metadata: { statusCode: 200, workspaceId },
    });
  } finally {
    if (reservationId && !reconciled) store.releaseQuotaReservation(reservationId);
    store.releaseWorkspaceLock(TENANT_ID, VAULT_ID, workspaceId, requestId);
  }
}

interface WorkerFixture {
  userId: string;
  vault: string;
  userRoot: string;
  profilePath: string;
}

function setupWorkerFixture(): WorkerFixture {
  const userId = uniqueName("performance-worker-user", 0);
  const vault = "performance-worker-vault";
  const userRoot = path.join(USER_ROOT, userId);
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  scaffoldUserProfileById({
    id: userId,
    name: "Performance Worker User",
    email: `${userId}@example.test`,
  });
  createManagedSshCredential({
    userProfileId: userId,
    credentialId: "benchmark-ssh",
    label: "Performance Benchmark SSH",
    activate: true,
  });
  scaffoldDockerVault(vault, userId, {
    baseImage: WORKER_BASE_IMAGE,
    line: "vertical",
    paseoFreeWanghaiTest: true,
  });
  return { userId, vault, userRoot, profilePath };
}

function createFakeDockerBin(root: string): string {
  const bin = path.join(root, "fake-bin");
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(bin, "docker"), `#!/bin/sh
set -eu
case "\${1:-}" in
  compose)
    printf 'polaris-performance-container\\n'
    ;;
  inspect)
    printf '[{"State":{"Running":false,"ExitCode":0}}]\\n'
    ;;
  *)
    ;;
esac
`, { mode: 0o700 });
  return bin;
}

async function runProvisionWorkerSample(fixture: WorkerFixture, index: number): Promise<void> {
  const store = getPolarisControlStore(import.meta.url);
  const job = store.enqueueJob({
    kind: "vault-provision",
    dedupeKey: `performance-worker:${fixture.userId}:${fixture.vault}:${index}`,
    tenantId: fixture.userId,
    vaultId: fixture.vault,
    payload: { defaultDockerOnly: true, line: "vertical" },
    maxAttempts: 1,
  });
  await resumeDurableVaultJobs();
  const completed = store.getJob(job.id);
  if (completed?.status !== "succeeded") {
    throw new ControlPlaneBenchmarkError(
      `Synthetic durable worker job did not terminate as expected (${completed?.status ?? "missing"})`,
    );
  }
}

export async function runControlPlanePerformanceBenchmark(
  options: ControlPlanePerformanceBenchmarkOptions = {},
): Promise<ControlPlanePerformanceBenchmarkResult> {
  if (process.env[WORKER_ENV] !== "1") {
    throw new ControlPlaneBenchmarkError(
      "Run this benchmark through `pnpm --filter polaris run benchmark:control-plane` so it uses an isolated data root",
    );
  }
  const samples = positiveInteger(options.samples, "samples", DEFAULT_SAMPLES);
  const warmupSamples = positiveInteger(options.warmupSamples, "warmupSamples", DEFAULT_WARMUP_SAMPLES);
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-control-plane-performance-"));
  const controlStorePath = path.join(controlRoot, "control-store.sqlite");
  const workerStorePath = path.join(controlRoot, "worker.sqlite");
  const workerFixture = setupWorkerFixture();
  const restorePath = setEnv("PATH", `${createFakeDockerBin(controlRoot)}:${process.env.PATH ?? ""}`);
  const restoreGatewaySecret = setEnv("POLARIS_WANGHAI_GATEWAY_MASTER_SECRET", WORKER_GATEWAY_SECRET);
  const restoreAllowedOrigins = setEnv("POLARIS_PORTAL_ALLOWED_ORIGINS", "https://performance.example.test");
  const restoreControlStorePath = setEnv("POLARIS_CONTROL_STORE_PATH", controlStorePath);
  const observations: Record<Operation, number[]> = {
    "control-store.mutation-admission": [],
    "worker.provision": [],
  };
  const errors: Record<Operation, number> = {
    "control-store.mutation-admission": 0,
    "worker.provision": 0,
  };
  const profiles: {
    controlStore?: CpuProfileArtifact;
    worker?: CpuProfileArtifact;
  } = {};
  try {
    closePolarisControlStore();
    const controlStore = PolarisControlStore.open(controlStorePath);
    try {
      for (let index = 0; index < warmupSamples; index += 1) {
        runControlStoreMutation(controlStore, index);
      }

      controlStore.close();
      closePolarisControlStore();
      process.env.POLARIS_CONTROL_STORE_PATH = workerStorePath;
      for (let index = 0; index < warmupSamples; index += 1) {
        await runProvisionWorkerSample(workerFixture, index);
      }
      const measuredControlStore = PolarisControlStore.open(controlStorePath);

      const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
      const cpuStartedAt = process.cpuUsage();
      let peakRssBytes = process.memoryUsage.rss();
      eventLoopDelay.enable();
      try {
        try {
          const controlStoreProfile = await captureCpuProfile({
            filePath: options.profileDir
              ? path.join(options.profileDir, "control-store.cpuprofile")
              : undefined,
            run: async () => {
              for (let index = warmupSamples; index < warmupSamples + samples; index += 1) {
                const startedAt = performance.now();
                try {
                  runControlStoreMutation(measuredControlStore, index);
                } catch (error) {
                  errors["control-store.mutation-admission"] += 1;
                  throw error;
                }
                observations["control-store.mutation-admission"].push(performance.now() - startedAt);
                peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
              }
            },
          });
          profiles.controlStore = controlStoreProfile.profile;
        } finally {
          measuredControlStore.close();
          closePolarisControlStore();
        }

        process.env.POLARIS_CONTROL_STORE_PATH = workerStorePath;
        const workerProfile = await captureCpuProfile({
          filePath: options.profileDir
            ? path.join(options.profileDir, "worker.cpuprofile")
            : undefined,
          run: async () => {
            for (let index = warmupSamples; index < warmupSamples + samples; index += 1) {
              const startedAt = performance.now();
              try {
                await runProvisionWorkerSample(workerFixture, index);
              } catch (error) {
                errors["worker.provision"] += 1;
                throw error;
              }
              observations["worker.provision"].push(performance.now() - startedAt);
              peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
            }
          },
        });
        profiles.worker = workerProfile.profile;
      } finally {
        eventLoopDelay.disable();
      }
      const cpu = process.cpuUsage(cpuStartedAt);
      const processSummary: ControlPlaneProcessSummary = {
        userCpuMs: rounded(cpu.user / 1_000),
        systemCpuMs: rounded(cpu.system / 1_000),
        peakRssBytes,
        eventLoopDelay: {
          p50Ms: nanosecondsToMilliseconds(eventLoopDelay.percentile(50)),
          p95Ms: nanosecondsToMilliseconds(eventLoopDelay.percentile(95)),
          p99Ms: nanosecondsToMilliseconds(eventLoopDelay.percentile(99)),
          maxMs: nanosecondsToMilliseconds(eventLoopDelay.max),
        },
      };

      return {
        kind: "polaris-control-plane-performance-benchmark",
        recordedAt: new Date().toISOString(),
        fixture: { samples, warmupSamples },
        runtime: {
          node: process.version,
          platform: process.platform,
          release: os.release(),
        },
        operations: {
          "control-store.mutation-admission": summarize(observations["control-store.mutation-admission"]),
          "worker.provision": summarize(observations["worker.provision"]),
        },
        errors,
        ...(profiles.controlStore && profiles.worker ? { profiles: {
          controlStore: profiles.controlStore,
          worker: profiles.worker,
        } } : {}),
        process: processSummary,
      };
    } finally {
      try {
        controlStore.close();
      } catch {
        // The worker phase closes and reopens the singleton independently.
      }
      closePolarisControlStore();
    }
  } finally {
    restorePath();
    restoreGatewaySecret();
    restoreAllowedOrigins();
    restoreControlStorePath();
    closePolarisControlStore();
    fs.rmSync(workerFixture.userRoot, { recursive: true, force: true });
    fs.rmSync(workerFixture.profilePath, { force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }
}

function parseArgument(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ControlPlaneBenchmarkError(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseOptions(argv: string[]): ControlPlanePerformanceBenchmarkOptions & { output?: string } {
  const options: ControlPlanePerformanceBenchmarkOptions & { output?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--") continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
      throw new ControlPlaneBenchmarkError(`${flag} requires a value`);
    }
    index += 1;
    if (flag === "--samples") options.samples = parseArgument(value, "--samples");
    else if (flag === "--warmup-samples") options.warmupSamples = parseArgument(value, "--warmup-samples");
    else if (flag === "--profile-dir") options.profileDir = value;
    else if (flag === "--output") options.output = value;
    else throw new ControlPlaneBenchmarkError(`Unsupported argument: ${flag}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const result = await runControlPlanePerformanceBenchmark(options);
  const payload = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(options.output, payload, "utf8");
  }
  process.stdout.write(payload);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
