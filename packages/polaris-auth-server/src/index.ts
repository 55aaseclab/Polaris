import type { IncomingMessage } from "node:http";
import { SignJWT, jwtVerify } from "jose";

export type PortalAuthMode = "authing-browser-session" | "disabled";
export type PortalPlan = "free" | "pro" | null;
export type PortalRole = "admin" | "user";

export interface PortalAuthIdentity {
  authMode: "authing-browser-session";
  authingUserId: string;
  authingUsername: string | null;
  authingPhoneNumber: string | null;
}

export interface DisabledPortalSessionConfig {
  authMode: "disabled";
  authingUserId: string;
  authingUsername: string;
  authingPhoneNumber: null;
  polarisUserId: string;
  role: PortalRole;
  plan: PortalPlan;
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

export class PortalAuthError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "PortalAuthError";
    this.statusCode = statusCode;
  }
}

function requiredAuthingEnv(
  name:
    | "POLARIS_AUTHING_APP_ID"
    | "POLARIS_AUTHING_APP_SECRET"
    | "POLARIS_AUTHING_ISSUER"
    | "POLARIS_AUTHING_TOKEN_URL",
): string {
  const value = String(process.env[name] ?? "").trim();
  if (!value) {
    throw new PortalAuthError(`${name} is required for Polaris portal auth`, 500);
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

export function resolveAuthingUsername(user: {
  username?: string;
  preferred_username?: string;
  nickname?: string;
  email?: string;
}): string | null {
  return normalizeAuthingUsername(
    user.username ?? user.preferred_username ?? user.nickname ?? user.email ?? null,
  ) ?? emailLocalPart(user.email ?? null);
}

function portalSessionSecret(): Uint8Array {
  const configured = String(process.env.POLARIS_AUTH_SHARED_SECRET ?? "").trim();
  const secret = configured || requiredAuthingEnv("POLARIS_AUTHING_APP_SECRET");
  return new TextEncoder().encode(secret);
}

function authingIssuerMeUrl(): string {
  return `${requiredAuthingEnv("POLARIS_AUTHING_ISSUER").replace(/\/+$/, "")}/me`;
}

async function verifyAuthingToken(token: string): Promise<AuthingClaims> {
  const { payload } = await jwtVerify(token, portalSessionSecret(), {
    issuer: "polaris",
    audience: "polaris-portal",
  });
  return payload as AuthingClaims;
}

async function readAuthingUser(accessToken: string): Promise<AuthingClaims> {
  let response: Response;
  try {
    response = await fetch(authingIssuerMeUrl(), {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new PortalAuthError("Authing user info could not be reached", 502);
  }
  if (!response.ok) {
    throw new PortalAuthError("Authing user info request failed", 401);
  }
  const payload = (await response.json()) as AuthingClaims;
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

function resolveDisabledPolarisUserId(): string {
  const value = String(process.env.POLARIS_AUTH_DEFAULT_USER_ID ?? "").trim();
  return value || "100000000000000001";
}

function resolveDisabledPortalRole(): PortalRole {
  return String(process.env.POLARIS_AUTH_DEFAULT_ROLE ?? "").trim() === "user"
    ? "user"
    : "admin";
}

function resolveDisabledPortalPlan(): PortalPlan {
  return String(process.env.POLARIS_AUTH_DEFAULT_PLAN ?? "").trim() === "pro"
    ? "pro"
    : "free";
}

export function resolvePortalAuthMode(): PortalAuthMode {
  return String(process.env.POLARIS_AUTH_MODE ?? "").trim().toLowerCase() === "disabled"
    ? "disabled"
    : "authing-browser-session";
}

export function resolveDisabledPortalSession(): DisabledPortalSessionConfig | null {
  if (resolvePortalAuthMode() !== "disabled") {
    return null;
  }
  const polarisUserId = resolveDisabledPolarisUserId();
  const authingUsername =
    String(process.env.POLARIS_AUTH_DEFAULT_AUTHING_USERNAME ?? "").trim() ||
    polarisUserId;
  const authingUserId =
    String(process.env.POLARIS_AUTH_DEFAULT_AUTHING_USER_ID ?? "").trim() ||
    `local-dev-authing-user:${polarisUserId}`;
  return {
    authMode: "disabled",
    authingUserId,
    authingUsername,
    authingPhoneNumber: null,
    polarisUserId,
    role: resolveDisabledPortalRole(),
    plan: resolveDisabledPortalPlan(),
  };
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
    const failure = (await response.json().catch(() => null)) as {
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
    ].find((value) => typeof value === "string" && value.trim());
    const message = detail
      ? `Authing token exchange failed: ${String(detail).trim()}`
      : "Authing token exchange failed";
    throw new PortalAuthError(message, response.status === 400 ? 400 : 401);
  }
  const payload = (await response.json()) as {
    access_token?: unknown;
    id_token?: unknown;
  };
  const accessToken = String(payload.access_token ?? "").trim();
  const idToken = String(payload.id_token ?? "").trim();
  if (!accessToken) {
    throw new PortalAuthError(
      "Authing token exchange did not return a session token",
      502,
    );
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

export async function authenticatePortalIdentity(
  req: IncomingMessage,
): Promise<PortalAuthIdentity> {
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
  return {
    authMode: "authing-browser-session",
    authingUserId,
    authingUsername: resolveAuthingUsername(verified),
    authingPhoneNumber: String(verified.phoneNumber ?? "").trim() || null,
  };
}
