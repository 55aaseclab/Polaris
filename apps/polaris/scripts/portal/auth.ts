import type { IncomingMessage, ServerResponse } from "node:http";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { findUserMapEntry, type PolarisPlan, type PolarisRole } from "./user-map.js";

export interface AuthenticatedPortalSession {
  clerkUserId: string;
  clerkUsername: string | null;
  polarisUserId: string | null;
  role: PolarisRole | null;
  plan: PolarisPlan | null;
}

interface ClerkLikeUser {
  id?: string | null;
  username?: string | null;
  primaryEmailAddress?: { emailAddress?: string | null } | null;
  emailAddresses?: Array<{ emailAddress?: string | null }>;
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

function clerkSecretKey(): string {
  const value = String(process.env.CLERK_SECRET_KEY ?? "").trim();
  if (!value) {
    throw new Error("CLERK_SECRET_KEY is required for Polaris portal auth");
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

function normalizeClerkUsername(value: string | null | undefined): string | null {
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

function resolveClerkUsername(user: ClerkLikeUser): string | null {
  return normalizeClerkUsername(
    user.username
      ?? user.primaryEmailAddress?.emailAddress
      ?? user.emailAddresses?.[0]?.emailAddress
      ?? null,
  ) ?? emailLocalPart(
    user.primaryEmailAddress?.emailAddress
      ?? user.emailAddresses?.[0]?.emailAddress
      ?? null,
  );
}

async function fetchClerkUser(clerkUserId: string): Promise<ClerkLikeUser> {
  const client = createClerkClient({
    secretKey: clerkSecretKey(),
  });
  return await client.users.getUser(clerkUserId);
}

function readTestSession(req: IncomingMessage): AuthenticatedPortalSession | null {
  if (process.env.NODE_ENV !== "test" && process.env.POLARIS_TEST_PORTAL_AUTH !== "1") {
    return null;
  }
  const clerkUserId = readHeader(req, "x-polaris-test-clerk-user-id");
  if (!clerkUserId) {
    return {
      clerkUserId: "test-clerk-admin",
      clerkUsername: "test-admin",
      polarisUserId: "100000000000000001",
      role: "admin",
      plan: "free",
    };
  }
  const clerkUsername = normalizeClerkUsername(
    readHeader(req, "x-polaris-test-clerk-username"),
  );
  const polarisUserId = readHeader(req, "x-polaris-test-polaris-user-id");
  const roleHeader = readHeader(req, "x-polaris-test-role");
  const planHeader = readHeader(req, "x-polaris-test-plan");
  return {
    clerkUserId,
    clerkUsername,
    polarisUserId: polarisUserId || null,
    role: roleHeader === "admin" || roleHeader === "user" ? roleHeader : null,
    plan: planHeader === "free" || planHeader === "pro" ? planHeader : null,
  };
}

export async function authenticatePortalRequest(
  req: IncomingMessage,
): Promise<AuthenticatedPortalSession> {
  const testSession = readTestSession(req);
  if (testSession) {
    return testSession;
  }
  const token = readBearerToken(req);
  if (!token) {
    throw new Error("missing-auth-token");
  }
  const verified = await verifyToken(token, {
    secretKey: clerkSecretKey(),
  });
  const clerkUserId = String(verified.sub ?? "").trim();
  if (!clerkUserId) {
    throw new Error("invalid-auth-token");
  }
  const clerkUser = await fetchClerkUser(clerkUserId);
  const clerkUsername = resolveClerkUsername(clerkUser);
  const mapping = findUserMapEntry({
    clerkUserId,
    ...(clerkUsername ? { clerkUsername } : {}),
  });
  return {
    clerkUserId,
    clerkUsername,
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
    unauthorized(
      res,
      error instanceof Error && error.message === "missing-auth-token"
        ? "Authentication is required"
        : "Invalid Clerk session",
    );
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
    forbidden(res, "Polaris access is not provisioned for this Clerk user");
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
    clerkUserId?: string;
    clerkUsername?: string;
  },
): boolean {
  const requestedUserId = String(input.clerkUserId ?? "").trim();
  if (requestedUserId && requestedUserId !== session.clerkUserId) {
    return false;
  }
  const requestedUsername = normalizeClerkUsername(input.clerkUsername);
  if (requestedUsername && requestedUsername !== session.clerkUsername) {
    return false;
  }
  return true;
}

export function selfProvisionedPolarisUserId(session: AuthenticatedPortalSession): string {
  return session.clerkUsername || session.clerkUserId;
}
