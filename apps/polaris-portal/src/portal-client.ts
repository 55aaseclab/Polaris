import {
  resolveCodingSurfaceUrl,
  type ShellHostSummary,
  type ShellSession,
} from "@polaris/polaris-shell";
import type {
  WorkflowDomainPackProjection,
  WorkflowGraphProjection,
  WorkflowEventsResponse,
  WorkflowMockScenario,
  WorkflowRunProjection,
  WorkflowRunRequest,
  WorkflowRunsResponse,
  WorkflowSetupProjection,
  WorkflowSetupRequest,
  WorkflowSuggestionProjection,
  WorkflowVaultProjection,
} from "@polaris/polaris-shell";
import { localizedError } from "./i18n/messages.js";

const SESSION_TOKEN_KEY = "polaris_authing_session";
const ID_TOKEN_KEY = "polaris_authing_id_token";
const PKCE_VERIFIER_KEY = "polaris_authing_pkce_verifier";
const PKCE_STATE_KEY = "polaris_authing_state";
const RETURN_PATH_KEY = "polaris_authing_return_path";
const REDIRECT_URI_KEY = "polaris_authing_redirect_uri";

export interface AuthingConfig {
  authMode: ShellSession["authMode"];
  vaultMode?: ShellSession["vaultMode"];
  appId?: string;
  authorizationUrl?: string;
  redirectUri?: string;
  logoutUrl?: string;
  logoutRedirectUri?: string;
  paseoAppBaseUrl?: string;
  signInUrl?: string;
  signOutUrl?: string;
}

export interface PortalCredential {
  id: string;
  label: string;
  kind: string;
  status: string;
  paths: string[];
}

export interface PortalUserResponse {
  profile: { id: string; name?: string; email?: string };
  session: ShellSession & { userId: string; authingPhoneNumber?: string | null };
  credentials: PortalCredential[];
}

export interface PortalCredentialRecord {
  credential: { id: string; label: string };
  files: Array<{ key: string; sourcePath: string; content: string }>;
}

export interface PortalRequestError extends Error {
  status: number;
  code?: string;
}

function cookieValue(key: string): string | null {
  const entry = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${key}=`));
  return entry ? decodeURIComponent(entry.slice(key.length + 1).trim()) || null : null;
}

function cookieAttributes(): string {
  return `path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
}

function setCookie(key: string, value: string): void {
  document.cookie = `${key}=${encodeURIComponent(value)}; ${cookieAttributes()}`;
}

function clearCookie(key: string): void {
  document.cookie = `${key}=; Max-Age=0; ${cookieAttributes()}`;
}

function token(): string | null {
  const value = sessionStorage.getItem(SESSION_TOKEN_KEY)?.trim() || cookieValue(SESSION_TOKEN_KEY)?.trim();
  return value ? value.replace(/^Bearer\s+/iu, "") : null;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const authToken = token();
  if (authToken && !headers.has("authorization")) headers.set("authorization", `Bearer ${authToken}`);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, { ...init, headers, credentials: "same-origin" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const bodyError = typeof body.error === "object" && body.error !== null ? body.error : null;
    const message = typeof body.error === "string" ? body.error : bodyError?.message;
    const code = typeof body.errorCode === "string" ? body.errorCode : bodyError?.code;
    const error: PortalRequestError = typeof message === "string"
      ? Object.assign(new Error(message), { status: response.status, ...(code ? { code } : {}) })
      : Object.assign(
        localizedError("common.requestFailed", { status: response.status }),
        { status: response.status },
      );
    throw error;
  }
  return body as T;
}

export function isRequestError(value: unknown): value is PortalRequestError {
  return value instanceof Error && typeof (value as Partial<PortalRequestError>).status === "number";
}

function transientValue(key: string): string | null {
  try {
    return sessionStorage.getItem(key)?.trim() || localStorage.getItem(key)?.trim() || cookieValue(key);
  } catch {
    return cookieValue(key);
  }
}

function setTransientValue(key: string, value: string): void {
  sessionStorage.setItem(key, value);
  localStorage.setItem(key, value);
  setCookie(key, value);
}

function clearTransientValue(key: string): void {
  sessionStorage.removeItem(key);
  localStorage.removeItem(key);
  clearCookie(key);
}

function base64Url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

async function pkceChallenge(verifier: string): Promise<{ method: "S256" | "plain"; value: string }> {
  if (!globalThis.crypto?.subtle) return { method: "plain", value: verifier };
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return { method: "S256", value: base64Url(new Uint8Array(digest)) };
  } catch {
    return { method: "plain", value: verifier };
  }
}

export async function authingConfig(): Promise<AuthingConfig> {
  return request<AuthingConfig>("/authing-config");
}

export async function domainPacks(): Promise<{ packs: WorkflowDomainPackProjection[] }> {
  return request<{ packs: WorkflowDomainPackProjection[] }>("/domain-packs");
}

export type PortalToolFinding = {
  toolId: string;
  type: "env" | "command" | "python" | "file" | "lock" | "setup";
  key: string;
  kind: "required" | "recommended";
  reason: string;
  next?: string;
};

export type PortalToolStatus = {
  id: string;
  entrypoint: string;
  commands: string[];
  capabilities: string[];
  lockPath: string;
  checkSetupPath: string;
  readiness: "ready" | "warning" | "blocked";
  prerequisites: {
    env: Array<{ key: string; kind: "required" | "recommended"; reason: string }>;
    commands: Array<{ name: string; kind: "required" | "recommended"; reason: string }>;
    files: Array<{ path: string; kind: "required" | "recommended"; reason: string }>;
    python?: { minimum_version: string; requirements: string[] };
  };
  checkSetup: {
    ok: boolean;
    lines: string[];
  };
  missingRequired: PortalToolFinding[];
  missingRecommended: PortalToolFinding[];
};

export type PortalToolStatusReport = {
  ok: boolean;
  ready: number;
  warning: number;
  blocked: number;
  tools: PortalToolStatus[];
};

export async function portalTools(): Promise<PortalToolStatusReport> {
  return request<PortalToolStatusReport>("/tools");
}

export async function workflowGraph(
  packId: string,
  flowId: string,
): Promise<{ graph: WorkflowGraphProjection }> {
  return request<{ graph: WorkflowGraphProjection }>(
    `/domain-packs/${encodeURIComponent(packId)}/${encodeURIComponent(flowId)}/graph`,
  );
}

export async function workflowVaults(): Promise<{ vaults: WorkflowVaultProjection[] }> {
  return request<{ vaults: WorkflowVaultProjection[] }>("/workflow-vaults");
}

export async function workflowRuns(): Promise<WorkflowRunsResponse> {
  return request<WorkflowRunsResponse>("/workflow-runs");
}

export async function workflowSetup(): Promise<WorkflowSetupProjection> {
  return request<WorkflowSetupProjection>("/workflow-setup");
}

export async function saveWorkflowSetup(
  input: WorkflowSetupRequest,
): Promise<{ setup: WorkflowSetupProjection }> {
  return request<{ setup: WorkflowSetupProjection }>("/workflow-setup", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function workflowSuggestions(): Promise<{ suggestions: WorkflowSuggestionProjection[] }> {
  return request<{ suggestions: WorkflowSuggestionProjection[] }>("/workflow-suggestions");
}

export async function createWorkflowSuggestion(
  runId: string,
): Promise<{ suggestion: WorkflowSuggestionProjection }> {
  return request<{ suggestion: WorkflowSuggestionProjection }>("/workflow-suggestions", {
    method: "POST",
    body: JSON.stringify({ runId }),
  });
}

export async function createWorkflowRun(
  input: WorkflowRunRequest,
): Promise<{ run: WorkflowRunProjection }> {
  return request<{ run: WorkflowRunProjection }>("/workflow-runs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function workflowRunAction(
  runId: string,
  action: "approve" | "cancel" | "retry",
  scenario?: WorkflowMockScenario,
): Promise<{ run: WorkflowRunProjection }> {
  return request<{ run: WorkflowRunProjection }>(
    `/workflow-runs/${encodeURIComponent(runId)}/${action}`,
    {
      method: "POST",
      ...(scenario ? { body: JSON.stringify({ scenario }) } : {}),
    },
  );
}

export async function deleteWorkflowRun(runId: string): Promise<void> {
  await request<void>(`/workflow-runs/${encodeURIComponent(runId)}`, {
    method: "DELETE",
  });
}

export async function workflowRunEvents(
  runId: string,
  after = 0,
): Promise<WorkflowEventsResponse> {
  return request<WorkflowEventsResponse>(
    `/workflow-runs/${encodeURIComponent(runId)}/events?after=${after}`,
  );
}

export async function beginSignIn(config: AuthingConfig, returnPath: string): Promise<void> {
  setTransientValue(RETURN_PATH_KEY, returnPath);
  if (config.authMode === "disabled") {
    history.replaceState({}, "", "/work");
    dispatchEvent(new PopStateEvent("popstate"));
    return;
  }
  const redirectUri = config.redirectUri || `${location.origin}/auth/callback`;
  setTransientValue(REDIRECT_URI_KEY, redirectUri);
  if (config.authMode === "oauth2-proxy") {
    const url = new URL(config.signInUrl || "/oauth2/start", location.origin);
    url.searchParams.set("rd", redirectUri);
    location.assign(url.toString());
    return;
  }
  if (!config.appId || !config.authorizationUrl) throw localizedError("error.authConfigIncomplete");
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
  setTransientValue(PKCE_VERIFIER_KEY, verifier);
  setTransientValue(PKCE_STATE_KEY, state);
  const url = new URL(config.authorizationUrl);
  const challenge = await pkceChallenge(verifier);
  url.search = new URLSearchParams({
    client_id: config.appId,
    response_type: "code",
    scope: "openid profile email username phone",
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge.value,
    code_challenge_method: challenge.method,
  }).toString();
  location.assign(url.toString());
}

export async function completeSignIn(): Promise<string> {
  const config = await authingConfig();
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (config.authMode === "oauth2-proxy" && !code) return transientValue(RETURN_PATH_KEY) || "/work";
  const verifier = transientValue(PKCE_VERIFIER_KEY);
  const state = transientValue(PKCE_STATE_KEY);
  if (!code || !verifier || params.get("state") !== state) throw localizedError("error.signInInvalid");
  const result = await request<{ token?: string; idToken?: string }>("/auth/callback", {
    method: "POST",
    body: JSON.stringify({
      code,
      codeVerifier: verifier,
      redirectUri: transientValue(REDIRECT_URI_KEY) || `${location.origin}/auth/callback`,
    }),
  });
  if (!result.token?.trim()) throw localizedError("error.signInInvalid");
  sessionStorage.setItem(SESSION_TOKEN_KEY, result.token.trim());
  setCookie(SESSION_TOKEN_KEY, result.token.trim());
  if (result.idToken?.trim()) {
    sessionStorage.setItem(ID_TOKEN_KEY, result.idToken.trim());
    setCookie(ID_TOKEN_KEY, result.idToken.trim());
  }
  for (const key of [PKCE_VERIFIER_KEY, PKCE_STATE_KEY, REDIRECT_URI_KEY]) clearTransientValue(key);
  const returnPath = transientValue(RETURN_PATH_KEY) || "/work";
  clearTransientValue(RETURN_PATH_KEY);
  return returnPath;
}

export async function ensureCurrentUser(session: ShellSession): Promise<void> {
  const userProfileId = session.authingUsername?.trim();
  if (!userProfileId) throw localizedError("error.userIncomplete");
  await request("/users", {
    method: "POST",
    body: JSON.stringify({ userProfileId, authingUsername: session.authingUsername, authingUserId: session.authingUserId }),
  });
}

export async function logout(): Promise<void> {
  const config = await authingConfig().catch(() => null);
  const idToken = sessionStorage.getItem(ID_TOKEN_KEY)?.trim() || cookieValue(ID_TOKEN_KEY)?.trim();
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  sessionStorage.removeItem(ID_TOKEN_KEY);
  clearCookie(SESSION_TOKEN_KEY);
  clearCookie(ID_TOKEN_KEY);
  if (config?.authMode === "oauth2-proxy") {
    const url = new URL(config.signOutUrl || "/oauth2/sign_out", location.origin);
    url.searchParams.set("rd", "/welcome");
    location.replace(url.toString());
    return;
  }
  if (config?.logoutUrl) {
    const url = new URL(config.logoutUrl);
    if (idToken) url.searchParams.set("id_token_hint", idToken);
    url.searchParams.set("post_logout_redirect_uri", config.logoutRedirectUri || `${location.origin}/welcome`);
    location.replace(url.toString());
    return;
  }
  history.replaceState({}, "", "/welcome");
  dispatchEvent(new PopStateEvent("popstate"));
}

export function resolvePaseoUrl(path: string, reconnectTarget?: string | null): Promise<string> {
  return authingConfig().then((config) => resolveCodingSurfaceUrl({
    href: path,
    paseoAppBaseUrl: config.paseoAppBaseUrl,
    currentOrigin: location.origin,
    reconnectTarget,
  }));
}

export function streamUrl(userId: string): string {
  return `/api/users/${encodeURIComponent(userId)}/vaults/live`;
}

export type { ShellHostSummary, ShellSession };
