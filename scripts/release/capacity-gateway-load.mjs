import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "../..");
const DEFAULT_PROFILE_PATH = path.join(
  REPOSITORY_ROOT,
  "config",
  "release-profiles",
  "0.3.0-single-host.json",
);
const DEFAULT_STAGES = [2, 5, 10];
const DEFAULT_ROUNDS = 5;
const WORKSPACE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const RUN_ID_PATTERN = /^[a-z][a-z0-9-]{0,36}$/u;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const POLARIS_GATEWAY_PATH = "/g";

const OPERATION_CATEGORIES = {
  "portal.login": "read",
  "portal.vault-list": "read",
  "gateway.launch": "read",
  "gateway.exchange": "read",
  "portal.navigation": "read",
  "portal.workflow-catalog": "read",
  "workspace.list": "read",
  "workspace.create": "mutation",
  "workspace.version": "read",
  "workspace.assets-list": "read",
  "workflow.status": "read",
  "product.create": "mutation",
  "product.asset-upload": "mutation",
};

class CapacityLoadError extends Error {
  constructor(message) {
    super(message);
    this.name = "CapacityLoadError";
  }
}

function fail(message) {
  throw new CapacityLoadError(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return value;
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

function jsonObject(response, record, operation) {
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch {
    record.error = `${operation} returned invalid JSON`;
    throw new CapacityLoadError(record.error);
  }
}

function normalizeOrigin(value, label) {
  const raw = requiredString(value, label);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${label} must be an HTTP(S) origin`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    fail(`${label} must be an HTTP(S) origin`);
  }
  return parsed.origin;
}

function normalizeLoopbackTransport(value) {
  const origin = normalizeOrigin(value, "transport_origin");
  const hostname = new URL(origin).hostname.toLowerCase();
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
    fail("transport_origin must use a loopback host");
  }
  return origin;
}

function polarisGatewayUrl(pathname, origin) {
  const url = new URL(pathname, origin);
  if (url.pathname === POLARIS_GATEWAY_PATH || url.pathname.startsWith(`${POLARIS_GATEWAY_PATH}/`)) {
    return url;
  }
  url.pathname = `${POLARIS_GATEWAY_PATH}${url.pathname === "/" ? "/" : url.pathname}`;
  return url;
}

function normalizeFixtureUser(raw, label) {
  if (!isRecord(raw)) {
    fail(`${label} must be an object`);
  }
  return {
    authingUserId: requiredString(raw.authing_user_id, `${label}.authing_user_id`),
    polarisUserId: requiredString(raw.polaris_user_id, `${label}.polaris_user_id`),
    vault: requiredString(raw.vault, `${label}.vault`),
  };
}

function optionalMetadata(raw) {
  if (!isRecord(raw)) return {};
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.trim()) result[key] = value.trim();
  }
  return result;
}

export function normalizeCapacityFixture(raw) {
  if (!isRecord(raw)) fail("fixture must be an object");
  if (raw.schema_version !== 1) fail("fixture.schema_version must be 1");
  if (raw.kind !== "polaris-capacity-gateway-fixture") {
    fail("fixture.kind must be polaris-capacity-gateway-fixture");
  }
  const auth = isRecord(raw.auth) ? raw.auth : null;
  if (!auth) fail("fixture.auth must be an object");
  const stagesRaw = isRecord(raw.stages) ? raw.stages : null;
  if (!stagesRaw) fail("fixture.stages must be an object");
  const stages = {};
  const identities = new Set();
  for (const [stage, users] of Object.entries(stagesRaw)) {
    if (!/^[1-9][0-9]*$/u.test(stage) || !Array.isArray(users) || users.length === 0) {
      fail("fixture.stages must contain positive numeric user groups");
    }
    stages[stage] = users.map((user, index) => {
      const normalized = normalizeFixtureUser(user, `fixture.stages.${stage}[${index}]`);
      if (identities.has(normalized.authingUserId)) {
        fail("fixture must not reuse an Authing identity across load stages");
      }
      identities.add(normalized.authingUserId);
      return normalized;
    });
  }
  return {
    auth: {
      cookie: requiredString(auth.cookie, "fixture.auth.cookie"),
      userHeader: requiredString(auth.user_header, "fixture.auth.user_header").toLowerCase(),
    },
    environment: requiredString(raw.environment, "fixture.environment"),
    metadata: optionalMetadata(raw.metadata),
    portalOrigin: normalizeOrigin(raw.portal_origin, "fixture.portal_origin"),
    stages,
    transportOrigin: normalizeLoopbackTransport(raw.transport_origin),
  };
}

export function loadCapacityProfile(profilePath = DEFAULT_PROFILE_PATH) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  } catch (error) {
    fail(`could not read release profile: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(raw) || !isRecord(raw.slo)) fail("release profile must contain slo");
  const slo = raw.slo;
  return {
    gatewayLaunchSuccessPercent: Number(slo.gatewayLaunchSuccessPercent),
    max5xxPercent: Number(slo.max5xxPercent),
    mutationP95Ms: Number(slo.mutationP95Ms),
    readP95Ms: Number(slo.readP95Ms),
  };
}

function normalizeProfile(profile) {
  for (const [key, value] of Object.entries(profile)) {
    if (!Number.isFinite(value) || value <= 0) fail(`release profile slo.${key} must be positive`);
  }
  return profile;
}

export function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * percentileValue) - 1);
  return rounded(sorted[index]);
}

export function summarizeCapacityOperations(records) {
  const byOperation = new Map();
  for (const record of records) {
    const group = byOperation.get(record.operation) ?? [];
    group.push(record);
    byOperation.set(record.operation, group);
  }
  const operationSummary = {};
  for (const [operation, group] of byOperation) {
    const statusCounts = {};
    for (const record of group) {
      const status = record.status === null ? "network-error" : String(record.status);
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    }
    const durations = group.map((record) => record.durationMs);
    operationSummary[operation] = {
      count: group.length,
      errors: group.filter((record) => record.error).length,
      maxMs: rounded(Math.max(...durations)),
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      statusCounts,
    };
  }
  return operationSummary;
}

function maxP95ForCategory(operationSummary, category) {
  const values = Object.entries(operationSummary)
    .filter(([operation]) => OPERATION_CATEGORIES[operation] === category)
    .map(([, summary]) => summary.p95Ms)
    .filter((value) => value !== null);
  return values.length ? rounded(Math.max(...values)) : null;
}

function workspaceIdFor(runId, stage, userIndex, round) {
  const workspaceId = `load-${runId}-s${stage}-u${userIndex + 1}-r${round}`;
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    fail("generated workspace ID is invalid; shorten --run-id");
  }
  return workspaceId;
}

function idempotencyKeyFor(runId, stage, userIndex, round, action) {
  return `${runId}-s${stage}-u${userIndex + 1}-r${round}-${action}`;
}

function mutationVersion(payload, record, operation) {
  const value = payload?.workspace_version;
  if (!Number.isSafeInteger(value) || value < 0) {
    record.error = `${operation} returned an invalid workspace version`;
    throw new CapacityLoadError(record.error);
  }
  return value;
}

function firstCookie(response, record, operation) {
  const setCookie = response.headers["set-cookie"];
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = values.map((value) => value.split(";", 1)[0]).find((value) => value.includes("="));
  if (!cookie) {
    record.error = `${operation} did not set a gateway session cookie`;
    throw new CapacityLoadError(record.error);
  }
  return cookie;
}

function fixtureMetadata(fixture) {
  return {
    ...(fixture.metadata.image_digest ? { imageDigest: fixture.metadata.image_digest } : {}),
    ...(fixture.metadata.polaris_commit ? { polarisCommit: fixture.metadata.polaris_commit } : {}),
    ...(fixture.metadata.wanghai_commit ? { wanghaiCommit: fixture.metadata.wanghai_commit } : {}),
  };
}

function requestUrl(transportOrigin, publicUrl) {
  const publicTarget = new URL(publicUrl);
  const transportTarget = new URL(transportOrigin);
  transportTarget.pathname = publicTarget.pathname;
  transportTarget.search = publicTarget.search;
  return { publicTarget, transportTarget };
}

async function encodeRequestBody(body, headers) {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof FormData) {
    const request = new Request("http://loopback.invalid/", { body, method: "POST" });
    const contentType = request.headers.get("content-type");
    if (contentType && !headers.has("content-type")) headers.set("content-type", contentType);
    return Buffer.from(await request.arrayBuffer());
  }
  fail("capacity request body is unsupported");
}

function transportRequest(target, input) {
  const client = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request({
      headers: Object.fromEntries(input.headers),
      hostname: target.hostname,
      method: input.method,
      path: `${target.pathname}${target.search}`,
      port: target.port || undefined,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy(new Error("capacity response exceeded the bounded limit"));
          return;
        }
        chunks.push(buffer);
      });
      response.once("error", reject);
      response.once("end", () => {
        resolve({
          body: Buffer.concat(chunks),
          headers: response.headers,
          status: response.statusCode ?? 0,
        });
      });
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("capacity request timed out"));
    });
    request.once("error", reject);
    if (input.body) request.end(input.body);
    else request.end();
  });
}

async function timedRequest(state, input) {
  const { publicTarget, transportTarget } = requestUrl(state.fixture.transportOrigin, input.publicUrl);
  const headers = new Headers(input.headers ?? {});
  headers.set("host", publicTarget.host);
  const startedAt = performance.now();
  let record;
  try {
    const body = await encodeRequestBody(input.body, headers);
    if (body) headers.set("content-length", String(body.byteLength));
    const response = await transportRequest(transportTarget, {
      body,
      headers,
      method: input.method ?? "GET",
    });
    record = {
      category: OPERATION_CATEGORIES[input.operation],
      durationMs: performance.now() - startedAt,
      operation: input.operation,
      status: response.status,
    };
    state.records.push(record);
    if (!input.expectedStatuses.includes(response.status)) {
      record.error = `${input.operation} returned an unexpected status`;
      throw new CapacityLoadError(record.error);
    }
    return { record, response };
  } catch (error) {
    if (!record) {
      record = {
        category: OPERATION_CATEGORIES[input.operation],
        durationMs: performance.now() - startedAt,
        error: `${input.operation} request failed`,
        operation: input.operation,
        status: null,
      };
      state.records.push(record);
    }
    throw error;
  }
}

function portalHeaders(fixture, user) {
  return {
    [fixture.auth.userHeader]: user.authingUserId,
    cookie: fixture.auth.cookie,
  };
}

function gatewayHeaders(cookie) {
  return { cookie };
}

function mutationHeaders(cookie, origin, idempotencyKey, version) {
  return {
    ...gatewayHeaders(cookie),
    "idempotency-key": idempotencyKey,
    origin,
    "x-polaris-expected-version": String(version),
  };
}

function expectedWanghaiHost(hosts, user, record) {
  const host = Array.isArray(hosts?.hosts)
    ? hosts.hosts.find((entry) => isRecord(entry) && entry.name === user.vault)
    : null;
  if (
    !host
    || typeof host.wanghaiId !== "string"
    || !host.wanghaiId
    || !Array.isArray(host.surfaces)
    || !host.surfaces.some((surface) => String(surface).toLowerCase() === "wanghai")
  ) {
    record.error = "portal.vault-list did not return the fixture vault";
    throw new CapacityLoadError(record.error);
  }
  return host.wanghaiId;
}

async function runUserRound(state, input) {
  const { fixture } = state;
  const portal = fixture.portalOrigin;
  const portalRequestHeaders = portalHeaders(fixture, input.user);

  const login = await timedRequest(state, {
    expectedStatuses: [200],
    headers: portalRequestHeaders,
    operation: "portal.login",
    publicUrl: new URL("/api/session", portal),
  });
  const session = await jsonObject(login.response, login.record, "portal.login");
  if (session?.polarisUserId !== input.user.polarisUserId) {
    login.record.error = "portal.login resolved an unexpected Polaris user";
    throw new CapacityLoadError(login.record.error);
  }

  const vaultList = await timedRequest(state, {
    expectedStatuses: [200],
    headers: portalRequestHeaders,
    operation: "portal.vault-list",
    publicUrl: new URL("/api/polaris-hosts", portal),
  });
  const wanghaiId = expectedWanghaiHost(
    await jsonObject(vaultList.response, vaultList.record, "portal.vault-list"),
    input.user,
    vaultList.record,
  );

  const launch = await timedRequest(state, {
    expectedStatuses: [200],
    headers: {
      ...portalRequestHeaders,
      origin: portal,
    },
    method: "POST",
    operation: "gateway.launch",
    publicUrl: new URL(`/api/g/${encodeURIComponent(wanghaiId)}/launch`, portal),
  });
  const launchBody = await jsonObject(launch.response, launch.record, "gateway.launch");
  let gatewayUrl;
  try {
    gatewayUrl = new URL(requiredString(launchBody?.portalUrl, "gateway launch portalUrl"));
  } catch (error) {
    launch.record.error = "gateway.launch returned an invalid portal URL";
    throw error;
  }
  if (gatewayUrl.origin !== portal || !gatewayUrl.pathname.startsWith(`${POLARIS_GATEWAY_PATH}/`)) {
    launch.record.error = "gateway.launch returned a non-Polaris gateway URL";
    throw new CapacityLoadError(launch.record.error);
  }

  const exchange = await timedRequest(state, {
    expectedStatuses: [302],
    operation: "gateway.exchange",
    publicUrl: gatewayUrl,
    redirect: "manual",
  });
  const gatewayCookie = firstCookie(exchange.response, exchange.record, "gateway.exchange");
  const gatewayOrigin = gatewayUrl.origin;

  await timedRequest(state, {
    expectedStatuses: [200],
    headers: gatewayHeaders(gatewayCookie),
    operation: "portal.navigation",
    publicUrl: polarisGatewayUrl("/", gatewayOrigin),
  });
  await timedRequest(state, {
    expectedStatuses: [200],
    headers: gatewayHeaders(gatewayCookie),
    operation: "portal.workflow-catalog",
    publicUrl: polarisGatewayUrl("/api/prebuilt-workflows?workspace_type=ecommerce", gatewayOrigin),
  });
  await timedRequest(state, {
    expectedStatuses: [200],
    headers: gatewayHeaders(gatewayCookie),
    operation: "workspace.list",
    publicUrl: polarisGatewayUrl("/api/workspaces", gatewayOrigin),
  });

  const workspaceId = workspaceIdFor(input.runId, input.stage, input.userIndex, input.round);
  const createWorkspace = await timedRequest(state, {
    body: JSON.stringify({
      customer: "Synthetic capacity fixture",
      description: "Loopback load evidence workspace.",
      workspace_id: workspaceId,
      workspace_type: "ecommerce",
    }),
    expectedStatuses: [201],
    headers: {
      ...gatewayHeaders(gatewayCookie),
      "content-type": "application/json",
      "idempotency-key": idempotencyKeyFor(input.runId, input.stage, input.userIndex, input.round, "workspace"),
      origin: gatewayOrigin,
    },
    method: "POST",
    operation: "workspace.create",
    publicUrl: polarisGatewayUrl("/api/workspaces", gatewayOrigin),
  });
  let workspaceVersion = mutationVersion(
    await jsonObject(createWorkspace.response, createWorkspace.record, "workspace.create"),
    createWorkspace.record,
    "workspace.create",
  );

  await timedRequest(state, {
    expectedStatuses: [200],
    headers: gatewayHeaders(gatewayCookie),
    operation: "workspace.version",
    publicUrl: polarisGatewayUrl(`/api/workspaces/${encodeURIComponent(workspaceId)}/version`, gatewayOrigin),
  });
  await timedRequest(state, {
    expectedStatuses: [200],
    headers: gatewayHeaders(gatewayCookie),
    operation: "workspace.assets-list",
    publicUrl: polarisGatewayUrl(`/api/workspaces/${encodeURIComponent(workspaceId)}/assets`, gatewayOrigin),
  });
  await timedRequest(state, {
    expectedStatuses: [200],
    headers: gatewayHeaders(gatewayCookie),
    operation: "workflow.status",
    publicUrl: polarisGatewayUrl(`/api/workspaces/${encodeURIComponent(workspaceId)}/workflows`, gatewayOrigin),
  });

  const productCreate = await timedRequest(state, {
    body: JSON.stringify({
      inventory: 1,
      name: "Synthetic capacity product",
      sku_subcategory: "test_products",
    }),
    expectedStatuses: [201],
    headers: {
      ...mutationHeaders(
        gatewayCookie,
        gatewayOrigin,
        idempotencyKeyFor(input.runId, input.stage, input.userIndex, input.round, "product"),
        workspaceVersion,
      ),
      "content-type": "application/json",
    },
    method: "POST",
    operation: "product.create",
    publicUrl: polarisGatewayUrl(`/api/workspaces/${encodeURIComponent(workspaceId)}/products`, gatewayOrigin),
  });
  const product = await jsonObject(productCreate.response, productCreate.record, "product.create");
  workspaceVersion = mutationVersion(product, productCreate.record, "product.create");
  const sku = typeof product?.product?.sku === "string" ? product.product.sku : "";
  if (!sku) {
    productCreate.record.error = "product.create did not return a SKU";
    throw new CapacityLoadError(productCreate.record.error);
  }

  const form = new FormData();
  form.set(
    "file",
    new Blob(["synthetic capacity asset\n"], { type: "text/plain" }),
    "capacity.txt",
  );
  const upload = await timedRequest(state, {
    body: form,
    expectedStatuses: [200],
    headers: mutationHeaders(
      gatewayCookie,
      gatewayOrigin,
      idempotencyKeyFor(input.runId, input.stage, input.userIndex, input.round, "asset"),
      workspaceVersion,
    ),
    method: "POST",
    operation: "product.asset-upload",
    publicUrl: polarisGatewayUrl(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/products/${encodeURIComponent(sku)}`,
      gatewayOrigin,
    ),
  });
  mutationVersion(
    await jsonObject(upload.response, upload.record, "product.asset-upload"),
    upload.record,
    "product.asset-upload",
  );
}

async function runCapacityStage(input) {
  const startedAt = new Date().toISOString();
  const records = [];
  const errors = [];
  const users = input.fixture.stages[String(input.stage)]?.slice(0, input.stage) ?? [];
  if (users.length !== input.stage) {
    fail(`fixture stage ${input.stage} must provide ${input.stage} users`);
  }
  await Promise.all(users.map(async (user, userIndex) => {
    for (let round = 1; round <= input.rounds; round += 1) {
      try {
        await runUserRound({ fixture: input.fixture, records }, {
          round,
          runId: input.runId,
          stage: input.stage,
          user,
          userIndex,
        });
      } catch (error) {
        const message = error instanceof CapacityLoadError ? error.message : "request failed";
        errors.push(
          `stage ${input.stage} user ${userIndex + 1} round ${round}: ${message}`,
        );
      }
    }
  }));
  const operationSummary = summarizeCapacityOperations(records);
  const readP95Ms = maxP95ForCategory(operationSummary, "read");
  const mutationP95Ms = maxP95ForCategory(operationSummary, "mutation");
  const launch = operationSummary["gateway.launch"];
  const gatewayLaunchSuccessPercent = launch && launch.count > 0
    ? rounded(((launch.count - launch.errors) / launch.count) * 100)
    : 0;
  const responseCount = records.filter((record) => record.status !== null).length;
  const fiveXxCount = records.filter((record) => record.status !== null && record.status >= 500).length;
  const fiveXxPercent = responseCount > 0 ? rounded((fiveXxCount / responseCount) * 100) : 100;
  const boundedPathSloPass = errors.length === 0
    && readP95Ms !== null
    && mutationP95Ms !== null
    && readP95Ms <= input.profile.readP95Ms
    && mutationP95Ms <= input.profile.mutationP95Ms
    && gatewayLaunchSuccessPercent >= input.profile.gatewayLaunchSuccessPercent
    && fiveXxPercent <= input.profile.max5xxPercent;
  return {
    boundedPathSloPass,
    completedAt: new Date().toISOString(),
    errors: errors.length,
    fiveXxPercent,
    gatewayLaunchSuccessPercent,
    mutationP95Ms,
    operationSummary,
    profileTargets: {
      gatewayLaunchSuccessPercent: input.profile.gatewayLaunchSuccessPercent,
      max5xxPercent: input.profile.max5xxPercent,
      mutationP95Ms: input.profile.mutationP95Ms,
      readP95Ms: input.profile.readP95Ms,
    },
    readP95Ms,
    rounds: input.rounds,
    startedAt,
    userRunErrors: errors,
    users: input.stage,
  };
}

function defaultRunId() {
  return `run-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
}

export async function runCapacityGatewayLoad(input) {
  const fixture = normalizeCapacityFixture(input.fixture);
  const profile = normalizeProfile(input.profile ?? loadCapacityProfile(input.profilePath));
  const stages = input.stages ?? DEFAULT_STAGES;
  const rounds = input.rounds ?? DEFAULT_ROUNDS;
  if (!Array.isArray(stages) || stages.length === 0 || new Set(stages).size !== stages.length) {
    fail("stages must be a non-empty list of distinct positive integers");
  }
  for (const stage of stages) positiveInteger(stage, "stage");
  positiveInteger(rounds, "rounds");
  const runId = input.runId ?? defaultRunId();
  if (!RUN_ID_PATTERN.test(runId)) fail("runId must be a lowercase URL-safe identifier");

  const stageResults = {};
  for (const stage of stages) {
    stageResults[String(stage)] = await runCapacityStage({
      fixture,
      profile,
      rounds,
      runId,
      stage,
    });
  }
  const passed = Object.values(stageResults).every((stage) => stage.boundedPathSloPass);
  return {
    schema_version: 1,
    kind: "polaris-wanghai-capacity-2-5-10-gateway-load",
    recordedAt: new Date().toISOString(),
    environment: fixture.environment,
    authMode: "oauth2-proxy synthetic mapped forwarded identities",
    ...fixtureMetadata(fixture),
    profile: {
      users: stages,
      roundsPerStage: rounds,
      readP95TargetMs: profile.readP95Ms,
      mutationP95TargetMs: profile.mutationP95Ms,
    },
    runId,
    stages: stageResults,
    passed,
  };
}

function parseIntegerList(value, label) {
  const values = requiredString(value, label).split(",").map((item) => Number(item.trim()));
  if (values.some((item) => !Number.isInteger(item) || item <= 0)) {
    fail(`${label} must be a comma-separated list of positive integers`);
  }
  return values;
}

function parseArguments(argv) {
  const options = {
    profilePath: DEFAULT_PROFILE_PATH,
    rounds: DEFAULT_ROUNDS,
    stages: DEFAULT_STAGES,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      options.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) fail(`${flag} requires a value`);
    index += 1;
    if (flag === "--fixture") options.fixturePath = value;
    else if (flag === "--output") options.outputPath = value;
    else if (flag === "--profile") options.profilePath = value;
    else if (flag === "--rounds") options.rounds = Number(value);
    else if (flag === "--run-id") options.runId = value;
    else if (flag === "--stages") options.stages = parseIntegerList(value, "--stages");
    else fail(`unsupported argument: ${flag}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/release/capacity-gateway-load.mjs --fixture <fixture.json> --output <artifact.json>",
    "    [--stages 2,5,10] [--rounds 5] [--run-id <id>] [--profile <profile.json>]",
    "",
    "The fixture transport_origin must be loopback-only. Each load stage must use distinct",
    "synthetic Authing identities so rate-limit evidence is not contaminated across stages.",
  ].join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.fixturePath || !options.outputPath) {
    fail("--fixture and --output are required");
  }
  let fixture;
  try {
    fixture = JSON.parse(fs.readFileSync(options.fixturePath, "utf8"));
  } catch (error) {
    fail(`could not read fixture: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = await runCapacityGatewayLoad({
    fixture,
    profilePath: options.profilePath,
    rounds: options.rounds,
    runId: options.runId,
    stages: options.stages,
  });
  fs.mkdirSync(path.dirname(path.resolve(options.outputPath)), { recursive: true });
  fs.writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output: options.outputPath, passed: result.passed }, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
