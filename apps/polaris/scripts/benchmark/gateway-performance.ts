import { once } from "node:events";
import fs from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";
import { captureCpuProfile, type CpuProfileArtifact } from "./cpu-profile.js";
import {
  scaffoldDockerVault,
  scaffoldUserProfileById,
  vaultConfigPath,
} from "../config/scaffold.js";
import { createManagedSshCredential } from "../config/credentials.js";
import { wanghaiGatewayId } from "../core/portal.js";
import { writeVaultStatus } from "../output/state-store.js";
import { createPortalServer } from "../portal/server.js";
import {
  closePolarisControlStore,
} from "../portal/control-store.js";
import {
  deleteUserMapEntriesForPolarisUserId,
  upsertUserMapEntry,
} from "../portal/user-map.js";
import { polarisUsersRoot } from "../utils/paths.js";

const USER_ROOT = polarisUsersRoot(import.meta.url);
const MASTER_SECRET = "0123456789abcdef0123456789abcdef";
const DEFAULT_SAMPLES = 100;
const DEFAULT_WARMUP_SAMPLES = 10;
const DEFAULT_VAULTS = 10;
const WORKER_ENV = "POLARIS_GATEWAY_PERFORMANCE_BENCHMARK_WORKER";

type Operation =
  | "portal.hosts.list"
  | "gateway.launch"
  | "gateway.exchange"
  | "gateway.read"
  | "gateway.mutation";

export interface GatewayPerformanceBenchmarkOptions {
  samples?: number;
  vaults?: number;
  warmupSamples?: number;
  profileDir?: string;
}

export interface GatewayPerformanceOperationSummary {
  count: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface GatewayPerformanceProcessSummary {
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

export interface GatewayPerformanceBenchmarkResult {
  kind: "polaris-gateway-performance-benchmark";
  recordedAt: string;
  fixture: {
    samples: number;
    vaults: number;
    warmupSamples: number;
  };
  runtime: {
    node: string;
    platform: string;
    release: string;
  };
  operations: Record<Operation, GatewayPerformanceOperationSummary>;
  errors: Record<Operation, number>;
  profiles?: {
    boundedMutation: CpuProfileArtifact;
  };
  process: GatewayPerformanceProcessSummary;
}

class GatewayBenchmarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayBenchmarkError";
  }
}

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

function positiveInteger(value: number | undefined, label: string, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new GatewayBenchmarkError(`${label} must be a positive integer`);
  }
  return resolved;
}

function setEnv(name: string, value: string): () => void {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new GatewayBenchmarkError("Benchmark server did not expose a TCP port");
  }
  return address.port;
}

async function close(server: Server | null): Promise<void> {
  if (!server || !server.listening) return;
  server.close();
  await once(server, "close");
}

function percentile(samples: number[], percentileValue: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * percentileValue) - 1);
  return rounded(sorted[index] ?? 0);
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function nanosecondsToMilliseconds(value: number): number {
  return rounded(value / 1_000_000);
}

function summarize(samples: number[]): GatewayPerformanceOperationSummary {
  return {
    count: samples.length,
    maxMs: rounded(Math.max(...samples)),
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
  };
}

function configureVaultUpstream(userId: string, vault: string, port: number): void {
  const configPath = vaultConfigPath(vault, "docker", userId);
  const config = (yaml.load(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<string, unknown>;
  const service = config.service as Record<string, unknown> | undefined;
  const ports = Array.isArray(service?.ports) ? service.ports : [];
  const wanghaiPort = ports.find((entry) => (
    entry
    && typeof entry === "object"
    && (entry as Record<string, unknown>).name === "wanghai"
  )) as Record<string, unknown> | undefined;
  if (!wanghaiPort) {
    throw new GatewayBenchmarkError("Benchmark Wanghai port was not scaffolded");
  }
  wanghaiPort.node_port = String(port);
  fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: 120, noRefs: true }), "utf8");
}

function writeRunningVaultStatus(userId: string, vault: string): void {
  writeVaultStatus({
    schemaVersion: 1.1,
    project: vault,
    driver: {
      selected: { backend: "docker" },
      status: "running",
    },
    paseo: {
      daemon: "absent",
      web: "unavailable",
      reconnectMode: "unknown",
      liveTarget: null,
      reconnectTarget: null,
    },
    details: {},
  }, userId);
}

function benchmarkUpstream(): Server {
  return createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/wanghai/api/internal/workspace-usage") {
      const body = JSON.stringify({
        schema_version: 1,
        category: "active_workspace",
        usage_bytes: 1_024,
        file_count: 1,
        entry_count: 1,
      });
      res.writeHead(200, {
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json; charset=utf-8",
      });
      res.end(body);
      return;
    }
    if (!String(req.url ?? "").startsWith("/wanghai")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = req.method === "POST"
      ? JSON.stringify({ workspace_id: "benchmark-workspace", created: true })
      : JSON.stringify({ workflows: [] });
    req.resume();
    res.writeHead(200, {
      "content-length": Buffer.byteLength(body),
      "content-type": "application/json; charset=utf-8",
    });
    res.end(body);
  });
}

async function issueGatewayMutation(input: {
  origin: string;
  cookie: string;
  samples: Record<Operation, number[]>;
  index: number;
  record: boolean;
}): Promise<void> {
  const startedAt = performance.now();
  const response = await fetch(`${input.origin}/g/api/workspaces`, {
    headers: {
      cookie: input.cookie,
      "content-type": "application/json",
      "idempotency-key": `benchmark-mutation-${input.record ? "measured" : "warmup"}-${input.index}`,
      origin: input.origin,
    },
    method: "POST",
    body: JSON.stringify({
      workspace_id: `benchmark-workspace-${input.record ? "measured" : "warmup"}-${input.index}`,
      workspace_type: "research",
    }),
  });
  await response.arrayBuffer();
  if (input.record) {
    input.samples["gateway.mutation"].push(performance.now() - startedAt);
  }
  if (response.status !== 200) {
    throw new GatewayBenchmarkError("Gateway mutation benchmark failed");
  }
}

async function timedFetch(
  samples: Record<Operation, number[]>,
  operation: Operation,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const startedAt = performance.now();
  const response = await fetch(url, init);
  await response.arrayBuffer();
  samples[operation].push(performance.now() - startedAt);
  return response;
}

async function issueGatewaySession(input: {
  origin: string;
  samples: Record<Operation, number[]>;
  wanghaiId: string;
  record: boolean;
}): Promise<string> {
  const launchOperation = input.record ? "gateway.launch" : null;
  const launchStartedAt = performance.now();
  const launchResponse = await fetch(
    `${input.origin}/api/g/${encodeURIComponent(input.wanghaiId)}/launch`,
    {
      headers: { origin: input.origin },
      method: "POST",
    },
  );
  const launchBody = await launchResponse.json() as { portalUrl?: unknown };
  if (launchOperation) {
    input.samples[launchOperation].push(performance.now() - launchStartedAt);
  }
  if (launchResponse.status !== 200 || typeof launchBody.portalUrl !== "string") {
    throw new GatewayBenchmarkError("Gateway launch did not return a portal URL");
  }

  const exchangeOperation = input.record ? "gateway.exchange" : null;
  const exchangeStartedAt = performance.now();
  const exchangeResponse = await fetch(launchBody.portalUrl, { redirect: "manual" });
  await exchangeResponse.arrayBuffer();
  if (exchangeOperation) {
    input.samples[exchangeOperation].push(performance.now() - exchangeStartedAt);
  }
  const cookie = exchangeResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  if (exchangeResponse.status !== 302 || !cookie) {
    throw new GatewayBenchmarkError("Gateway ticket exchange did not set a session cookie");
  }
  return cookie;
}

export async function runGatewayPerformanceBenchmark(
  options: GatewayPerformanceBenchmarkOptions = {},
): Promise<GatewayPerformanceBenchmarkResult> {
  if (process.env[WORKER_ENV] !== "1") {
    throw new GatewayBenchmarkError(
      "Run this benchmark through `pnpm --filter polaris run benchmark:gateway` so it uses an isolated data root",
    );
  }
  const samples = positiveInteger(options.samples, "samples", DEFAULT_SAMPLES);
  const vaults = positiveInteger(options.vaults, "vaults", DEFAULT_VAULTS);
  const warmupSamples = positiveInteger(options.warmupSamples, "warmupSamples", DEFAULT_WARMUP_SAMPLES);
  const userId = uniqueName("performance-user");
  const targetVault = "performance-vault-01";
  const controlStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-performance-store-"));
  const observations: Record<Operation, number[]> = {
    "portal.hosts.list": [],
    "gateway.launch": [],
    "gateway.exchange": [],
    "gateway.read": [],
    "gateway.mutation": [],
  };
  const errors: Record<Operation, number> = {
    "portal.hosts.list": 0,
    "gateway.launch": 0,
    "gateway.exchange": 0,
    "gateway.read": 0,
    "gateway.mutation": 0,
  };
  const restores = [
    setEnv("POLARIS_AUTH_MODE", "disabled"),
    setEnv("POLARIS_AUTH_DEFAULT_USER_ID", userId),
    setEnv("POLARIS_AUTH_DEFAULT_ROLE", "user"),
    setEnv("POLARIS_AUTH_DEFAULT_PLAN", "pro"),
    setEnv("POLARIS_WANGHAI_GATEWAY_MASTER_SECRET", MASTER_SECRET),
    setEnv("POLARIS_WANGHAI_RATE_LIMIT_READS_PER_MINUTE", String(Math.max(10_000, samples * 4))),
    setEnv("POLARIS_WANGHAI_RATE_LIMIT_MUTATIONS_PER_MINUTE", String(Math.max(10_000, samples * 2))),
    setEnv("POLARIS_CONTROL_STORE_PATH", path.join(controlStoreRoot, "control.sqlite")),
  ];
  let upstream: Server | null = null;
  let portal: Server | null = null;
  try {
    upstream = benchmarkUpstream();
    const upstreamPort = await listen(upstream);

    scaffoldUserProfileById({
      id: userId,
      name: "Performance Benchmark User",
      email: "performance-benchmark@example.test",
    });
    createManagedSshCredential({
      userProfileId: userId,
      credentialId: "benchmark-ssh",
      label: "Performance Benchmark SSH",
      activate: true,
    });
    await upsertUserMapEntry(userId, {
      polarisUserId: userId,
      role: "user",
      plan: "pro",
      line: "vertical",
    });

    for (let index = 1; index <= vaults; index += 1) {
      const vault = `performance-vault-${String(index).padStart(2, "0")}`;
      scaffoldDockerVault(vault, userId, {
        line: "vertical",
        paseoFreeWanghaiTest: true,
      });
      configureVaultUpstream(userId, vault, upstreamPort);
      writeRunningVaultStatus(userId, vault);
    }

    portal = createPortalServer(0);
    await once(portal, "listening");
    const address = portal.address();
    if (!address || typeof address === "string") {
      throw new GatewayBenchmarkError("Benchmark portal did not expose a TCP port");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    restores.push(setEnv("POLARIS_WANGHAI_GATEWAY_ORIGIN", origin));
    const targetWanghaiId = wanghaiGatewayId(userId, targetVault);

    for (let index = 0; index < warmupSamples; index += 1) {
      const hosts = await fetch(`${origin}/api/polaris-hosts`);
      await hosts.arrayBuffer();
      if (hosts.status !== 200) throw new GatewayBenchmarkError("Host-list warmup failed");
      const cookie = await issueGatewaySession({
        origin,
        samples: observations,
        wanghaiId: targetWanghaiId,
        record: false,
      });
      const read = await fetch(`${origin}/g/api/prebuilt-workflows?workspace_type=ecommerce`, {
        headers: { cookie },
      });
      await read.arrayBuffer();
      if (read.status !== 200) throw new GatewayBenchmarkError("Gateway-read warmup failed");
      await issueGatewayMutation({
        origin,
        cookie,
        samples: observations,
        index,
        record: false,
      });
    }

    const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
    const cpuStartedAt = process.cpuUsage();
    let peakRssBytes = process.memoryUsage.rss();
    const profiles: { boundedMutation?: CpuProfileArtifact } = {};
    eventLoopDelay.enable();
    try {
      for (let index = 0; index < samples; index += 1) {
        const hosts = await timedFetch(
          observations,
          "portal.hosts.list",
          `${origin}/api/polaris-hosts`,
        );
        if (hosts.status !== 200) {
          errors["portal.hosts.list"] += 1;
          throw new GatewayBenchmarkError("Host-list benchmark failed");
        }
        const cookie = await issueGatewaySession({
          origin,
          samples: observations,
          wanghaiId: targetWanghaiId,
          record: true,
        });
        const read = await timedFetch(
          observations,
          "gateway.read",
          `${origin}/g/api/prebuilt-workflows?workspace_type=ecommerce`,
          { headers: { cookie } },
        );
        if (read.status !== 200) {
          errors["gateway.read"] += 1;
          throw new GatewayBenchmarkError("Gateway-read benchmark failed");
        }
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
      }
      const mutationCookie = await issueGatewaySession({
        origin,
        samples: observations,
        wanghaiId: targetWanghaiId,
        record: false,
      });
      const mutationProfile = await captureCpuProfile({
        filePath: options.profileDir
          ? path.join(options.profileDir, "bounded-mutation.cpuprofile")
          : undefined,
        run: async () => {
          for (let index = 0; index < samples; index += 1) {
            try {
              await issueGatewayMutation({
                origin,
                cookie: mutationCookie,
                samples: observations,
                index,
                record: true,
              });
            } catch (error) {
              errors["gateway.mutation"] += 1;
              throw error;
            }
            peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
          }
        },
      });
      profiles.boundedMutation = mutationProfile.profile;
    } finally {
      eventLoopDelay.disable();
    }
    const cpu = process.cpuUsage(cpuStartedAt);

    return {
      kind: "polaris-gateway-performance-benchmark",
      recordedAt: new Date().toISOString(),
      fixture: { samples, vaults, warmupSamples },
      runtime: {
        node: process.version,
        platform: process.platform,
        release: os.release(),
      },
      operations: {
        "portal.hosts.list": summarize(observations["portal.hosts.list"]),
        "gateway.launch": summarize(observations["gateway.launch"]),
        "gateway.exchange": summarize(observations["gateway.exchange"]),
        "gateway.read": summarize(observations["gateway.read"]),
        "gateway.mutation": summarize(observations["gateway.mutation"]),
      },
      errors,
      ...(profiles.boundedMutation ? { profiles: { boundedMutation: profiles.boundedMutation } } : {}),
      process: {
        userCpuMs: rounded(cpu.user / 1_000),
        systemCpuMs: rounded(cpu.system / 1_000),
        peakRssBytes,
        eventLoopDelay: {
          p50Ms: nanosecondsToMilliseconds(eventLoopDelay.percentile(50)),
          p95Ms: nanosecondsToMilliseconds(eventLoopDelay.percentile(95)),
          p99Ms: nanosecondsToMilliseconds(eventLoopDelay.percentile(99)),
          maxMs: nanosecondsToMilliseconds(eventLoopDelay.max),
        },
      },
    };
  } finally {
    await close(portal);
    await close(upstream);
    await deleteUserMapEntriesForPolarisUserId(userId);
    fs.rmSync(path.join(USER_ROOT, userId), { recursive: true, force: true });
    fs.rmSync(path.join(USER_ROOT, "profiles", `${userId}.yaml`), { force: true });
    closePolarisControlStore();
    fs.rmSync(controlStoreRoot, { recursive: true, force: true });
    for (const restore of restores.reverse()) restore();
  }
}

function parseArgument(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new GatewayBenchmarkError(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseOptions(argv: string[]): GatewayPerformanceBenchmarkOptions & { output?: string } {
  const options: GatewayPerformanceBenchmarkOptions & { output?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--") {
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
      throw new GatewayBenchmarkError(`${flag} requires a value`);
    }
    index += 1;
    if (flag === "--samples") options.samples = parseArgument(value, "--samples");
    else if (flag === "--vaults") options.vaults = parseArgument(value, "--vaults");
    else if (flag === "--warmup-samples") options.warmupSamples = parseArgument(value, "--warmup-samples");
    else if (flag === "--profile-dir") options.profileDir = value;
    else if (flag === "--output") options.output = value;
    else throw new GatewayBenchmarkError(`Unsupported argument: ${flag}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const result = await runGatewayPerformanceBenchmark(options);
  const payload = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(options.output, payload, "utf8");
  }
  process.stdout.write(payload);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
