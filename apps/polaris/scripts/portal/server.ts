import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { ManagedHarness } from "../config/credential-catalog.js";
import { isSkillHarness, type SkillHarness } from "../config/skills.js";
import { assertProjectNameAvailableForUser } from "../config/project-ownership.js";
import {
  listPortalProfiles,
  parsePortalDriverTarget,
  readPortalProfile,
  type PortalProfileSummary,
} from "../core/portal.js";
import {
  requireMappedPortalSession,
  requirePortalAdmin,
  requirePortalScope,
  requirePortalSession,
  selfProvisionedPolarisUserId,
  sessionMatchesCurrentIdentity,
} from "./auth.js";
import { findUserMapEntry, UserMapConflictError } from "./user-map.js";
import {
  activatePortalCredential,
  createPortalCredential,
  createPortalSkill,
  listPortalAdminUsers,
  listPortalArchivedWorkspaces,
  deletePortalUser,
  permanentlyDeletePortalArchivedWorkspace,
  getPortalCredentialCatalog,
  deletePortalCredential,
  deletePortalSkill,
  installPortalWorkspaceSkill,
  listPortalWorkspaceSkills,
  readUserPortalCredentialRecord,
  deletePortalWorkspace,
  getPortalWorkspacePaseoDiagnostic,
  getPortalWorkspaceDetail,
  listPortalWorkspaces,
  listUserPortalCredentials,
  listUserPortalSkills,
  refreshPortalWorkspace,
  readUserPortalWorkspaceAssetPreview,
  queueProvisionWorkspace,
  rebuildPortalWorkspace,
  restartPortalWorkspacePaseoDaemon,
  syncPortalWorkspaceSkills,
  startPortalWorkspace,
  stopPortalWorkspace,
  switchPortalWorkspace,
  switchPortalWorkspaceLiveCredential,
  uninstallPortalWorkspaceSkill,
  createPortalUser,
  updatePortalUserProfile,
  writePortalCredentialFile,
} from "./service.js";

type ParsedBody = Record<string, string>;

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
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

async function handleArchivedWorkspaceDelete(
  res: ServerResponse,
  userId: string,
  archiveId: string,
): Promise<void> {
  const result = await permanentlyDeletePortalArchivedWorkspace(userId, archiveId);
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

async function handleWorkspaceRebuild(
  res: ServerResponse,
  userId: string,
  workspace: string,
): Promise<void> {
  const result = await rebuildPortalWorkspace(userId, workspace);
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

async function handleWorkspacePaseoStatus(
  res: ServerResponse,
  userId: string,
  workspace: string,
): Promise<void> {
  const result = await getPortalWorkspacePaseoDiagnostic({
    userId,
    workspace,
  });
  sendJson(res, 200, result);
}

async function handleWorkspacePaseoRestart(
  res: ServerResponse,
  userId: string,
  workspace: string,
): Promise<void> {
  const result = await restartPortalWorkspacePaseoDaemon({
    userId,
    workspace,
  });
  sendJson(res, 200, result);
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

async function handleCredentialWrite(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  credentialId: string,
  fileKey: string,
): Promise<void> {
  const body = await readBody(req);
  const updated = await writePortalCredentialFile({
    userId,
    credentialId,
    fileKey,
    content: body.content ?? "",
  });
  sendJson(res, 200, updated);
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

async function handleSkillCreate(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  const body = await readBody(req);
  const harness = (body.harness?.trim() || "codex").toLowerCase();
  if (!isSkillHarness(harness)) {
    badRequest(res, `unsupported skill harness '${harness}'`);
    return;
  }
  const source = body.source?.trim() || "";
  if (!source) {
    badRequest(res, "source is required");
    return;
  }
  const skillName = body.skillName?.trim() || "";
  if (!skillName) {
    badRequest(res, "skillName is required");
    return;
  }
  const created = await createPortalSkill({
    userId,
    harness: harness as SkillHarness,
    source,
    skillName,
    ...(body.skillId?.trim() ? { skillId: body.skillId.trim() } : {}),
  });
  sendJson(res, 201, created);
}

async function handleWorkspaceSkillAction(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  workspace: string,
  action: "list" | "install" | "uninstall" | "sync",
): Promise<void> {
  const body = await readBody(req);
  const harness = (body.harness?.trim() || "codex").toLowerCase();
  if (!isSkillHarness(harness)) {
    badRequest(res, `unsupported skill harness '${harness}'`);
    return;
  }
  if (action === "list") {
    sendJson(res, 200, await listPortalWorkspaceSkills({
      userId,
      workspace,
      harness: harness as SkillHarness,
    }));
    return;
  }
  if (action === "sync") {
    sendJson(res, 200, await syncPortalWorkspaceSkills({
      userId,
      workspace,
      harness: harness as SkillHarness,
    }));
    return;
  }
  const skillId = body.skillId?.trim() || "";
  if (!skillId) {
    badRequest(res, "skillId is required");
    return;
  }
  if (action === "install") {
    sendJson(res, 200, await installPortalWorkspaceSkill({
      userId,
      workspace,
      harness: harness as SkillHarness,
      skillId,
    }));
    return;
  }
  sendJson(res, 200, await uninstallPortalWorkspaceSkill({
    userId,
    workspace,
    harness: harness as SkillHarness,
    skillId,
  }));
}

async function handleProfileUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  const body = await readBody(req);
  const updated = await updatePortalUserProfile(userId, {
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
  const session = await requirePortalSession(req, res);
  if (!session) {
    return;
  }
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
  if (session.role !== "admin") {
    if (session.polarisUserId) {
      sendJson(res, 403, { error: "This Clerk user is already provisioned in Polaris" });
      return;
    }
    if (!sessionMatchesCurrentIdentity(session, { clerkUsername, clerkUserId })) {
      sendJson(res, 403, { error: "User creation must match the authenticated Clerk identity" });
      return;
    }
    if (userProfileId !== selfProvisionedPolarisUserId(session)) {
      sendJson(res, 403, { error: "User creation must use the current Clerk identity as the Polaris user id" });
      return;
    }
  }
  try {
    const created = await createPortalUser({
      userProfileId,
      ...(session.role === "admin"
        ? (clerkUsername ? { clerkUsername } : {})
        : (session.clerkUsername ? { clerkUsername: session.clerkUsername } : {})),
      ...(session.role === "admin"
        ? (clerkUserId ? { clerkUserId } : {})
        : { clerkUserId: session.clerkUserId }),
      ...(body.email?.trim() ? { email: body.email.trim() } : {}),
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(session.role === "admin" && (body.role === "admin" || body.role === "user")
        ? { role: body.role }
        : {}),
      ...(session.role === "admin" && (body.plan === "free" || body.plan === "pro")
        ? { plan: body.plan }
        : {}),
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

async function handleUserDelete(
  res: ServerResponse,
  userId: string,
): Promise<void> {
  sendJson(res, 200, await deletePortalUser(userId));
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
          "access-control-allow-headers": "authorization,content-type",
        });
        res.end();
        return;
      }

      if (segments.length === 0) {
        sendJson(res, 200, {
          service: "polaris-portal-api",
          authMode: "clerk-browser-session",
          endpoints: [
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
          const session = await requirePortalSession(req, res);
          if (!session || !requireMappedPortalSession(res, session)) {
            return;
          }
          sendJson(
            res,
            200,
            session.role === "admin"
              ? listPortalProfiles()
              : listPortalProfiles().filter((profile) => profile.id === session.polarisUserId),
          );
          return;
        }
        if (segments.length === 3 && segments[1] === "users" && req.method === "DELETE") {
          const session = await requirePortalSession(req, res);
          if (!session || !requirePortalAdmin(res, session)) {
            return;
          }
          if (session.polarisUserId === decodeURIComponent(segments[2])) {
            sendJson(res, 403, { error: "The current admin cannot delete their own Polaris user" });
            return;
          }
          await handleUserDelete(res, decodeURIComponent(segments[2]));
          return;
        }
        if (segments.length === 2 && segments[1] === "user-mapping" && req.method === "GET") {
          const session = await requirePortalSession(req, res);
          if (!session) {
            return;
          }
          const clerkUsername = url.searchParams.get("clerkUsername")?.trim() || "";
          const clerkUserId = url.searchParams.get("clerkUserId")?.trim() || "";
          if (!sessionMatchesCurrentIdentity(session, { clerkUsername, clerkUserId })) {
            sendJson(res, 403, { error: "The requested mapping does not match the authenticated Clerk identity" });
            return;
          }
          sendJson(res, 200, {
            clerkUsername: session.clerkUsername ?? "",
            clerkUserId: session.clerkUserId,
            mapping: session.clerkUserId || session.clerkUsername
              ? findUserMapEntry({
                clerkUserId: session.clerkUserId,
                ...(session.clerkUsername ? { clerkUsername: session.clerkUsername } : {}),
              })
              : null,
          });
          return;
        }
        if (segments.length === 3 && segments[1] === "admin" && segments[2] === "users" && req.method === "GET") {
          const session = await requirePortalSession(req, res);
          if (!session || !requirePortalAdmin(res, session)) {
            return;
          }
          sendJson(res, 200, {
            users: listPortalAdminUsers(),
          });
          return;
        }
        if (segments[1] === "session") {
          const session = await requirePortalSession(req, res);
          if (!session) {
            return;
          }
          sendJson(res, 200, {
            authMode: "clerk-browser-session",
            authenticated: true,
            clerkUserId: session.clerkUserId,
            clerkUsername: session.clerkUsername,
            polarisUserId: session.polarisUserId,
            role: session.role,
          });
          return;
        }
        if (segments[1] !== "users" || segments.length < 4) {
          notFound(res);
          return;
        }
        const session = await requirePortalSession(req, res);
        if (!session) {
          return;
        }
        const routeUserId = decodeURIComponent(segments[2]);
        if (!requirePortalScope(res, session, routeUserId)) {
          return;
        }
        const profile = requireProfile(res, routeUserId);
        if (!profile) {
          return;
        }
        const workspace = decodeURIComponent(segments[4] ?? "");
        if (segments.length === 4 && segments[3] === "workspaces" && req.method === "GET") {
          const workspaces = await listPortalWorkspaces(routeUserId);
          sendJson(res, 200, {
            user: profile,
            workspaces,
            archivedWorkspaces: listPortalArchivedWorkspaces(routeUserId),
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
        if (segments[3] === "skills" && segments.length === 4) {
          if (req.method === "POST") {
            await handleSkillCreate(req, res, routeUserId);
            return;
          }
          sendJson(res, 200, {
            user: profile,
            skills: listUserPortalSkills(routeUserId),
          });
          return;
        }
        if (segments[3] === "skills" && segments.length === 5 && req.method === "DELETE") {
          const skillId = decodeURIComponent(segments[4]);
          sendJson(res, 200, await deletePortalSkill(routeUserId, skillId));
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
        if (segments[3] === "credentials" && segments.length === 5 && req.method === "GET") {
          const credentialId = decodeURIComponent(segments[4]);
          sendJson(res, 200, readUserPortalCredentialRecord(routeUserId, credentialId));
          return;
        }
        if (segments[3] === "credentials" && segments.length === 6 && segments[5] === "activate" && req.method === "POST") {
          const credentialId = decodeURIComponent(segments[4]);
          await handleCredentialActivate(res, routeUserId, credentialId);
          return;
        }
        if (segments[3] === "credentials" && segments.length === 7 && segments[5] === "files" && req.method === "PUT") {
          const credentialId = decodeURIComponent(segments[4]);
          const fileKey = decodeURIComponent(segments[6]);
          await handleCredentialWrite(req, res, routeUserId, credentialId, fileKey);
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
        if (segments[3] === "workspaces" && segments.length === 6 && segments[4] === "archives" && req.method === "DELETE") {
          await handleArchivedWorkspaceDelete(res, routeUserId, decodeURIComponent(segments[5]));
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
        if (segments[3] === "workspaces" && segments.length === 6 && segments[5] === "rebuild" && req.method === "POST") {
          await handleWorkspaceRebuild(res, routeUserId, workspace);
          return;
        }
        if (segments[3] === "workspaces" && segments.length === 6 && segments[5] === "refresh" && req.method === "POST") {
          await handleWorkspaceRefresh(res, routeUserId, workspace);
          return;
        }
        if (segments[3] === "workspaces" && segments.length === 7 && segments[5] === "paseo" && segments[6] === "status" && req.method === "GET") {
          await handleWorkspacePaseoStatus(res, routeUserId, workspace);
          return;
        }
        if (segments[3] === "workspaces" && segments.length === 7 && segments[5] === "paseo" && segments[6] === "restart" && req.method === "POST") {
          await handleWorkspacePaseoRestart(res, routeUserId, workspace);
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
        if (
          segments[3] === "workspaces" &&
          segments.length === 7 &&
          segments[5] === "skills"
        ) {
          if (segments[6] === "list" && req.method === "POST") {
            await handleWorkspaceSkillAction(req, res, routeUserId, workspace, "list");
            return;
          }
          if (segments[6] === "install" && req.method === "POST") {
            await handleWorkspaceSkillAction(req, res, routeUserId, workspace, "install");
            return;
          }
          if (segments[6] === "uninstall" && req.method === "POST") {
            await handleWorkspaceSkillAction(req, res, routeUserId, workspace, "uninstall");
            return;
          }
          if (segments[6] === "sync" && req.method === "POST") {
            await handleWorkspaceSkillAction(req, res, routeUserId, workspace, "sync");
            return;
          }
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
          try {
            assertProjectNameAvailableForUser(workspaceName, routeUserId);
          } catch (error) {
            sendJson(res, 409, {
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          if ((await listPortalWorkspaces(routeUserId)).some((entry) => entry.name === workspaceName)) {
            sendJson(res, 409, {
              error: `Workspace '${workspaceName}' already exists for user ${routeUserId}.`,
            });
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
