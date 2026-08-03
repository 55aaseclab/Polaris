import type { SwitchResult } from "../cli/commands/switch.js";
import type { ManagedHarness } from "../config/credential-catalog.js";
import type { SkillHarness } from "../config/skills.js";
import type {
  PortalVaultPaseoDiagnostic,
} from "../core/portal.js";
import type { PortalDriverTarget } from "../core/portal.js";
import type { VaultStatus } from "../core/vault.js";
import {
  healthCheckPortalVaultExecutor,
} from "./operations.js";
import { logInfo, logWarn } from "../utils/log.js";

const EXECUTOR_HEALTH_TTL_MS = 5000;
const executorHealthCache = new Map<string, {
  okUntil: number;
  inFlight: Promise<void> | null;
}>();

function executorBaseUrl(): string | null {
  const raw = process.env.POLARIS_EXECUTOR_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

function executorHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
  };
}

function describeExecutorEndpointFailure(
  baseUrl: string,
  pathname: string,
  response: Response,
  responseBody: string,
): string {
  if (response.status === 404) {
    return [
      `Polaris executor endpoint '${baseUrl}${pathname}' returned 404.`,
      "The configured POLARIS_EXECUTOR_BASE_URL does not appear to be a Polaris executor.",
      `Response body: ${responseBody}`,
    ].join(" ");
  }
  if (response.status === 403) {
    return `Polaris executor endpoint '${baseUrl}${pathname}' rejected the request with 403: ${responseBody}`;
  }
  return `Polaris executor request failed (${response.status} ${response.statusText}) for ${pathname}: ${responseBody}`;
}

async function ensureExecutorHealthy(
  baseUrl: string,
  headers: HeadersInit,
): Promise<void> {
  const cacheKey = JSON.stringify({
    baseUrl,
  });
  const cached = executorHealthCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.okUntil > now) {
    return;
  }
  if (cached?.inFlight) {
    await cached.inFlight;
    return;
  }
  const inFlight = (async () => {
    await healthCheckPortalVaultExecutor(baseUrl, headers);
  })();
  executorHealthCache.set(cacheKey, {
    okUntil: 0,
    inFlight,
  });
  try {
    await inFlight;
    executorHealthCache.set(cacheKey, {
      okUntil: Date.now() + EXECUTOR_HEALTH_TTL_MS,
      inFlight: null,
    });
  } catch (error) {
    executorHealthCache.delete(cacheKey);
    throw error;
  }
}

async function executorRequest<T>(
  pathname: string,
  init: RequestInit,
): Promise<T> {
  const baseUrl = executorBaseUrl();
  if (!baseUrl) {
    throw new Error(
      `POLARIS_EXECUTOR_BASE_URL is required for executor request ${pathname}`,
    );
  }
  let response: Response;
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const headers = {
    ...executorHeaders(),
    "x-polaris-request-id": requestId,
    ...(init.headers ?? {}),
  };
  const requestBody = typeof init.body === "string"
    ? init.body
    : null;
  if (pathname === "/vaults/status/refresh") {
    logInfo("executor-client", "request-started", {
      requestId,
      pathname,
      body: requestBody,
    });
  }
  try {
    await ensureExecutorHealthy(baseUrl, headers);
    response = await fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers,
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : error instanceof Error
        ? error.message
        : String(error);
    if (pathname === "/vaults/status/refresh") {
      logWarn("executor-client", "request-failed", {
        requestId,
        pathname,
        body: requestBody,
        error: cause,
      });
    }
    throw new Error(
      `Polaris executor request failed for ${baseUrl}${pathname}: ${cause}`,
    );
  }
  if (!response.ok) {
    const responseBody = await response.text();
    if (pathname === "/vaults/status/refresh") {
      logWarn("executor-client", "request-rejected", {
        requestId,
        pathname,
        body: requestBody,
        status: response.status,
        responseBody,
      });
    }
    throw new Error(
      describeExecutorEndpointFailure(baseUrl, pathname, response, responseBody),
    );
  }
  if (pathname === "/vaults/status/refresh") {
    logInfo("executor-client", "request-completed", {
      requestId,
      pathname,
      body: requestBody,
      status: response.status,
    });
  }
  return (await response.json()) as T;
}

export async function queueProvisionVault(input: {
  userId: string;
  vault: string;
  defaultDockerOnly?: boolean;
  startAfterCreate?: boolean;
  line?: "coding" | "vertical";
}): Promise<{ queued: true; vault: string }> {
  return executorRequest(
    "/vaults/provision",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function refreshPortalVaultStatus(input: {
  userId: string;
  vault: string;
}): Promise<{ refreshed: true }> {
  return executorRequest(
    "/vaults/status/refresh",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function switchPortalVault(input: {
  userId: string;
  vault: string;
  target: PortalDriverTarget;
}): Promise<SwitchResult> {
  return executorRequest(
    "/vaults/switch",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function updatePortalVaultSelectedDriver(input: {
  userId: string;
  vault: string;
  target: PortalDriverTarget;
}): Promise<{ updated: true }> {
  return executorRequest(
    "/vaults/driver",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function deletePortalVault(input: {
  userId: string;
  vault: string;
}): Promise<{
  deleted: true;
  vault: string;
}> {
  return executorRequest(
    "/vaults",
    {
      method: "DELETE",
      body: JSON.stringify(input),
    },
  );
}

export async function permanentlyDeletePortalVault(input: {
  userId: string;
  vault: string;
}): Promise<{ deleted: true; vault: string }> {
  return executorRequest(
    "/vaults/hard-delete",
    {
      method: "DELETE",
      body: JSON.stringify(input),
    },
  );
}

export async function stopPortalVault(input: {
  userId: string;
  vault: string;
}): Promise<{ stopped: true }> {
  return executorRequest(
    "/vaults/stop",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function startPortalVault(input: {
  userId: string;
  vault: string;
}): Promise<{ started: true }> {
  return executorRequest(
    "/vaults/start",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function rebuildPortalVault(input: {
  userId: string;
  vault: string;
}): Promise<{ rebuilt: true }> {
  return executorRequest(
    "/vaults/rebuild",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function switchPortalVaultLiveCredential(input: {
  userId: string;
  vault: string;
  harness: ManagedHarness;
  credentialId: string;
}): Promise<{
  switched: true;
  driver: string;
  credentialId: string;
}> {
  return executorRequest(
    "/vaults/credentials/live/switch",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function getPortalVaultPaseoDiagnostic(input: {
  userId: string;
  vault: string;
}): Promise<PortalVaultPaseoDiagnostic> {
  return executorRequest(
    "/vaults/paseo/status",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function restartPortalVaultPaseoDaemon(input: {
  userId: string;
  vault: string;
}): Promise<{
  restarted: true;
  diagnostic: PortalVaultPaseoDiagnostic;
}> {
  return executorRequest(
    "/vaults/paseo/restart",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function listPortalVaultSkills(input: {
  userId: string;
  vault: string;
  harness: SkillHarness;
}): Promise<{
  vault: string;
  userId: string;
  installed: Array<{ harness: SkillHarness; skills: string[] }>;
}> {
  return executorRequest(
    "/vaults/skills/list",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function installPortalVaultSkill(input: {
  userId: string;
  vault: string;
  harness: SkillHarness;
  skillId: string;
}): Promise<{
  installed: true;
  vault: string;
  userId: string;
  harness: SkillHarness;
  skillId: string;
  packageName: string;
}> {
  return executorRequest(
    "/vaults/skills/install",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function uninstallPortalVaultSkill(input: {
  userId: string;
  vault: string;
  harness: SkillHarness;
  skillId: string;
}): Promise<{
  uninstalled: true;
  vault: string;
  userId: string;
  harness: SkillHarness;
  skillId: string;
  removed: boolean;
}> {
  return executorRequest(
    "/vaults/skills/uninstall",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function syncPortalVaultSkills(input: {
  userId: string;
  vault: string;
  harness: SkillHarness;
}): Promise<{
  synced: true;
  vault: string;
  userId: string;
  harness: SkillHarness;
  installed: string[];
  removed: string[];
}> {
  return executorRequest(
    "/vaults/skills/sync",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}
