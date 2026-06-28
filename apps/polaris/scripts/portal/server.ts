import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { ManagedHarness } from "../config/credential-catalog.js";
import {
  listPortalProfiles,
  parsePortalDriverTarget,
  readPortalProfile,
  type PortalProfileSummary,
  updatePortalProfile,
} from "../core/portal.js";
import { findUserMapEntry, UserMapConflictError } from "./user-map.js";
import {
  activatePortalCredential,
  bindPortalWorkspaceAgent,
  createPortalCredential,
  getPortalCredentialCatalog,
  deletePortalCredential,
  deletePortalWorkspace,
  getPortalWorkspaceDetail,
  listPortalWorkspaces,
  listUserPortalCredentials,
  refreshPortalWorkspace,
  readUserPortalCredentialPreview,
  readUserPortalWorkspaceAssetPreview,
  queueProvisionWorkspace,
  startPortalWorkspace,
  stopPortalWorkspace,
  switchPortalWorkspace,
  switchPortalWorkspaceLiveCredential,
  unbindPortalWorkspaceAgent,
  upsertPortalCredential,
  createPortalUser,
} from "./service.js";

type ParsedBody = Record<string, string>;
type TrustedSessionRole = "admin" | "user";
type TrustedSessionPlan = "free" | "pro";

interface TrustedPortalSession {
  polarisUserId: string;
  email: string | null;
  role: TrustedSessionRole;
  plan: TrustedSessionPlan | null;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(payload);
}

function sendText(
  res: ServerResponse,
  statusCode: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  res.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: "Not found" });
}

function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { error: message });
}

function forbidden(res: ServerResponse, message = "Forbidden"): void {
  sendJson(res, 403, { error: message });
}

function parseFormBody(raw: string): ParsedBody {
  const params = new URLSearchParams(raw);
  const result: ParsedBody = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

async function readBody(req: IncomingMessage): Promise<ParsedBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  const contentType = String(req.headers["content-type"] ?? "");
  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const body: ParsedBody = {};
    for (const [key, value] of Object.entries(parsed)) {
      body[key] = Array.isArray(value) ? value.map((item) => String(item)).join(",") : String(value ?? "");
    }
    return body;
  }
  return parseFormBody(raw);
}

function routeSegments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

function readHeader(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return value[0]?.trim() || null;
  }
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readTrustedPortalSession(req: IncomingMessage): TrustedPortalSession | null {
  const sharedSecret = process.env.POLARIS_AUTH_SHARED_SECRET?.trim();
  if (!sharedSecret) {
    return null;
  }
  const providedSecret = readHeader(req, "x-polaris-auth-shared-secret");
  if (providedSecret !== sharedSecret) {
    return null;
  }
  const polarisUserId = readHeader(req, "x-polaris-user-id");
  const role = readHeader(req, "x-polaris-user-role");
  const email = readHeader(req, "x-polaris-user-email");
  const plan = readHeader(req, "x-polaris-user-plan");
  if (!polarisUserId || (role !== "admin" && role !== "user")) {
    return null;
  }
  return {
    polarisUserId,
    email,
    role,
    plan: plan === "free" || plan === "pro" ? plan : null,
  };
}

function findProfile(userId: string): PortalProfileSummary | null {
  return listPortalProfiles().find((profile) => profile.id === userId) ?? null;
}

function defaultPortalUserId(): string | null {
  const firstProfile = listPortalProfiles()[0];
  return firstProfile?.id ?? null;
}

function resolveDefaultPortalUserId(session: TrustedPortalSession | null): string | null {
  if (session) {
    return session.role === "admin" ? defaultPortalUserId() : session.polarisUserId;
  }
  return defaultPortalUserId();
}

function requireProfile(
  res: ServerResponse,
  routeUserId: string,
  session: TrustedPortalSession | null,
): PortalProfileSummary | null {
  if (session && session.role !== "admin" && routeUserId !== session.polarisUserId) {
    forbidden(res, "Normal users can access only their own Polaris user scope");
    return null;
  }
  const profile = findProfile(routeUserId);
  if (!profile) {
    notFound(res);
    return null;
  }
  return profile;
}

async function handleWorkspaceSwitch(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  workspace: string,
): Promise<void> {
  const body = await readBody(req);
  const driver = body.driver?.trim();
  if (!driver) {
    badRequest(res, "Missing driver");
    return;
  }
  const target = parsePortalDriverTarget(driver);
  const result = await switchPortalWorkspace(userId, workspace, target);
  sendJson(res, 200, result);
}

async function handleWorkspaceProvision(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  workspace: string,
): Promise<void> {
  const body = await readBody(req);
  const progress = await queueProvisionWorkspace(userId, workspace, {
    defaultDockerOnly: body.defaultDockerOnly === "true",
    startAfterCreate: body.startAfterCreate === "true",
  });
  sendJson(res, 202, progress);
}

async function handleWorkspaceDelete(
  res: ServerResponse,
  userId: string,
  workspace: string,
): Promise<void> {
  const result = await deletePortalWorkspace(userId, workspace);
  sendJson(res, 200, result);
}

async function handleWorkspaceStop(
  res: ServerResponse,
  userId: string,
  workspace: string,
): Promise<void> {
  const result = await stopPortalWorkspace(userId, workspace);
  sendJson(res, 200, result);
}

async function handleWorkspaceStart(
  res: ServerResponse,
  userId: string,
  workspace: string,
): Promise<void> {
  const result = await startPortalWorkspace(userId, workspace);
  sendJson(res, 200, result);
}

async function handleWorkspaceRefresh(
  res: ServerResponse,
  userId: string,
  workspace: string,
): Promise<void> {
  const result = await refreshPortalWorkspace(userId, workspace);
  sendJson(res, 200, result);
}

function handleWorkspacePreview(
  res: ServerResponse,
  userId: string,
  workspace: string,
  assetPath: string,
): void {
  try {
    sendJson(res, 200, readUserPortalWorkspaceAssetPreview(userId, workspace, assetPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "workspace asset not found") {
      sendJson(res, 404, { error: message });
      return;
    }
    throw error;
  }
}

async function handleWorkspacePaseoBind(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  workspace: string,
): Promise<void> {
  const body = await readBody(req);
  const credentialId = body.credentialId?.trim();
  if (!credentialId) {
    badRequest(res, "credentialId is required");
    return;
  }
  const driver = body.driver?.trim()
    ? parsePortalDriverTarget(body.driver)
    : undefined;
  const result = await bindPortalWorkspaceAgent({
    userId,
    workspace,
    credentialId,
    driver,
  });
  sendJson(res, 200, result);
}

async function handleWorkspacePaseoUnbind(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  workspace: string,
): Promise<void> {
  const body = await readBody(req);
  const driver = body.driver?.trim()
    ? parsePortalDriverTarget(body.driver)
    : undefined;
  const result = await unbindPortalWorkspaceAgent({
    userId,
    workspace,
    driver,
  });
  sendJson(res, 200, result);
}

async function handleCredentialUpsert(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  const body = await readBody(req);
  const id = body.credentialId?.trim() || body.id?.trim();
  const kind = body.kind?.trim();
  const label = body.label?.trim() || id;
  const purposes = (body.purposes ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const sourcePath = body.sourcePath?.trim() || `credentials/generated/${id}/auth.json`;
  const content = body.content ?? "{}\n";
  if (!id || !kind || purposes.length === 0) {
    badRequest(res, "credentialId, kind, and purposes are required");
    return;
  }
  const saved = upsertPortalCredential(userId, {
    id,
    kind: kind as never,
    label,
    purposes,
    files: [
      {
        key: body.fileKey?.trim() || "auth.json",
        sourcePath,
        content,
        ...(body.mountPath?.trim() ? { mountPath: body.mountPath.trim() } : {}),
      },
    ],
    ...(body.status?.trim() ? { status: body.status.trim() } : {}),
  });
  sendJson(res, 200, saved);
}

async function handleCredentialCreate(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  const body = await readBody(req);
  const harness = body.harness?.trim() || "codex";
  if (
    harness !== "ssh" &&
    harness !== "codex" &&
    harness !== "claude" &&
    harness !== "copilot" &&
    harness !== "opencode" &&
    harness !== "pi"
  ) {
    badRequest(res, `Unsupported harness '${harness}'`);
    return;
  }
  const saved = await createPortalCredential({
    userId,
    harness,
    ...(body.credentialId?.trim() ? { credentialId: body.credentialId.trim() } : {}),
    ...(body.label?.trim() ? { label: body.label.trim() } : {}),
    ...(body.providerName?.trim() ? { providerName: body.providerName.trim() } : {}),
    ...(body.baseUrl?.trim() ? { baseUrl: body.baseUrl.trim() } : {}),
    ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
    ...(body.presetId?.trim() ? { presetId: body.presetId.trim() } : {}),
    ...(body.model?.trim() ? { model: body.model.trim() } : {}),
    ...(body.activate === "true" ? { activate: true } : {}),
  });
  sendJson(res, 201, saved);
}

async function handleCredentialDelete(
  res: ServerResponse,
  userId: string,
  credentialId: string,
): Promise<void> {
  const deleted = await deletePortalCredential(userId, credentialId);
  sendJson(res, 200, deleted);
}

async function handleCredentialActivate(
  res: ServerResponse,
  userId: string,
  credentialId: string,
): Promise<void> {
  const activated = await activatePortalCredential(userId, credentialId);
  sendJson(res, 200, activated);
}

async function handleWorkspaceLiveCredentialSwitch(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  workspace: string,
): Promise<void> {
  const body = await readBody(req);
  const harness = body.harness?.trim() || "";
  const credentialId = body.credentialId?.trim() || "";
  if (!harness || !credentialId) {
    badRequest(res, "harness and credentialId are required");
    return;
  }
  const switched = await switchPortalWorkspaceLiveCredential({
    userId,
    workspace,
    harness: harness as ManagedHarness,
    credentialId,
  });
  sendJson(res, 200, switched);
}

async function handleProfileUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  const body = await readBody(req);
  const updated = updatePortalProfile(userId, {
    ...(body.name !== undefined ? { name: body.name.trim() } : {}),
    ...(body.email !== undefined ? { email: body.email.trim() } : {}),
    ...(body.githubAccount !== undefined ? { githubAccount: body.githubAccount.trim() } : {}),
    ...(body.sshComment !== undefined ? { sshComment: body.sshComment.trim() } : {}),
  });
  sendJson(res, 200, updated);
}

async function handleUserCreate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const userProfileId = body.userProfileId?.trim() || "";
  const clerkUsername = body.clerkUsername?.trim() || "";
  const clerkUserId = body.clerkUserId?.trim() || "";
  if (!userProfileId) {
    badRequest(res, "Missing userProfileId");
    return;
  }
  if (!clerkUsername && !clerkUserId) {
    badRequest(res, "Missing Clerk identity");
    return;
  }
  try {
    const created = await createPortalUser({
      userProfileId,
      ...(clerkUsername ? { clerkUsername } : {}),
      ...(clerkUserId ? { clerkUserId } : {}),
      ...(body.email?.trim() ? { email: body.email.trim() } : {}),
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.role === "admin" || body.role === "user" ? { role: body.role } : {}),
      ...(body.plan === "free" || body.plan === "pro" ? { plan: body.plan } : {}),
    });
    sendJson(res, 201, created);
  } catch (error) {
    if (error instanceof UserMapConflictError) {
      sendJson(res, 409, { error: error.message });
      return;
    }
    throw error;
  }
}

function isApiPath(segments: string[]): boolean {
  return segments[0] === "api";
}

export function createPortalServer(port = 8787, host = "127.0.0.1"): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const segments = routeSegments(url);
      const trustedSession = readTrustedPortalSession(req);
      if (req.method === "OPTIONS" && isApiPath(segments)) {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type",
        });
        res.end();
        return;
      }

      if (segments.length === 0) {
        sendJson(res, 200, {
          service: "polaris-portal-api",
          defaultUserId: resolveDefaultPortalUserId(trustedSession),
          endpoints: [
            "/api/default-user",
            "/api/users",
            "/api/users/:userId",
            "/api/users/:userId/workspaces",
            "/api/users/:userId/workspaces/:workspaceName",
            "/api/users/:userId/credentials",
          ],
        });
        return;
      }

      if (isApiPath(segments)) {
        if (segments.length === 2 && segments[1] === "users") {
          if (req.method === "POST") {
            await handleUserCreate(req, res);
            return;
          }
          const profiles = listPortalProfiles();
          sendJson(
            res,
            200,
            trustedSession && trustedSession.role !== "admin"
              ? profiles.filter((profile) => profile.id === trustedSession.polarisUserId)
              : profiles,
          );
          return;
        }
        if (segments.length === 2 && segments[1] === "default-user") {
          sendJson(res, 200, {
            defaultUserId: resolveDefaultPortalUserId(trustedSession),
          });
          return;
        }
        if (segments.length === 2 && segments[1] === "user-mapping" && req.method === "GET") {
          const clerkUsername = url.searchParams.get("clerkUsername")?.trim() || "";
          const clerkUserId = url.searchParams.get("clerkUserId")?.trim() || "";
          sendJson(res, 200, {
            clerkUsername,
            clerkUserId,
            mapping: clerkUsername || clerkUserId
              ? findUserMapEntry({ clerkUsername, clerkUserId })
              : null,
          });
          return;
        }
        if (segments[1] === "session") {
          sendJson(res, 200, {
            authEnabled: Boolean(process.env.POLARIS_AUTH_SHARED_SECRET?.trim()),
            session: trustedSession,
          });
          return;
        }
        if (segments[1] !== "users" || segments.length < 4) {
          notFound(res);
          return;
        }
        const routeUserId = decodeURIComponent(segments[2]);
        const profile = requireProfile(res, routeUserId, trustedSession);
        if (!profile) {
          return;
        }
        const workspace = decodeURIComponent(segments[4] ?? "");
        if (segments.length === 4 && segments[3] === "workspaces" && req.method === "GET") {
          sendJson(res, 200, {
            user: profile,
            workspaces: listPortalWorkspaces(routeUserId),
          });
          return;
        }
        if (segments[3] === "profile" && segments.length === 4 && req.method === "GET") {
          sendJson(res, 200, readPortalProfile(routeUserId));
          return;
        }
        if (segments[3] === "profile" && segments.length === 4 && req.method === "POST") {
          await handleProfileUpdate(req, res, routeUserId);
          return;
        }
        if (segments[3] === "credentials" && segments.length === 4) {
          if (req.method === "POST") {
            await handleCredentialCreate(req, res, routeUserId);
            return;
          }
          sendJson(res, 200, {
            user: profile,
            credentials: listUserPortalCredentials(routeUserId),
          });
          return;
        }
        if (segments[3] === "credentials" && segments.length === 5 && segments[4] === "catalog" && req.method === "GET") {
          sendJson(res, 200, getPortalCredentialCatalog());
          return;
        }
        if (segments[3] === "credentials" && segments.length === 5 && req.method === "DELETE") {
          const credentialId = decodeURIComponent(segments[4]);
          await handleCredentialDelete(res, routeUserId, credentialId);
          return;
        }
        if (segments[3] === "credentials" && segments.length === 6 && segments[5] === "activate" && req.method === "POST") {
          const credentialId = decodeURIComponent(segments[4]);
          await handleCredentialActivate(res, routeUserId, credentialId);
          return;
        }
        if (segments[3] === "credentials" && segments[4] === "preview" && req.method === "GET") {
          const credentialPath = url.searchParams.get("path")?.trim() || "";
          if (!credentialPath) {
            badRequest(res, "path is required");
            return;
          }
          sendJson(res, 200, readUserPortalCredentialPreview(routeUserId, credentialPath));
          return;
        }
        if (segments[3] === "credentials" && segments[4] === "create" && req.method === "POST") {
          await handleCredentialUpsert(req, res, routeUserId);
          return;
        }
        if (segments[3] === "workspaces" && segments.length === 5 && req.method === "GET") {
          sendJson(res, 200, await getPortalWorkspaceDetail(routeUserId, workspace));
          return;
        }
        if (segments[3] === "workspaces" && segments.length === 6 && segments[5] === "preview" && req.method === "GET") {
          const assetPath = url.searchParams.get("path")?.trim() || "";
          if (!assetPath) {
            badRequest(res, "path is required");
            return;
          }
          handleWorkspacePreview(res, routeUserId, workspace, assetPath);
          return;
        }
        if (segments[3] === "workspaces" && segments.length === 5 && req.method === "DELETE") {
          await handleWorkspaceDelete(res, routeUserId, workspace);
          return;
        }
        if (segments[3] === "workspaces" && segments.length === 6 && segments[5] === "switch" && req.method === "POST") {
          await handleWorkspaceSwitch(req, res, routeUserId, workspace);
          return;
        }
        if (segments[3] === "workspaces" && segments.length === 6 && segments[5] === "stop" && req.method === "POST") {
          await handleWorkspaceStop(res, routeUserId, workspace);
          return;
        }
        if (segments[3] === "workspaces" && segments.length === 6 && segments[5] === "start" && req.method === "POST") {
          await handleWorkspaceStart(res, routeUserId, workspace);
          return;
        }
        if (segments[3] === "workspaces" && segments.length === 6 && segments[5] === "refresh" && req.method === "POST") {
          await handleWorkspaceRefresh(res, routeUserId, workspace);
          return;
        }
        if (segments[3] === "workspaces" && segments.length === 7 && segments[5] === "paseo" && segments[6] === "bind" && req.method === "POST") {
          await handleWorkspacePaseoBind(req, res, routeUserId, workspace);
          return;
        }
        if (segments[3] === "workspaces" && segments.length === 7 && segments[5] === "paseo" && segments[6] === "unbind" && req.method === "POST") {
          await handleWorkspacePaseoUnbind(req, res, routeUserId, workspace);
          return;
        }
        if (
          segments[3] === "workspaces" &&
          segments.length === 8 &&
          segments[5] === "paseo" &&
          segments[6] === "credentials" &&
          segments[7] === "switch" &&
          req.method === "POST"
        ) {
          await handleWorkspaceLiveCredentialSwitch(req, res, routeUserId, workspace);
          return;
        }
        if (segments[3] === "workspaces" && segments.length === 6 && segments[5] === "provision" && req.method === "POST") {
          await handleWorkspaceProvision(req, res, routeUserId, workspace);
          return;
        }
        if (segments[3] === "workspaces" && segments.length === 4 && req.method === "POST") {
          const body = await readBody(req);
          const workspaceName = body.workspaceName?.trim();
          if (!workspaceName) {
            badRequest(res, "workspaceName is required");
            return;
          }
          const provision = await queueProvisionWorkspace(routeUserId, workspaceName, {
            defaultDockerOnly: body.defaultDockerOnly === "true",
            startAfterCreate: body.startAfterCreate === "true",
          });
          sendJson(res, 202, provision);
          return;
        }
        notFound(res);
        return;
      }

      notFound(res);
    } catch (error) {
      sendText(
        res,
        500,
        error instanceof Error ? error.message : String(error),
      );
    }
  }).listen(port, host);
}
