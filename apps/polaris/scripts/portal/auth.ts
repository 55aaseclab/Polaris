import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authenticatePortalIdentity,
  exchangeAuthingAuthorizationCode,
  PortalAuthError,
  resolveDisabledPortalSession,
  type PortalAuthMode,
} from "@polaris/polaris-auth-server";
import {
  findUserMapEntry,
  readUserAccessSummary,
  type PolarisPlan,
  type PolarisRole,
  type PolarisSubscriptionLine,
} from "./user-map.js";

export { exchangeAuthingAuthorizationCode, PortalAuthError };

export interface AuthenticatedPortalSession {
  authMode: PortalAuthMode;
  authingUserId: string;
  authingUsername: string | null;
  authingPhoneNumber: string | null;
  polarisUserId: string | null;
  role: PolarisRole | null;
  /** Feature richness; reserved, not product line. */
  plan: PolarisPlan | null;
  /** coding | vertical product line for this user. */
  line: PolarisSubscriptionLine | null;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function unauthorized(res: ServerResponse, message = "Authentication is required"): void {
  sendJson(res, 401, { error: message });
}

function forbidden(res: ServerResponse, message = "Forbidden"): void {
  sendJson(res, 403, { error: message });
}

function normalizeAuthingUsername(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || null;
}

export async function authenticatePortalRequest(
  req: IncomingMessage,
): Promise<AuthenticatedPortalSession> {
  const disabledSession = resolveDisabledPortalSession();
  if (disabledSession) {
    const accessSummary = readUserAccessSummary(disabledSession.polarisUserId);
    return {
      ...disabledSession,
      ...(accessSummary
        ? {
          role: accessSummary.role,
          plan: accessSummary.plan,
          line: accessSummary.line,
          authingUsername:
            accessSummary.authingUsernames[0]
            ?? disabledSession.authingUsername,
        }
        : {}),
    };
  }
  const identity = await authenticatePortalIdentity(req);
  const mapping = findUserMapEntry({
    authingUserId: identity.authingUserId,
    ...(identity.authingUsername ? { authingUsername: identity.authingUsername } : {}),
  });
  if (mapping) {
    const accessSummary = readUserAccessSummary(mapping.polarisUserId);
    return {
      authMode: identity.authMode,
      authingUserId: identity.authingUserId,
      authingUsername: accessSummary?.authingUsernames[0] ?? identity.authingUsername,
      authingPhoneNumber: identity.authingPhoneNumber,
      polarisUserId: mapping.polarisUserId,
      role: mapping.role,
      plan: mapping.plan,
      line: mapping.line,
    };
  }
  return {
    authMode: identity.authMode,
    authingUserId: identity.authingUserId,
    authingUsername: identity.authingUsername,
    authingPhoneNumber: identity.authingPhoneNumber,
    polarisUserId: null,
    role: null,
    plan: null,
    line: null,
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
  line: PolarisSubscriptionLine | null;
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
