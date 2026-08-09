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
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import {
  scaffoldDockerVault,
  scaffoldUserProfileById,
  vaultConfigPath,
} from "../config/scaffold.js";
import { createManagedSshCredential } from "../config/credentials.js";
import { wanghaiGatewayId } from "../core/portal.js";
import { writeVaultStatus } from "../output/state-store.js";
import { createPortalServer } from "../portal/server.js";
import { closePolarisControlStore } from "../portal/control-store.js";
import {
  deleteUserMapEntriesForPolarisUserId,
  upsertUserMapEntry,
} from "../portal/user-map.js";
import { polarisUsersRoot } from "../utils/paths.js";

const USER_ROOT = polarisUsersRoot(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const RELEASE_PROFILE_PATH = path.join(
  REPOSITORY_ROOT,
  "config",
  "release-profiles",
  "0.3.0-single-host.json",
);
const MASTER_SECRET = "0123456789abcdef0123456789abcdef";
const DEFAULT_USERS = 20;
const DEFAULT_ROUNDS = 5;
const DEFAULT_WARMUP_ROUNDS = 1;
const WORKER_ENV = "POLARIS_CONCURRENT_USER_CAPACITY_BENCHMARK_WORKER";
const USER_HEADER = "x-auth-request-user";

function loadProfileTargets(): {
  maxActiveVaults: number;
  readP95Ms: number;
  gatewayLaunchSuccessPercent: number;
  max5xxPercent: number;
} {
  const raw = JSON.parse(fs.readFileSync(RELEASE_PROFILE_PATH, "utf8")) as {
    capacity?: { maxActiveVaults?: number };
    slo?: {
      readP95Ms?: number;
      gatewayLaunchSuccessPercent?: number;
      max5xxPercent?: number;
    };
  };
  const maxActiveVaults = Number(raw.capacity?.maxActiveVaults);
  const readP95Ms = Number(raw.slo?.readP95Ms);
  const gatewayLaunchSuccessPercent = Number(raw.slo?.gatewayLaunchSuccessPercent);
  const max5xxPercent = Number(raw.slo?.max5xxPercent);
  if (
    !Number.isInteger(maxActiveVaults)
    || maxActiveVaults <= 0
    || !Number.isFinite(readP95Ms)
    || readP95Ms <= 0
    || !Number.isFinite(gatewayLaunchSuccessPercent)
    || gatewayLaunchSuccessPercent <= 0
    || !Number.isFinite(max5xxPercent)
    || max5xxPercent < 0
  ) {
    throw new Error("Release profile is missing capacity or SLO targets");
  }
  return {
    maxActiveVaults,
    readP95Ms,
    gatewayLaunchSuccessPercent,
    max5xxPercent,
  };
}

type Operation =
  | "portal.login"
  | "portal.hosts.list"
  | "gateway.launch"
  | "gateway.exchange"
  | "gateway.read";

export interface ConcurrentUserCapacityOptions {
  users?: number;
  rounds?: number;
  warmupRounds?: number;
}

export interface ConcurrentUserCapacityOperationSummary {
  count: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface ConcurrentUserCapacityResult {
  kind: "polaris-concurrent-user-capacity-benchmark";
  recordedAt: string;
  fixture: {
    users: number;
    rounds: number;
    warmupRounds: number;
    authMode: "oauth2-proxy";
  };
  profileTargets: {
    readP95Ms: number;
    gatewayLaunchSuccessPercent: number;
    max5xxPercent: number;
  };
  runtime: {
    node: string;
    platform: string;
    release: string;
  };
  operations: Record<Operation, ConcurrentUserCapacityOperationSummary>;
  errors: Record<Operation, number>;
  process: {
    userCpuMs: number;
    systemCpuMs: number;
    peakRssBytes: number;
    eventLoopDelay: {
      maxMs: number;
      p50Ms: number;
      p95Ms: number;
      p99Ms: number;
    };
  };
  gatewayLaunchSuccessPercent: number;
  fiveXxPercent: number;
  readP95Ms: number;
  passed: boolean;
}

class ConcurrentCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrentCapacityError";
  }
}

interface SyntheticUser {
  authingUsername: string;
  polarisUserId: string;
  vault: string;
  wanghaiId: string;
}

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

function positiveInteger(value: number | undefined, label: string, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new ConcurrentCapacityError(`${label} must be a positive integer`);
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
    throw new ConcurrentCapacityError("Benchmark server did not expose a TCP port");
  }
  return address.port;
}

async function close(server: Server | null): Promise<void> {
  if (!server || !server.listening) return;
  server.close();
  await once(server, "close");
}

function percentile(samples: number[], percentileValue: number): number {
  if (samples.length === 0) return 0;
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

function summarize(samples: number[]): ConcurrentUserCapacityOperationSummary {
  if (samples.length === 0) {
    return { count: 0, maxMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  }
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
    throw new ConcurrentCapacityError("Benchmark Wanghai port was not scaffolded");
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
    if (!String(req.url ?? "").startsWith("/wanghai")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = JSON.stringify({ workflows: [], ok: true });
    req.resume();
    res.writeHead(200, {
      "content-length": Buffer.byteLength(body),
      "content-type": "application/json; charset=utf-8",
    });
    res.end(body);
  });
}

function authHeaders(user: SyntheticUser, origin: string): Record<string, string> {
  return {
    [USER_HEADER]: user.authingUsername,
    origin,
  };
}

async function timedOperation(
  samples: Record<Operation, number[]>,
  operation: Operation,
  run: () => Promise<Response>,
): Promise<Response> {
  const startedAt = performance.now();
  const response = await run();
  await response.arrayBuffer().catch(() => undefined);
  samples[operation].push(performance.now() - startedAt);
  return response;
}

async function runUserRound(input: {
  origin: string;
  user: SyntheticUser;
  samples: Record<Operation, number[]>;
  errors: Record<Operation, number>;
  record: boolean;
}): Promise<void> {
  const headers = authHeaders(input.user, input.origin);

  const login = input.record
    ? await timedOperation(input.samples, "portal.login", () =>
      fetch(`${input.origin}/api/session`, { headers }))
    : await fetch(`${input.origin}/api/session`, { headers });
  if (!input.record) await login.arrayBuffer().catch(() => undefined);
  if (login.status !== 200) {
    if (input.record) input.errors["portal.login"] += 1;
    throw new ConcurrentCapacityError(`portal.login failed for ${input.user.polarisUserId}`);
  }
  if (input.record) {
    // Re-read is already consumed by timedOperation; fetch again only when needed.
  }

  const hosts = input.record
    ? await timedOperation(input.samples, "portal.hosts.list", () =>
      fetch(`${input.origin}/api/polaris-hosts`, { headers }))
    : await fetch(`${input.origin}/api/polaris-hosts`, { headers });
  if (!input.record) await hosts.arrayBuffer().catch(() => undefined);
  if (hosts.status !== 200) {
    if (input.record) input.errors["portal.hosts.list"] += 1;
    throw new ConcurrentCapacityError(`portal.hosts.list failed for ${input.user.polarisUserId}`);
  }

  const launchStartedAt = performance.now();
  const launchResponse = await fetch(
    `${input.origin}/api/g/${encodeURIComponent(input.user.wanghaiId)}/launch`,
    {
      headers,
      method: "POST",
    },
  );
  const launchBody = await launchResponse.json() as { portalUrl?: unknown };
  if (input.record) {
    input.samples["gateway.launch"].push(performance.now() - launchStartedAt);
  }
  if (launchResponse.status !== 200 || typeof launchBody.portalUrl !== "string") {
    if (input.record) input.errors["gateway.launch"] += 1;
    throw new ConcurrentCapacityError(`gateway.launch failed for ${input.user.polarisUserId}`);
  }

  const exchangeStartedAt = performance.now();
  const exchangeResponse = await fetch(launchBody.portalUrl, {
    headers,
    redirect: "manual",
  });
  await exchangeResponse.arrayBuffer().catch(() => undefined);
  if (input.record) {
    input.samples["gateway.exchange"].push(performance.now() - exchangeStartedAt);
  }
  const setCookies = typeof exchangeResponse.headers.getSetCookie === "function"
    ? exchangeResponse.headers.getSetCookie()
    : [];
  const cookie = (setCookies[0] ?? exchangeResponse.headers.get("set-cookie") ?? "")
    .split(";", 1)[0]
    .trim();
  if (exchangeResponse.status !== 302 || !cookie.includes("=")) {
    if (input.record) input.errors["gateway.exchange"] += 1;
    throw new ConcurrentCapacityError(
      `gateway.exchange failed for ${input.user.polarisUserId} (status ${exchangeResponse.status})`,
    );
  }

  const read = input.record
    ? await timedOperation(input.samples, "gateway.read", () =>
      fetch(`${input.origin}/g/api/prebuilt-workflows?workspace_type=ecommerce`, {
        headers: { cookie, ...headers },
      }))
    : await fetch(`${input.origin}/g/api/prebuilt-workflows?workspace_type=ecommerce`, {
      headers: { cookie, ...headers },
    });
  if (!input.record) await read.arrayBuffer().catch(() => undefined);
  if (read.status !== 200) {
    if (input.record) input.errors["gateway.read"] += 1;
    throw new ConcurrentCapacityError(`gateway.read failed for ${input.user.polarisUserId}`);
  }
}

export async function runConcurrentUserCapacityBenchmark(
  options: ConcurrentUserCapacityOptions = {},
): Promise<ConcurrentUserCapacityResult> {
  if (process.env[WORKER_ENV] !== "1") {
    throw new ConcurrentCapacityError(
      "Run through `pnpm --filter polaris run benchmark:concurrent-users` so it uses an isolated data root",
    );
  }

  const users = positiveInteger(options.users, "users", DEFAULT_USERS);
  const rounds = positiveInteger(options.rounds, "rounds", DEFAULT_ROUNDS);
  const warmupRounds = positiveInteger(options.warmupRounds, "warmupRounds", DEFAULT_WARMUP_ROUNDS);
  const runPrefix = uniqueName("capacity-user");
  const controlStoreParent = String(process.env.POLARIS_BENCHMARK_TMPDIR ?? "").trim()
    || path.resolve(REPOSITORY_ROOT, ".tmp/polaris-bench");
  fs.mkdirSync(controlStoreParent, { recursive: true });
  const controlStoreRoot = fs.mkdtempSync(path.join(controlStoreParent, "polaris-concurrent-store-"));
  const profile = loadProfileTargets();
  if (users > profile.maxActiveVaults) {
    throw new ConcurrentCapacityError(
      `users (${users}) exceeds release profile maxActiveVaults (${profile.maxActiveVaults})`,
    );
  }
  const observations: Record<Operation, number[]> = {
    "portal.login": [],
    "portal.hosts.list": [],
    "gateway.launch": [],
    "gateway.exchange": [],
    "gateway.read": [],
  };
  const errors: Record<Operation, number> = {
    "portal.login": 0,
    "portal.hosts.list": 0,
    "gateway.launch": 0,
    "gateway.exchange": 0,
    "gateway.read": 0,
  };
  const restores = [
    setEnv("POLARIS_AUTH_MODE", "oauth2-proxy"),
    setEnv("POLARIS_WANGHAI_GATEWAY_MASTER_SECRET", MASTER_SECRET),
    setEnv(
      "POLARIS_WANGHAI_RATE_LIMIT_READS_PER_MINUTE",
      String(Math.max(10_000, users * rounds * 20)),
    ),
    setEnv(
      "POLARIS_WANGHAI_RATE_LIMIT_MUTATIONS_PER_MINUTE",
      String(Math.max(10_000, users * rounds * 10)),
    ),
    setEnv("POLARIS_CONTROL_STORE_PATH", path.join(controlStoreRoot, "control.sqlite")),
    setEnv("POLARIS_MAX_ACTIVE_VAULTS", String(profile.maxActiveVaults)),
  ];

  const syntheticUsers: SyntheticUser[] = [];
  let upstream: Server | null = null;
  let portal: Server | null = null;

  try {
    upstream = benchmarkUpstream();
    const upstreamPort = await listen(upstream);

    for (let index = 1; index <= users; index += 1) {
      const suffix = String(index).padStart(2, "0");
      const polarisUserId = `${runPrefix}-${suffix}`;
      const authingUsername = `capacity-auth-${runPrefix}-${suffix}`;
      const vault = `capacity-vault-${suffix}`;
      scaffoldUserProfileById({
        id: polarisUserId,
        name: `Capacity User ${suffix}`,
        email: `${polarisUserId}@example.test`,
      });
      createManagedSshCredential({
        userProfileId: polarisUserId,
        credentialId: "capacity-ssh",
        label: "Capacity SSH",
        activate: true,
      });
      await upsertUserMapEntry(authingUsername, {
        polarisUserId,
        role: "user",
        plan: "pro",
        line: "vertical",
      });
      scaffoldDockerVault(vault, polarisUserId, {
        line: "vertical",
        paseoFreeWanghaiTest: true,
      });
      configureVaultUpstream(polarisUserId, vault, upstreamPort);
      writeRunningVaultStatus(polarisUserId, vault);
      syntheticUsers.push({
        authingUsername,
        polarisUserId,
        vault,
        wanghaiId: wanghaiGatewayId(polarisUserId, vault),
      });
    }

    portal = createPortalServer(0);
    await once(portal, "listening");
    const address = portal.address();
    if (!address || typeof address === "string") {
      throw new ConcurrentCapacityError("Benchmark portal did not expose a TCP port");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    restores.push(setEnv("POLARIS_WANGHAI_GATEWAY_ORIGIN", origin));

    for (let round = 0; round < warmupRounds; round += 1) {
      await Promise.all(syntheticUsers.map((user) => runUserRound({
        origin,
        user,
        samples: observations,
        errors,
        record: false,
      })));
    }

    const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
    const cpuStartedAt = process.cpuUsage();
    let peakRssBytes = process.memoryUsage.rss();
    eventLoopDelay.enable();
    try {
      for (let round = 0; round < rounds; round += 1) {
        await Promise.all(syntheticUsers.map((user) => runUserRound({
          origin,
          user,
          samples: observations,
          errors,
          record: true,
        })));
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
      }
    } finally {
      eventLoopDelay.disable();
    }
    const cpu = process.cpuUsage(cpuStartedAt);

    const operations = {
      "portal.login": summarize(observations["portal.login"]),
      "portal.hosts.list": summarize(observations["portal.hosts.list"]),
      "gateway.launch": summarize(observations["gateway.launch"]),
      "gateway.exchange": summarize(observations["gateway.exchange"]),
      "gateway.read": summarize(observations["gateway.read"]),
    } as const;
    const launch = operations["gateway.launch"];
    const gatewayLaunchSuccessPercent = launch.count > 0
      ? rounded(((launch.count - errors["gateway.launch"]) / launch.count) * 100)
      : 0;
    const totalOps = Object.values(operations).reduce((sum, item) => sum + item.count, 0);
    const totalErrors = Object.values(errors).reduce((sum, item) => sum + item, 0);
    // Synthetic upstream never returns 5xx; treat operation errors as failure budget.
    const fiveXxPercent = totalOps > 0 ? rounded((totalErrors / totalOps) * 100) : 100;
    const readCandidates = [
      operations["portal.login"].p95Ms,
      operations["portal.hosts.list"].p95Ms,
      operations["gateway.launch"].p95Ms,
      operations["gateway.exchange"].p95Ms,
      operations["gateway.read"].p95Ms,
    ];
    const readP95Ms = rounded(Math.max(...readCandidates));
    const passed = totalErrors === 0
      && gatewayLaunchSuccessPercent >= profile.gatewayLaunchSuccessPercent
      && fiveXxPercent <= profile.max5xxPercent
      && readP95Ms <= profile.readP95Ms;

    return {
      kind: "polaris-concurrent-user-capacity-benchmark",
      recordedAt: new Date().toISOString(),
      fixture: {
        users,
        rounds,
        warmupRounds,
        authMode: "oauth2-proxy",
      },
      profileTargets: {
        readP95Ms: profile.readP95Ms,
        gatewayLaunchSuccessPercent: profile.gatewayLaunchSuccessPercent,
        max5xxPercent: profile.max5xxPercent,
      },
      runtime: {
        node: process.version,
        platform: process.platform,
        release: os.release(),
      },
      operations,
      errors,
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
      gatewayLaunchSuccessPercent,
      fiveXxPercent,
      readP95Ms,
      passed,
    };
  } finally {
    await close(portal);
    await close(upstream);
    for (const user of syntheticUsers) {
      await deleteUserMapEntriesForPolarisUserId(user.polarisUserId).catch(() => undefined);
      fs.rmSync(path.join(USER_ROOT, user.polarisUserId), { recursive: true, force: true });
      fs.rmSync(path.join(USER_ROOT, "profiles", `${user.polarisUserId}.yaml`), { force: true });
    }
    closePolarisControlStore();
    fs.rmSync(controlStoreRoot, { recursive: true, force: true });
    for (const restore of restores.reverse()) restore();
  }
}

function parseArgument(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConcurrentCapacityError(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseOptions(argv: string[]): ConcurrentUserCapacityOptions & { output?: string } {
  const options: ConcurrentUserCapacityOptions & { output?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--") continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
      throw new ConcurrentCapacityError(`${flag} requires a value`);
    }
    index += 1;
    if (flag === "--users") options.users = parseArgument(value, "--users");
    else if (flag === "--rounds") options.rounds = parseArgument(value, "--rounds");
    else if (flag === "--warmup-rounds") options.warmupRounds = parseArgument(value, "--warmup-rounds");
    else if (flag === "--output") options.output = value;
    else throw new ConcurrentCapacityError(`Unsupported argument: ${flag}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const result = await runConcurrentUserCapacityBenchmark(options);
  const payload = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(options.output, payload, "utf8");
  }
  process.stdout.write(payload);
  if (!result.passed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
