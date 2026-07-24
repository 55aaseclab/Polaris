import type { IncomingMessage, ServerResponse } from "node:http";
import { SignJWT, jwtVerify } from "jose";
import {
  findUserMapEntry,
  readUserAccessSummary,
  type PolarisPlan,
  type PolarisRole,
} from "./user-map.js";

export interface AuthenticatedPortalSession {
  authingUserId: string;
  authingUsername: string | null;
  authingPhoneNumber: string | null;
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
  username?: string;
  preferred_username?: string;
  nickname?: string;
  email?: string;
  phone?: string;
  phone_number?: string;
  phoneNumber?: string;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": String(res.getHeader("access-control-allow-origin") ?? "*"),
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-allow-credentials": "true",
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
  name:
    | "POLARIS_AUTHING_APP_ID"
    | "POLARIS_AUTHING_APP_SECRET"
    | "POLARIS_AUTHING_ISSUER"
    | "POLARIS_AUTHING_JWKS_URL"
    | "POLARIS_AUTHING_TOKEN_URL",
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
    user.username
      ?? user.preferred_username
      ?? user.nickname
      ?? user.email
      ?? null,
  ) ?? emailLocalPart(user.email ?? null);
}

function portalSessionSecret(): Uint8Array {
  const configured = String(process.env.POLARIS_AUTH_SHARED_SECRET ?? "").trim();
  const secret = configured || requiredAuthingEnv("POLARIS_AUTHING_APP_SECRET");
  return new TextEncoder().encode(secret);
}

async function verifyAuthingToken(token: string): Promise<AuthingClaims> {
  const { payload } = await jwtVerify(token, portalSessionSecret(), {
    issuer: "polaris",
    audience: "polaris-portal",
  });
  return payload as AuthingClaims;
}

async function readAuthingUser(accessToken: string): Promise<AuthingClaims> {
  const issuer = requiredAuthingEnv("POLARIS_AUTHING_ISSUER").replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetch(`${issuer}/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new PortalAuthError("Authing user info could not be reached", 502);
  }
  if (!response.ok) {
    throw new PortalAuthError("Authing user info request failed", 401);
  }
  const payload = await response.json() as AuthingClaims;
  if (!String(payload.sub ?? "").trim()) {
    throw new PortalAuthError("Authing user info did not return a subject", 502);
  }
  return payload;
}

async function createPortalSession(user: AuthingClaims): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    username: user.username,
    preferred_username: user.preferred_username,
    nickname: user.nickname,
    email: user.email,
    phoneNumber: user.phone_number ?? user.phone ?? user.phoneNumber,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("polaris")
    .setAudience("polaris-portal")
    .setSubject(String(user.sub).trim())
    .setIssuedAt(now)
    .setExpirationTime(now + 60 * 60 * 8)
    .sign(portalSessionSecret());
}

export async function exchangeAuthingAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<{ token: string; idToken?: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: requiredAuthingEnv("POLARIS_AUTHING_APP_ID"),
    client_secret: requiredAuthingEnv("POLARIS_AUTHING_APP_SECRET"),
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  let response: Response;
  try {
    response = await fetch(requiredAuthingEnv("POLARIS_AUTHING_TOKEN_URL"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    throw new PortalAuthError("Authing token exchange could not be reached", 502);
  }
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as {
      error?: unknown;
      error_description?: unknown;
      errorDescription?: unknown;
      message?: unknown;
    } | null;
    const detail = [
      failure?.error_description,
      failure?.errorDescription,
      failure?.message,
      failure?.error,
    ]
      .find((value) => typeof value === "string" && value.trim());
    const message = detail
      ? `Authing token exchange failed: ${String(detail).trim()}`
      : "Authing token exchange failed";
    throw new PortalAuthError(message, response.status === 400 ? 400 : 401);
  }
  const payload = await response.json() as {
    access_token?: unknown;
    id_token?: unknown;
  };
  const accessToken = String(payload.access_token ?? "").trim();
  const idToken = String(payload.id_token ?? "").trim();
  if (!accessToken) {
    throw new PortalAuthError("Authing token exchange did not return a session token", 502);
  }
  const user = await readAuthingUser(accessToken);
  if (!resolveAuthingUsername(user)) {
    throw new PortalAuthError("Authing 用户信息未补全，请先完成用户名补全", 409);
  }
  return {
    token: await createPortalSession(user),
    ...(idToken ? { idToken } : {}),
  };
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
  const authingPhoneNumber = String(verified.phoneNumber ?? "").trim() || null;
  const authingUsername = resolveAuthingUsername(verified);
  const mapping = authingUsername
    ? findUserMapEntry({ authingUsername })
    : null;
  if (mapping) {
    const accessSummary = readUserAccessSummary(mapping.polarisUserId);
    return {
      authingUserId,
      authingUsername: accessSummary?.authingUsernames[0] ?? null,
      authingPhoneNumber,
      polarisUserId: mapping.polarisUserId,
      role: mapping.role,
      plan: mapping.plan,
    };
  }
  return {
    authingUserId,
    authingUsername,
    authingPhoneNumber,
    polarisUserId: null,
    role: null,
    plan: null,
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
  if (requestedUserId) {
    return true;
  }
  const requestedUsername = normalizeAuthingUsername(input.authingUsername);
  if (requestedUsername && requestedUsername !== session.authingUsername) {
    return false;
  }
  return true;
}

export function selfProvisionedPolarisUserId(session: AuthenticatedPortalSession): string {
  const authingUsername = session.authingUsername?.trim();
  if (!authingUsername) {
    throw new Error("Authing username is required for Polaris user creation");
  }
  return authingUsername;
}
