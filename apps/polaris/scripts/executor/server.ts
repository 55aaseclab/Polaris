import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";
import type { ManagedHarness } from "../config/credential-catalog.js";
import { isSkillHarness, type SkillHarness } from "../config/skills.js";
import { parsePortalDriverTarget } from "../core/portal.js";
import { logError, logInfo, logWarn } from "../utils/log.js";
import {
  deletePortalVault,
  getPortalVaultPaseoDiagnostic,
  permanentlyDeletePortalVault,
  queueProvisionVault,
  refreshPortalVaultStatus,
  rebuildPortalVault,
  restartPortalVaultPaseoDaemon,
  updatePortalVaultSelectedDriver,
  skillInstallVault,
  skillSyncVault,
  skillUninstallVault,
  startPortalVault,
  stopPortalVault,
  switchPortalVault,
  switchPortalVaultLiveCredential,
  listVaultSkills,
} from "./operations.js";

type JsonObject = Record<string, unknown>;
const EXECUTOR_LOOPBACK_HOST = "127.0.0.1";

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readHeader(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return value[0]?.trim() || null;
  }
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isVaultStatusRefreshRequest(req: IncomingMessage, url: URL): boolean {
  return req.method === "POST" && url.pathname === "/vaults/status/refresh";
}

function assertExecutorConfiguration(host: string): void {
  if (host !== EXECUTOR_LOOPBACK_HOST) {
    throw new Error(
      `Polaris executor must bind to ${EXECUTOR_LOOPBACK_HOST}, received '${host}'`,
    );
  }
}

async function readBody(req: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as JsonObject;
}

function readRequiredString(
  body: JsonObject,
  key: string,
): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function handleError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 500, { error: message });
}

export function createExecutorServer(
  port = 8788,
  host = EXECUTOR_LOOPBACK_HOST,
): Server {
  assertExecutorConfiguration(host);
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (!req.url) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      const url = new URL(req.url, `http://${host}:${port}`);
      const requestId = readHeader(req, "x-polaris-request-id") ?? "";
      if (isVaultStatusRefreshRequest(req, url)) {
        logInfo("executor-server", "request-received", {
          requestId,
          pathname: url.pathname,
        });
        req.on("aborted", () => {
          logWarn("executor-server", "request-aborted", {
            requestId,
            pathname: url.pathname,
          });
        });
      }

      if (req.method === "POST" && url.pathname === "/vaults/provision") {
        const body = await readBody(req);
        const result = await queueProvisionVault(
          readRequiredString(body, "userId"),
          readRequiredString(body, "vault"),
          {
            defaultDockerOnly: body.defaultDockerOnly === true,
            startAfterCreate: body.startAfterCreate === true,
            ...(body.line === "coding" || body.line === "vertical" ? { line: body.line } : {}),
          },
        );
        sendJson(res, 202, result);
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname === "/vaults/status/refresh"
      ) {
        const body = await readBody(req);
        logInfo("executor-server", "request-body", {
          requestId,
          pathname: url.pathname,
          userId: typeof body.userId === "string" ? body.userId : null,
          vault: typeof body.vault === "string" ? body.vault : null,
        });
        await refreshPortalVaultStatus(
          readRequiredString(body, "userId"),
          readRequiredString(body, "vault"),
        );
        logInfo("executor-server", "request-completed", {
          requestId,
          pathname: url.pathname,
        });
        sendJson(res, 200, { refreshed: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/vaults/switch") {
        const body = await readBody(req);
        const targetValue = body.target;
        const target =
          typeof targetValue === "string"
            ? parsePortalDriverTarget(targetValue)
            : parsePortalDriverTarget(
              [
                typeof targetValue === "object" &&
                targetValue &&
                typeof (targetValue as Record<string, unknown>).backend === "string"
                  ? String((targetValue as Record<string, unknown>).backend)
                  : "",
                typeof targetValue === "object" &&
                targetValue &&
                typeof (targetValue as Record<string, unknown>).profile === "string"
                  ? String((targetValue as Record<string, unknown>).profile)
                  : "",
              ]
                .filter(Boolean)
                .join(":"),
            );
        const result = await switchPortalVault(
          readRequiredString(body, "userId"),
          readRequiredString(body, "vault"),
          target,
        );
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/vaults/driver") {
        const body = await readBody(req);
        const targetValue = body.target;
        const target =
          typeof targetValue === "string"
            ? parsePortalDriverTarget(targetValue)
            : parsePortalDriverTarget(
              [
                typeof targetValue === "object" &&
                targetValue &&
                typeof (targetValue as Record<string, unknown>).backend === "string"
                  ? String((targetValue as Record<string, unknown>).backend)
                  : "",
                typeof targetValue === "object" &&
                targetValue &&
                typeof (targetValue as Record<string, unknown>).profile === "string"
                  ? String((targetValue as Record<string, unknown>).profile)
                  : "",
              ]
                .filter(Boolean)
                .join(":"),
            );
        const result = await updatePortalVaultSelectedDriver({
          userId: readRequiredString(body, "userId"),
          vault: readRequiredString(body, "vault"),
          target,
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "DELETE" && url.pathname === "/vaults") {
        const body = await readBody(req);
        const result = await deletePortalVault(
          readRequiredString(body, "userId"),
          readRequiredString(body, "vault"),
        );
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "DELETE" && url.pathname === "/vaults/hard-delete") {
        const body = await readBody(req);
        const result = await permanentlyDeletePortalVault(
          readRequiredString(body, "userId"),
          readRequiredString(body, "vault"),
        );
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/vaults/stop") {
        const body = await readBody(req);
        const result = await stopPortalVault(
          readRequiredString(body, "userId"),
          readRequiredString(body, "vault"),
        );
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/vaults/start") {
        const body = await readBody(req);
        const result = await startPortalVault(
          readRequiredString(body, "userId"),
          readRequiredString(body, "vault"),
        );
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/vaults/rebuild") {
        const body = await readBody(req);
        const result = await rebuildPortalVault(
          readRequiredString(body, "userId"),
          readRequiredString(body, "vault"),
        );
        sendJson(res, 200, result);
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname === "/vaults/credentials/live/switch"
      ) {
        const body = await readBody(req);
        const result = await switchPortalVaultLiveCredential({
          userId: readRequiredString(body, "userId"),
          vault: readRequiredString(body, "vault"),
          harness: readRequiredString(body, "harness") as ManagedHarness,
          credentialId: readRequiredString(body, "credentialId"),
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/vaults/skills/list") {
        const body = await readBody(req);
        const harness = readRequiredString(body, "harness");
        if (!isSkillHarness(harness)) {
          throw new Error(`Unsupported skill harness '${harness}'`);
        }
        const result = await listVaultSkills({
          vaultRef: readRequiredString(body, "vault"),
          userProfileId: readRequiredString(body, "userId"),
          harness: harness as SkillHarness,
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/vaults/skills/install") {
        const body = await readBody(req);
        const harness = readRequiredString(body, "harness");
        if (!isSkillHarness(harness)) {
          throw new Error(`Unsupported skill harness '${harness}'`);
        }
        const result = await skillInstallVault({
          vaultRef: readRequiredString(body, "vault"),
          userProfileId: readRequiredString(body, "userId"),
          harness: harness as SkillHarness,
          skillId: readRequiredString(body, "skillId"),
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/vaults/skills/uninstall") {
        const body = await readBody(req);
        const harness = readRequiredString(body, "harness");
        if (!isSkillHarness(harness)) {
          throw new Error(`Unsupported skill harness '${harness}'`);
        }
        const result = await skillUninstallVault({
          vaultRef: readRequiredString(body, "vault"),
          userProfileId: readRequiredString(body, "userId"),
          harness: harness as SkillHarness,
          skillId: readRequiredString(body, "skillId"),
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/vaults/skills/sync") {
        const body = await readBody(req);
        const harness = readRequiredString(body, "harness");
        if (!isSkillHarness(harness)) {
          throw new Error(`Unsupported skill harness '${harness}'`);
        }
        const result = await skillSyncVault({
          vaultRef: readRequiredString(body, "vault"),
          userProfileId: readRequiredString(body, "userId"),
          harness: harness as SkillHarness,
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/vaults/paseo/status") {
        const body = await readBody(req);
        const result = await getPortalVaultPaseoDiagnostic({
          userId: readRequiredString(body, "userId"),
          vault: readRequiredString(body, "vault"),
        });
        sendJson(res, 200, result);
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname === "/vaults/paseo/restart"
      ) {
        const body = await readBody(req);
        const result = await restartPortalVaultPaseoDaemon({
          userId: readRequiredString(body, "userId"),
          vault: readRequiredString(body, "vault"),
        });
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      if (req.url) {
        logError("executor-server", "request-failed", {
          requestId: readHeader(req, "x-polaris-request-id") ?? "",
          pathname: req.url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      handleError(res, error);
    }
  });

  server.listen(port, host);
  return server;
}
