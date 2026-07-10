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
  deletePortalWorkspace,
  getPortalWorkspacePaseoDiagnostic,
  permanentlyDeletePortalArchivedWorkspace,
  permanentlyDeletePortalWorkspace,
  queueProvisionWorkspace,
  refreshPortalWorkspaceStatus,
  rebuildPortalWorkspace,
  restartPortalWorkspacePaseoDaemon,
  updatePortalWorkspaceSelectedDriver,
  skillInstallWorkspace,
  skillSyncWorkspace,
  skillUninstallWorkspace,
  startPortalWorkspace,
  stopPortalWorkspace,
  switchPortalWorkspace,
  switchPortalWorkspaceLiveCredential,
  listWorkspaceSkills,
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

function isWorkspaceStatusRefreshRequest(req: IncomingMessage, url: URL): boolean {
  return req.method === "POST" && url.pathname === "/workspaces/status/refresh";
}

function authenticateExecutorRequest(req: IncomingMessage): boolean {
  const expected = process.env.POLARIS_EXECUTOR_SHARED_SECRET?.trim();
  return readHeader(req, "x-polaris-executor-secret") === expected;
}

function assertExecutorConfiguration(host: string): void {
  const secret = process.env.POLARIS_EXECUTOR_SHARED_SECRET?.trim();
  if (!secret) {
    throw new Error("POLARIS_EXECUTOR_SHARED_SECRET is required to start the Polaris executor");
  }
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
      if (!authenticateExecutorRequest(req)) {
        sendJson(res, 403, { error: "Forbidden" });
        return;
      }
      if (!req.url) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      const url = new URL(req.url, `http://${host}:${port}`);
      const requestId = readHeader(req, "x-polaris-request-id") ?? "";
      if (isWorkspaceStatusRefreshRequest(req, url)) {
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

      if (req.method === "POST" && url.pathname === "/workspaces/provision") {
        const body = await readBody(req);
        const result = await queueProvisionWorkspace(
          readRequiredString(body, "userId"),
          readRequiredString(body, "workspace"),
          {
            defaultDockerOnly: body.defaultDockerOnly === true,
            startAfterCreate: body.startAfterCreate === true,
          },
        );
        sendJson(res, 202, result);
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname === "/workspaces/status/refresh"
      ) {
        const body = await readBody(req);
        logInfo("executor-server", "request-body", {
          requestId,
          pathname: url.pathname,
          userId: typeof body.userId === "string" ? body.userId : null,
          workspace: typeof body.workspace === "string" ? body.workspace : null,
        });
        await refreshPortalWorkspaceStatus(
          readRequiredString(body, "userId"),
          readRequiredString(body, "workspace"),
        );
        logInfo("executor-server", "request-completed", {
          requestId,
          pathname: url.pathname,
        });
        sendJson(res, 200, { refreshed: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/workspaces/switch") {
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
        const result = await switchPortalWorkspace(
          readRequiredString(body, "userId"),
          readRequiredString(body, "workspace"),
          target,
        );
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/workspaces/driver") {
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
        const result = await updatePortalWorkspaceSelectedDriver({
          userId: readRequiredString(body, "userId"),
          workspace: readRequiredString(body, "workspace"),
          target,
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "DELETE" && url.pathname === "/workspaces") {
        const body = await readBody(req);
        const result = await deletePortalWorkspace(
          readRequiredString(body, "userId"),
          readRequiredString(body, "workspace"),
        );
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "DELETE" && url.pathname === "/workspaces/hard-delete") {
        const body = await readBody(req);
        const result = await permanentlyDeletePortalWorkspace(
          readRequiredString(body, "userId"),
          readRequiredString(body, "workspace"),
        );
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "DELETE" && url.pathname === "/workspaces/archives") {
        const body = await readBody(req);
        const result = await permanentlyDeletePortalArchivedWorkspace(
          readRequiredString(body, "userId"),
          readRequiredString(body, "archiveId"),
        );
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/workspaces/stop") {
        const body = await readBody(req);
        const result = await stopPortalWorkspace(
          readRequiredString(body, "userId"),
          readRequiredString(body, "workspace"),
        );
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/workspaces/start") {
        const body = await readBody(req);
        const result = await startPortalWorkspace(
          readRequiredString(body, "userId"),
          readRequiredString(body, "workspace"),
        );
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/workspaces/rebuild") {
        const body = await readBody(req);
        const result = await rebuildPortalWorkspace(
          readRequiredString(body, "userId"),
          readRequiredString(body, "workspace"),
        );
        sendJson(res, 200, result);
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname === "/workspaces/credentials/live/switch"
      ) {
        const body = await readBody(req);
        const result = await switchPortalWorkspaceLiveCredential({
          userId: readRequiredString(body, "userId"),
          workspace: readRequiredString(body, "workspace"),
          harness: readRequiredString(body, "harness") as ManagedHarness,
          credentialId: readRequiredString(body, "credentialId"),
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/workspaces/skills/list") {
        const body = await readBody(req);
        const harness = readRequiredString(body, "harness");
        if (!isSkillHarness(harness)) {
          throw new Error(`Unsupported skill harness '${harness}'`);
        }
        const result = await listWorkspaceSkills({
          workspaceRef: readRequiredString(body, "workspace"),
          userProfileId: readRequiredString(body, "userId"),
          harness: harness as SkillHarness,
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/workspaces/skills/install") {
        const body = await readBody(req);
        const harness = readRequiredString(body, "harness");
        if (!isSkillHarness(harness)) {
          throw new Error(`Unsupported skill harness '${harness}'`);
        }
        const result = await skillInstallWorkspace({
          workspaceRef: readRequiredString(body, "workspace"),
          userProfileId: readRequiredString(body, "userId"),
          harness: harness as SkillHarness,
          skillId: readRequiredString(body, "skillId"),
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/workspaces/skills/uninstall") {
        const body = await readBody(req);
        const harness = readRequiredString(body, "harness");
        if (!isSkillHarness(harness)) {
          throw new Error(`Unsupported skill harness '${harness}'`);
        }
        const result = await skillUninstallWorkspace({
          workspaceRef: readRequiredString(body, "workspace"),
          userProfileId: readRequiredString(body, "userId"),
          harness: harness as SkillHarness,
          skillId: readRequiredString(body, "skillId"),
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/workspaces/skills/sync") {
        const body = await readBody(req);
        const harness = readRequiredString(body, "harness");
        if (!isSkillHarness(harness)) {
          throw new Error(`Unsupported skill harness '${harness}'`);
        }
        const result = await skillSyncWorkspace({
          workspaceRef: readRequiredString(body, "workspace"),
          userProfileId: readRequiredString(body, "userId"),
          harness: harness as SkillHarness,
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/workspaces/paseo/status") {
        const body = await readBody(req);
        const result = await getPortalWorkspacePaseoDiagnostic({
          userId: readRequiredString(body, "userId"),
          workspace: readRequiredString(body, "workspace"),
        });
        sendJson(res, 200, result);
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname === "/workspaces/paseo/restart"
      ) {
        const body = await readBody(req);
        const result = await restartPortalWorkspacePaseoDaemon({
          userId: readRequiredString(body, "userId"),
          workspace: readRequiredString(body, "workspace"),
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
