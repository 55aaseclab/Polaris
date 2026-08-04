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
  wanghaiGatewayHostLabel as assertionGatewayHostLabel,
  type WanghaiGatewayRole,
  type WanghaiLaunchClaims,
} from "../security/wanghai-assertions.js";
import { getPolarisControlStore } from "./control-store.js";

export const WANGHAI_GATEWAY_LAUNCH_PATH = "/api/wanghai";
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
    portalUrl: wanghaiGatewayPortalUrl(serverId, ticket),
  };
}

export function wanghaiGatewayPortalUrl(serverId: string, ticket: string): string {
  const base = configuredGatewayOrigin();
  base.hostname = `${wanghaiGatewayHostLabel(serverId)}.${base.hostname}`;
  base.pathname = "/";
  base.search = "";
  base.hash = "";
  base.searchParams.set("ticket", ticket);
  return base.toString();
}

export function wanghaiGatewayHostLabel(serverId: string): string {
  // Keep the hostname opaque and DNS-safe; the signed ticket carries the ID.
  return assertionGatewayHostLabel(serverId);
}

export function isWanghaiGatewayHost(hostHeader: string | undefined): boolean {
  try {
    const host = hostnameOnly(hostHeader);
    if (!host) return false;
    const base = hostnameOnly(configuredGatewayOrigin().hostname);
    if (!base || host === base) return false;
    const suffix = `.${base}`;
    if (!host.endsWith(suffix)) return false;
    const label = host.slice(0, -suffix.length);
    return /^v-[a-f0-9]{24}$/u.test(label);
  } catch {
    // The normal Polaris host remains available until the gateway is configured.
    return false;
  }
}

export function gatewayHostLabelFromRequest(req: IncomingMessage): string {
  const host = hostnameOnly(req.headers.host);
  const base = hostnameOnly(configuredGatewayOrigin().hostname);
  const suffix = `.${base}`;
  if (!host || !host.endsWith(suffix)) {
    throw new Error("Invalid Wanghai gateway host");
  }
  const label = host.slice(0, -suffix.length);
  if (!/^v-[a-f0-9]{24}$/u.test(label)) {
    throw new Error("Invalid Wanghai gateway host label");
  }
  return label;
}

export function gatewayCookieName(hostLabel: string): string {
  if (!/^v-[a-f0-9]{24}$/u.test(hostLabel)) {
    throw new Error("Invalid Wanghai gateway host label");
  }
  return `polaris_wanghai_${hostLabel}`;
}

export function readGatewayCookie(
  req: IncomingMessage,
  hostLabel: string,
): string | null {
  const cookieHeader = String(req.headers.cookie ?? "");
  const name = gatewayCookieName(hostLabel);
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
  hostLabel: string,
  token: string,
  secure: boolean,
): void {
  const name = gatewayCookieName(hostLabel);
  res.setHeader(
    "set-cookie",
    `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900${secure ? "; Secure" : ""}`,
  );
}

export function verifyGatewaySession(
  req: IncomingMessage,
  hostLabel: string,
): WanghaiLaunchClaims {
  const token = readGatewayCookie(req, hostLabel);
  if (!token) {
    throw new Error("Wanghai gateway session is required");
  }
  const claims = verifyWanghaiLaunchToken(token, requireWanghaiGatewayMasterSecret());
  if (claims.kind !== "session" || wanghaiGatewayHostLabel(claims.server_id) !== hostLabel) {
    throw new Error("Wanghai gateway session scope is invalid");
  }
  return claims;
}

export function consumeLaunchTicket(input: {
  req: IncomingMessage;
  res: ServerResponse;
  ticket: string;
  hostLabel: string;
  secure: boolean;
}): WanghaiLaunchClaims {
  const claims = verifyWanghaiLaunchToken(
    input.ticket,
    requireWanghaiGatewayMasterSecret(),
  );
  if (claims.kind !== "launch" || wanghaiGatewayHostLabel(claims.server_id) !== input.hostLabel) {
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
  setGatewaySessionCookie(input.res, input.hostLabel, session, input.secure);
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
