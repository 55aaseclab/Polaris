import type { IncomingMessage, ServerResponse } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  findUserMapEntry,
  readUserAccessSummary,
  type PolarisPlan,
  type PolarisRole,
} from "./user-map.js";

export interface AuthenticatedPortalSession {
  authingUserId: string;
  authingUsername: string | null;
  polarisUserId: string | null;
  role: PolarisRole | null;
  plan: PolarisPlan | null;
}

export class PortalAuthError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "PortalAuthError";
    this.statusCode = statusCode;
  }
}

interface AuthingClaims {
  sub?: string;
  preferred_username?: string;
  nickname?: string;
  email?: string;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
  });
  res.end(payload);
}

function unauthorized(res: ServerResponse, message = "Authentication is required"): void {
  sendJson(res, 401, { error: message });
}

function forbidden(res: ServerResponse, message = "Forbidden"): void {
  sendJson(res, 403, { error: message });
}

function requiredAuthingEnv(
  name: "POLARIS_AUTHING_APP_ID" | "POLARIS_AUTHING_ISSUER" | "POLARIS_AUTHING_JWKS_URL",
): string {
  const value = String(process.env[name] ?? "").trim();
  if (!value) {
    throw new PortalAuthError(
      `${name} is required for Polaris portal auth`,
      500,
    );
  }
  return value;
}

function readHeader(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return value[0]?.trim() || null;
  }
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBearerToken(req: IncomingMessage): string | null {
  const authorization = readHeader(req, "authorization");
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    return token || null;
  }
  const cookieHeader = readHeader(req, "cookie");
  if (!cookieHeader) {
    return null;
  }
  const sessionCookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("__session="));
  if (!sessionCookie) {
    return null;
  }
  const token = decodeURIComponent(sessionCookie.slice("__session=".length).trim());
  return token || null;
}

function normalizeAuthingUsername(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || null;
}

function emailLocalPart(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim().toLowerCase();
  if (!trimmed.includes("@")) {
    return null;
  }
  const [localPart] = trimmed.split("@", 1);
  return localPart?.trim() || null;
}

function resolveAuthingUsername(user: AuthingClaims): string | null {
  return normalizeAuthingUsername(
    user.preferred_username
      ?? user.nickname
      ?? user.email
      ?? null,
  ) ?? emailLocalPart(user.email ?? null);
}

async function verifyAuthingToken(token: string): Promise<AuthingClaims> {
  const issuer = requiredAuthingEnv("POLARIS_AUTHING_ISSUER");
  const jwks = createRemoteJWKSet(new URL(requiredAuthingEnv("POLARIS_AUTHING_JWKS_URL")));
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience: requiredAuthingEnv("POLARIS_AUTHING_APP_ID"),
  });
  return payload as AuthingClaims;
}

export async function authenticatePortalRequest(
  req: IncomingMessage,
): Promise<AuthenticatedPortalSession> {
  const token = readBearerToken(req);
  if (!token) {
    throw new PortalAuthError("Authentication is required", 401);
  }
  let verified: AuthingClaims;
  try {
    verified = await verifyAuthingToken(token);
  } catch (error) {
    if (error instanceof PortalAuthError) {
      throw error;
    }
    throw new PortalAuthError("Invalid Authing session", 401);
  }
  const authingUserId = String(verified.sub ?? "").trim();
  if (!authingUserId) {
    throw new PortalAuthError("Invalid Authing session", 401);
  }
  const directMapping = findUserMapEntry({ authingUserId });
  if (directMapping) {
    const accessSummary = readUserAccessSummary(directMapping.polarisUserId);
    return {
      authingUserId,
      authingUsername: accessSummary?.authingUsernames[0] ?? null,
      polarisUserId: directMapping.polarisUserId,
      role: directMapping.role,
      plan: directMapping.plan,
    };
  }
  const authingUsername = resolveAuthingUsername(verified);
  const mapping = findUserMapEntry({
    authingUserId,
    ...(authingUsername ? { authingUsername } : {}),
  });
  return {
    authingUserId,
    authingUsername,
    polarisUserId: mapping?.polarisUserId ?? null,
    role: mapping?.role ?? null,
    plan: mapping?.plan ?? null,
  };
}

export async function requirePortalSession(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<AuthenticatedPortalSession | null> {
  try {
    return await authenticatePortalRequest(req);
  } catch (error) {
    if (error instanceof PortalAuthError) {
      if (error.statusCode === 401) {
        unauthorized(res, error.message);
        return null;
      }
      sendJson(res, error.statusCode, { error: error.message });
      return null;
    }
    sendJson(res, 500, { error: "Portal authentication failed" });
    return null;
  }
}

export function requireMappedPortalSession(
  res: ServerResponse,
  session: AuthenticatedPortalSession | null,
): session is AuthenticatedPortalSession & {
  polarisUserId: string;
  role: PolarisRole;
  plan: PolarisPlan | null;
} {
  if (!session) {
    return false;
  }
  if (!session.polarisUserId || !session.role) {
    forbidden(res, "Polaris access is not provisioned for this Authing user");
    return false;
  }
  return true;
}

export function requirePortalAdmin(
  res: ServerResponse,
  session: AuthenticatedPortalSession | null,
): boolean {
  if (!requireMappedPortalSession(res, session)) {
    return false;
  }
  if (session.role !== "admin") {
    forbidden(res, "Admin access is required");
    return false;
  }
  return true;
}

export function requirePortalScope(
  res: ServerResponse,
  session: AuthenticatedPortalSession | null,
  routeUserId: string,
): boolean {
  if (!requireMappedPortalSession(res, session)) {
    return false;
  }
  if (session.role === "admin") {
    return true;
  }
  if (session.polarisUserId !== routeUserId) {
    forbidden(res, "Normal users can access only their own Polaris user scope");
    return false;
  }
  return true;
}

export function sessionMatchesCurrentIdentity(
  session: AuthenticatedPortalSession,
  input: {
    authingUserId?: string;
    authingUsername?: string;
  },
): boolean {
  const requestedUserId = String(input.authingUserId ?? "").trim();
  if (requestedUserId && requestedUserId !== session.authingUserId) {
    return false;
  }
  const requestedUsername = normalizeAuthingUsername(input.authingUsername);
  if (requestedUsername && requestedUsername !== session.authingUsername) {
    return false;
  }
  return true;
}

export function selfProvisionedPolarisUserId(session: AuthenticatedPortalSession): string {
  return session.authingUsername || session.authingUserId;
}
