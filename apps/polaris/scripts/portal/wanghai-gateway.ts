import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthenticatedPortalSession } from "./auth.js";
import {
  deriveWanghaiVaultAssertionSecret,
  issueWanghaiAssertion,
  issueWanghaiLaunchTicket,
  issueWanghaiSession,
  requireWanghaiGatewayMasterSecret,
  verifyWanghaiLaunchToken,
  type WanghaiAssertionAdmission,
  type WanghaiGatewayRole,
  type WanghaiLaunchClaims,
  type WanghaiQuotaMeasurement,
} from "../security/wanghai-assertions.js";
import { getPolarisControlStore } from "./control-store.js";

/** Public Polaris-owned gateway routes. */
export const POLARIS_GATEWAY_LAUNCH_PATH = "/api/g";
export const POLARIS_GATEWAY_PATH = "/g";

/** Private Wanghai application mount used by the upstream image. */
export const WANGHAI_PORTAL_BASE_PATH = "/wanghai";

export const WANGHAI_GATEWAY_SESSION_COOKIE = "polaris_wanghai_session";
export const WANGHAI_GATEWAY_ASSERTION_HEADER = "x-polaris-wanghai-assertion";
export const WANGHAI_GATEWAY_REQUEST_ID_HEADER = "x-polaris-request-id";

export interface WanghaiGatewayLaunch {
  serverId: string;
  userId: string;
  tenantId: string;
  vaultId: string;
  role: WanghaiGatewayRole;
  ticket: string;
  portalUrl: string;
}

export function wanghaiRoleForPortalSession(
  session: Pick<AuthenticatedPortalSession, "role">,
): WanghaiGatewayRole {
  return session.role === "admin" ? "admin" : "operator";
}

export function createWanghaiGatewayLaunch(input: {
  session: Pick<AuthenticatedPortalSession, "polarisUserId" | "role">;
  serverId: string;
  vaultId: string;
}): WanghaiGatewayLaunch {
  const userId = input.session.polarisUserId?.trim();
  if (!userId || !input.session.role) {
    throw new Error("A mapped Polaris session is required for Wanghai access");
  }
  const serverId = input.serverId.trim();
  const vaultId = input.vaultId.trim();
  if (!serverId || !vaultId) {
    throw new Error("serverId and vaultId are required");
  }
  const masterSecret = requireWanghaiGatewayMasterSecret();
  const role = wanghaiRoleForPortalSession(input.session);
  const ticket = issueWanghaiLaunchTicket({
    masterSecret,
    serverId,
    userId,
    tenantId: userId,
    vaultId,
    role,
  });
  return {
    serverId,
    userId,
    tenantId: userId,
    vaultId,
    role,
    ticket,
    portalUrl: wanghaiGatewayPortalUrl(ticket),
  };
}

export function wanghaiGatewayPortalUrl(ticket: string): string {
  const base = configuredGatewayOrigin();
  base.pathname = `${POLARIS_GATEWAY_PATH}/`;
  base.search = "";
  base.hash = "";
  base.searchParams.set("ticket", ticket);
  return base.toString();
}

export function isPolarisGatewayPath(pathname: string | undefined): boolean {
  const path = String(pathname ?? "");
  return path === POLARIS_GATEWAY_PATH || path.startsWith(`${POLARIS_GATEWAY_PATH}/`);
}

/**
 * The image currently ships a build-time `/wanghai` Next base path. Keep that
 * mount protected as a compatibility path for the image's generated asset
 * and navigation URLs; all new launch URLs use the Polaris `/g` path.
 */
export function isWanghaiCompatibilityPath(pathname: string | undefined): boolean {
  const path = String(pathname ?? "");
  return path === WANGHAI_PORTAL_BASE_PATH
    || path.startsWith(`${WANGHAI_PORTAL_BASE_PATH}/`);
}

export function gatewayPathKind(
  pathname: string | undefined,
): "canonical" | "compatibility" | null {
  if (isPolarisGatewayPath(pathname)) return "canonical";
  if (isWanghaiCompatibilityPath(pathname)) return "compatibility";
  return null;
}

export function gatewayRequestPath(pathname: string): string {
  const kind = gatewayPathKind(pathname);
  if (!kind) {
    throw new Error("Invalid Polaris gateway path");
  }
  const prefix = kind === "canonical"
    ? POLARIS_GATEWAY_PATH
    : WANGHAI_PORTAL_BASE_PATH;
  const suffix = pathname.slice(prefix.length);
  return suffix === "" || suffix === "/" ? "/" : suffix;
}

export function isPolarisGatewayLaunchRoute(segments: readonly string[]): boolean {
  const prefix = POLARIS_GATEWAY_LAUNCH_PATH.split("/").filter(Boolean);
  return segments.length === prefix.length + 2
    && prefix.every((segment, index) => segments[index] === segment)
    && segments.at(-1) === "launch";
}

export function gatewayCookieName(): string {
  return WANGHAI_GATEWAY_SESSION_COOKIE;
}

export function readGatewayCookie(
  req: IncomingMessage,
): string | null {
  const cookieHeader = String(req.headers.cookie ?? "");
  const name = gatewayCookieName();
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim()) || null;
  }
  return null;
}

export function setGatewaySessionCookie(
  res: ServerResponse,
  token: string,
  secure: boolean,
): void {
  const name = gatewayCookieName();
  const attributes = `HttpOnly; SameSite=Lax; Max-Age=900${secure ? "; Secure" : ""}`;
  res.setHeader(
    "set-cookie",
    [POLARIS_GATEWAY_PATH, WANGHAI_PORTAL_BASE_PATH].map(
      (path) => `${name}=${encodeURIComponent(token)}; Path=${path}; ${attributes}`,
    ),
  );
}

export function verifyGatewaySession(
  req: IncomingMessage,
): WanghaiLaunchClaims {
  const token = readGatewayCookie(req);
  if (!token) {
    throw new Error("Wanghai gateway session is required");
  }
  const claims = verifyWanghaiLaunchToken(token, requireWanghaiGatewayMasterSecret());
  if (claims.kind !== "session") {
    throw new Error("Wanghai gateway session scope is invalid");
  }
  return claims;
}

export function consumeLaunchTicket(input: {
  req: IncomingMessage;
  res: ServerResponse;
  ticket: string;
  secure: boolean;
}): WanghaiLaunchClaims {
  const claims = verifyWanghaiLaunchToken(
    input.ticket,
    requireWanghaiGatewayMasterSecret(),
  );
  if (claims.kind !== "launch") {
    throw new Error("Wanghai launch ticket scope is invalid");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const store = getPolarisControlStore(import.meta.url);
  const redeemed = store.redeemGatewayTicket(
    claims.jti,
    claims.exp,
    nowSeconds,
  );
  if (!redeemed) {
    store.recordAudit({
      actorId: claims.user_id,
      tenantId: claims.tenant_id,
      vaultId: claims.vault_id,
      action: "wanghai.gateway.ticket-redeem",
      outcome: "denied",
      metadata: { reason: "replayed-or-expired", serverId: claims.server_id },
    });
    throw new Error("Wanghai launch ticket was already redeemed");
  }
  const session = issueWanghaiSession({
    masterSecret: requireWanghaiGatewayMasterSecret(),
    launch: claims,
  });
  setGatewaySessionCookie(input.res, session, input.secure);
  store.recordAudit({
    actorId: claims.user_id,
    tenantId: claims.tenant_id,
    vaultId: claims.vault_id,
    action: "wanghai.gateway.ticket-redeem",
    outcome: "success",
    metadata: { serverId: claims.server_id },
  });
  return claims;
}

export function issueRequestAssertion(input: {
  session: WanghaiLaunchClaims;
  requestId?: string;
  admission?: WanghaiAssertionAdmission;
  quotaMeasurement?: WanghaiQuotaMeasurement;
}): string {
  const masterSecret = requireWanghaiGatewayMasterSecret();
  const secret = deriveWanghaiVaultAssertionSecret(
    masterSecret,
    input.session.tenant_id,
    input.session.vault_id,
  );
  return issueWanghaiAssertion({
    secret,
    userId: input.session.user_id,
    tenantId: input.session.tenant_id,
    vaultId: input.session.vault_id,
    role: input.session.role,
    requestId: input.requestId ?? randomUUID(),
    admission: input.admission,
    quotaMeasurement: input.quotaMeasurement,
  });
}

export function requestUsesExpectedOrigin(
  req: IncomingMessage,
  expectedProtocol: "http:" | "https:",
): boolean {
  const origin = String(req.headers.origin ?? "").trim();
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    const host = hostnameOnly(req.headers.host);
    return parsed.protocol === expectedProtocol && hostnameOnly(parsed.hostname) === host
      && (parsed.port || defaultPort(parsed.protocol)) === (portOnly(req.headers.host) || defaultPort(expectedProtocol));
  } catch {
    return false;
  }
}

export function configuredGatewayProtocol(): "http:" | "https:" {
  return configuredGatewayOrigin().protocol as "http:" | "https:";
}

/**
 * Return the exact Polaris shell origins permitted to frame a Wanghai gateway
 * page. A bare X-Frame-Options value cannot allow a separate shell origin.
 */
export function configuredWanghaiFrameAncestors(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const values = [
    env.POLARIS_PORTAL_ORIGIN,
    env.POLARIS_PORTAL_ALLOWED_ORIGINS,
  ]
    .flatMap((value) => String(value ?? "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error(
      "POLARIS_PORTAL_ALLOWED_ORIGINS is required to configure Wanghai frame ancestors",
    );
  }
  return [...new Set(values.map(normalizeFrameAncestorOrigin))].join(" ");
}

function configuredGatewayOrigin(): URL {
  const raw = String(process.env.POLARIS_WANGHAI_GATEWAY_ORIGIN ?? "").trim();
  if (!raw) {
    throw new Error("POLARIS_WANGHAI_GATEWAY_ORIGIN is required");
  }
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("POLARIS_WANGHAI_GATEWAY_ORIGIN must use http or https");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("POLARIS_WANGHAI_GATEWAY_ORIGIN must be an origin only");
  }
  return parsed;
}

function normalizeFrameAncestorOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("POLARIS_PORTAL_ALLOWED_ORIGINS must contain bare HTTP(S) origins");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("POLARIS_PORTAL_ALLOWED_ORIGINS must contain bare HTTP(S) origins");
  }
  return parsed.origin;
}

function hostnameOnly(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase().replace(/^\[|\]$/gu, "").split(":")[0] ?? "";
}

function portOnly(value: string | undefined): string {
  const raw = String(value ?? "").trim();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end >= 0 && raw[end + 1] === ":" ? raw.slice(end + 2) : "";
  }
  const separator = raw.lastIndexOf(":");
  return separator >= 0 ? raw.slice(separator + 1) : "";
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}
