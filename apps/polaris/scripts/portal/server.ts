import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  listPortalProfiles,
  parsePortalDriverTarget,
  readPortalProfile,
  type PortalProfileSummary,
  updatePortalProfile,
} from "../core/portal.js";
import {
  deletePortalWorkspace,
  getPortalWorkspaceDetail,
  listPortalWorkspaces,
  listUserPortalCredentials,
  provisionWorkspace,
  stopPortalWorkspace,
  switchPortalWorkspace,
  upsertPortalCredential,
} from "./service.js";

type ParsedBody = Record<string, string>;

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

function findProfile(userId: string): PortalProfileSummary | null {
  return listPortalProfiles().find((profile) => profile.id === userId) ?? null;
}

function defaultPortalUserId(): string | null {
  const firstProfile = listPortalProfiles()[0];
  return firstProfile?.id ?? null;
}

function requireProfile(
  res: ServerResponse,
  routeUserId: string,
): PortalProfileSummary | null {
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
  void req;
  const progress = await provisionWorkspace(userId, workspace);
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
  const sourcePath = body.sourcePath?.trim() || `credentials/generated/${id}/${id}.json`;
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
        key: body.fileKey?.trim() || `${id}.json`,
        sourcePath,
        content,
        ...(body.mountPath?.trim() ? { mountPath: body.mountPath.trim() } : {}),
      },
    ],
    ...(body.status?.trim() ? { status: body.status.trim() } : {}),
  });
  sendJson(res, 200, saved);
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

function isApiPath(segments: string[]): boolean {
  return segments[0] === "api";
}

export function createPortalServer(port = 8787, host = "127.0.0.1"): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const segments = routeSegments(url);
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
          defaultUserId: defaultPortalUserId(),
          endpoints: [
            "/api/default-user",
            "/api/users",
            "/api/users/:userId/workspaces",
            "/api/users/:userId/workspaces/:workspaceName",
            "/api/users/:userId/credentials",
          ],
        });
        return;
      }

      if (isApiPath(segments)) {
        if (segments.length === 2 && segments[1] === "users") {
          sendJson(res, 200, listPortalProfiles());
          return;
        }
        if (segments.length === 2 && segments[1] === "default-user") {
          sendJson(res, 200, {
            defaultUserId: defaultPortalUserId(),
          });
          return;
        }
        if (segments[1] === "session") {
          sendJson(res, 200, {
            authEnabled: false,
            session: null,
          });
          return;
        }
        if (segments[1] !== "users" || segments.length < 4) {
          notFound(res);
          return;
        }
        const routeUserId = decodeURIComponent(segments[2]);
        const profile = requireProfile(res, routeUserId);
        if (!profile) {
          return;
        }
        const workspace = decodeURIComponent(segments[4] ?? "");
        if (segments.length === 4 && segments[3] === "workspaces") {
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
          sendJson(res, 200, {
            user: profile,
            credentials: listUserPortalCredentials(routeUserId),
          });
          return;
        }
        if (segments[3] === "credentials" && segments[4] === "create" && req.method === "POST") {
          await handleCredentialUpsert(req, res, routeUserId);
          return;
        }
        if (segments[3] === "workspaces" && segments.length === 5 && req.method === "GET") {
          sendJson(res, 200, getPortalWorkspaceDetail(routeUserId, workspace));
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
          const provision = await provisionWorkspace(routeUserId, workspaceName);
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
