import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import yaml from "js-yaml";
import {
  createManagedHarnessCredential,
  resolveActiveManagedCredential,
  type ManagedCredentialSummary,
} from "../config/credentials.js";
import { polarisUsersRoot } from "../utils/paths.js";

const USER_ROOT = polarisUsersRoot(import.meta.url);

function defaultTopUpAmount(): number {
  return Number(process.env.POLARIS_AI_ACCESS_TOP_UP_AMOUNT ?? "25");
}

function defaultReferralSignUpUrl(): string {
  return process.env.VITE_AUTHING_SIGN_UP_URL?.trim()
    || process.env.POLARIS_PUBLIC_BASE_URL?.trim()
    || process.env.POLARIS_AI_ACCESS_REFERRAL_BASE_URL?.trim()
    || "http://127.0.0.1:8081/sign-up";
}

function defaultAfterSignUpUrl(): string {
  return process.env.POLARIS_PUBLIC_BASE_URL?.trim()
    || "http://127.0.0.1:8081";
}

function defaultProviderBackend(): string {
  return process.env.POLARIS_AI_ACCESS_PROVIDER_BACKEND?.trim()
    || "local";
}

function newApiBaseUrl(): string {
  return process.env.POLARIS_AI_ACCESS_NEW_API_BASE_URL?.trim()
    || "http://127.0.0.1:3000";
}

function newApiAdminUsername(): string {
  return process.env.POLARIS_AI_ACCESS_NEW_API_ADMIN_USERNAME?.trim()
    || "polarisroot";
}

function newApiAdminPassword(): string {
  return process.env.POLARIS_AI_ACCESS_NEW_API_ADMIN_PASSWORD?.trim()
    || "Polaris123";
}

function newApiTopUpQuota(): number {
  return Number(process.env.POLARIS_AI_ACCESS_NEW_API_TOP_UP_QUOTA ?? "500000");
}

function newApiRuntimeBaseUrl(): string {
  return process.env.POLARIS_AI_ACCESS_NEW_API_RUNTIME_BASE_URL?.trim()
    || process.env.POLARIS_AI_ACCESS_NEW_API_PUBLIC_BASE_URL?.trim()
    || newApiBaseUrl();
}

export type PortalAiAccessState =
  | "not_provisioned"
  | "funding_needed"
  | "ready"
  | "error";

export type PortalAiAccessActionKind =
  | "provision_access"
  | "top_up"
  | "refresh_status"
  | "retry";

export interface PortalAiAccessAction {
  kind: PortalAiAccessActionKind;
  enabled: boolean;
  reason?: string;
}

export interface PortalAiAccessCapabilities {
  provisionAccess: boolean;
  topUp: boolean;
  referral: boolean;
  subscription: boolean;
}

export interface PortalAiAccessTopUpMethod {
  id: string;
  label: string;
  kind: "epay" | "waffo" | "waffo-pancake" | "creem";
  minAmount: number;
  fixedAmount: number | null;
}

export interface PortalAiAccessTopUpInfo {
  currencySymbol: string;
  amountOptions: number[];
  methods: PortalAiAccessTopUpMethod[];
}

export interface PortalAiAccessTopUpSession {
  redirectUrl: string;
}


export interface PortalAiAccessProviderFacts {
  providerBackend: string;
  accountLinked: boolean;
  provisioned: boolean;
  billingMode: "payg" | "monthly" | "hybrid" | "unknown";
  balanceAmount: number | null;
  balanceUnit: string | null;
  referralEnabled: boolean;
  inviteCode: string | null;
  inviteLink: string | null;
  rebateSummary: string | null;
  providerAccountId: string | null;
  providerTokenPresent: boolean;
  providerToken: string | null;
  lastTopupAt: string | null;
  lastSyncAt: string | null;
  healthy: boolean;
  errorMessage: string | null;
  capabilities: PortalAiAccessCapabilities;
}

export interface PortalAiAccessView {
  state: PortalAiAccessState;
  summary: {
    accessState: PortalAiAccessState;
    billingMode: "payg" | "monthly" | "hybrid" | "unknown";
    availableBalance: number | null;
    balanceUnit: string | null;
    referralState: "unavailable" | "enabled" | "disabled" | "error";
  };
  mainAction: {
    headline: string;
    description: string;
    primaryAction: PortalAiAccessAction;
    secondaryAction?: PortalAiAccessAction;
    stateReason?: string;
  };
  accessStatus: {
    provisioningStatus: "not-provisioned" | "provisioned";
    accountLinked: boolean;
    runtimeReady: boolean;
    lastSyncAt: string | null;
    statusMessage: string | null;
  };
  billing: {
    billingMode: "payg" | "monthly" | "hybrid" | "unknown";
    subscriptionStatus: "none" | "active" | "paused" | "expired" | "unknown";
    subscriptionName: string | null;
    balanceAmount: number | null;
    balanceUnit: string | null;
    lastTopupAt: string | null;
  };
  referral: {
    referralEnabled: boolean;
    inviteCode: string | null;
    inviteLink: string | null;
    rebateSummary: string | null;
  };
  advanced: {
    providerBackend: string;
    providerAccountId: string | null;
    providerTokenPresent: boolean;
    credentialSyncStatus: "idle" | "ready" | "error";
    defaultCredentialId: string | null;
    lastInternalSyncAt: string | null;
    lastErrorMessage: string | null;
  };
  capabilities: PortalAiAccessCapabilities;
}

interface PersistedAiAccessState {
  version: 1;
  providerBackend: string;
  provisionedAt?: string;
  providerAccountId?: string;
  providerUsername?: string;
  providerPassword?: string;
  providerToken?: string;
  billingMode: "payg";
  balanceAmount: number;
  balanceUnit: string;
  lastTopupAt?: string;
  referralEnabled: boolean;
  inviteCode: string;
  inviteLink: string;
  rebateSummary?: string;
  lastSyncAt?: string;
  lastReadyAt?: string;
  lastErrorMessage?: string;
  simulateSetupFailure?: boolean;
}

interface RuntimeReadiness {
  runtimeReady: boolean;
  credentialId: string | null;
  credentialSyncStatus: "idle" | "ready" | "error";
  lastInternalSyncAt: string | null;
  lastErrorMessage: string | null;
}

interface PortalAiAccessProviderAdapter {
  readFacts(userId: string): Promise<PortalAiAccessProviderFacts>;
  provision(userId: string): Promise<PortalAiAccessProviderFacts>;
  topUp(userId: string): Promise<PortalAiAccessProviderFacts>;
  refresh(userId: string): Promise<PortalAiAccessProviderFacts>;
  retry(userId: string): Promise<PortalAiAccessProviderFacts>;
}

function aiAccessStatePath(userId: string): string {
  return path.join(USER_ROOT, userId, "ai-access", "state.json");
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildInviteCode(userId: string): string {
  return `${userId.slice(0, 6).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

function buildInviteLink(code: string): string {
  const signUpUrl = defaultReferralSignUpUrl();
  const redirectUrl = new URL(trimTrailingSlash(defaultAfterSignUpUrl()) || "/", defaultAfterSignUpUrl());
  redirectUrl.searchParams.set("invite", code);
  try {
    const url = new URL(signUpUrl);
    url.searchParams.set("invite", code);
    url.searchParams.set("redirect_url", redirectUrl.toString());
    return url.toString();
  } catch {
    const separator = signUpUrl.includes("?") ? "&" : "?";
    return `${trimTrailingSlash(signUpUrl)}${separator}invite=${encodeURIComponent(code)}&redirect_url=${encodeURIComponent(redirectUrl.toString())}`;
  }
}

function buildProviderAccountId(userId: string): string {
  return `${defaultProviderBackend()}-${userId}`;
}

function buildProviderToken(): string {
  return `plrs_${crypto.randomBytes(12).toString("hex")}`;
}

function newApiCodexBaseUrl(): string {
  const trimmed = trimTrailingSlash(newApiRuntimeBaseUrl());
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function readPersistedState(userId: string): PersistedAiAccessState | null {
  return readJsonFile<PersistedAiAccessState>(aiAccessStatePath(userId));
}

function writePersistedState(userId: string, value: PersistedAiAccessState): void {
  writeJsonFile(aiAccessStatePath(userId), value);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseJsonResponse<T>(raw: unknown): T {
  return raw as T;
}

type NewApiEnvelope<T> = {
  success?: boolean;
  message?: string;
  data?: T;
  url?: string;
};

type NewApiSession = {
  cookieHeader: string;
  id: number;
  username: string;
};

type NewApiManagedUser = {
  id: number;
  username: string;
  display_name?: string;
  status?: number;
};

type NewApiCachedAuth = {
  userId: number;
  username: string;
  accessToken: string;
  expiresAt: number;
};

type NewApiTopUpInfoResponse = {
  enable_online_topup?: boolean;
  enable_stripe_topup?: boolean;
  enable_creem_topup?: boolean;
  enable_waffo_topup?: boolean;
  enable_waffo_pancake_topup?: boolean;
  min_topup?: number;
  stripe_min_topup?: number;
  waffo_min_topup?: number;
  waffo_pancake_min_topup?: number;
  amount_options?: number[];
  pay_methods?: Array<{
    name?: string;
    type?: string;
    min_topup?: string | number;
  }>;
  waffo_pay_methods?: Array<{
    name?: string;
  }>;
  creem_products?: Array<{
    name?: string;
    productId?: string;
    price?: number;
  }>;
};

let cachedNewApiAdminAuth: NewApiCachedAuth | null = null;


function normalizeNewApiTopUpQuota(): number {
  const value = newApiTopUpQuota();
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return 1;
}

function convertNewApiQuotaToDisplayAmount(quota: number): number {
  return quota / normalizeNewApiTopUpQuota();
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  if (Number.isFinite(numberValue) && numberValue > 0) {
    return numberValue;
  }
  return fallback;
}

async function newApiRequest<T>(
  pathname: string,
  input?: {
    method?: "GET" | "POST";
    body?: unknown;
    cookieHeader?: string;
    accessToken?: string;
    userIdHeader?: number;
  },
): Promise<T> {
  const response = await fetch(`${trimTrailingSlash(newApiBaseUrl())}${pathname}`, {
    method: input?.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(input?.cookieHeader ? { cookie: input.cookieHeader } : {}),
      ...(input?.accessToken ? { authorization: `Bearer ${input.accessToken}` } : {}),
      ...(typeof input?.userIdHeader === "number"
        ? { "New-Api-User": String(input.userIdHeader) }
        : {}),
    },
    ...(input?.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  const raw = await response.json().catch(() => ({}));
  const parsed = parseJsonResponse<NewApiEnvelope<T>>(raw);
  const businessSuccess = parsed.success === true || parsed.message === "success";
  const businessFailure = parsed.success === false || parsed.message === "error";
  if (!response.ok) {
    throw new Error(
      `${parsed.message?.trim() || "new-api request failed"} `
      + `(${response.status}) for ${pathname}`,
    );
  }
  if (businessFailure) {
    const detail =
      typeof parsed.data === "string"
        ? parsed.data
        : parsed.message?.trim() || `new-api business error for ${pathname}`;
    throw new Error(detail);
  }
  if (!businessSuccess && typeof parsed.data === "undefined") {
    throw new Error(parsed.message?.trim() || `new-api business error for ${pathname}`);
  }
  if (typeof parsed.url === "string" && parsed.url.trim()) {
    return {
      ...(typeof parsed.data === "object" && parsed.data ? parsed.data as Record<string, unknown> : {}),
      url: parsed.url,
    } as T;
  }
  return parsed.data as T;
}

async function newApiEnsureSetup(): Promise<void> {
  const setup = await newApiRequest<{ status: boolean; root_init?: boolean }>(
    "/api/setup",
  );
  if (setup.status) {
    return;
  }
  if (setup.root_init) {
    return;
  }
  await newApiRequest<unknown>("/api/setup", {
    method: "POST",
    body: {
      username: newApiAdminUsername(),
      password: newApiAdminPassword(),
      confirmPassword: newApiAdminPassword(),
      SelfUseModeEnabled: false,
      DemoSiteEnabled: false,
    },
  });
}

async function newApiLogin(username: string, password: string): Promise<NewApiSession> {
  const response = await fetch(`${trimTrailingSlash(newApiBaseUrl())}/api/user/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ username, password }),
  });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`new-api login failed (${response.status})`);
  }
  const parsed = parseJsonResponse<NewApiEnvelope<{
    id: number;
    username: string;
  }>>(raw);
  if (!parsed.success || !parsed.data) {
    throw new Error(parsed.message?.trim() || "new-api login rejected");
  }
  const setCookies = response.headers.getSetCookie?.() ?? [];
  const cookieHeader = setCookies
    .map((cookie) => cookie.split(";", 1)[0]?.trim())
    .filter(Boolean)
    .join("; ");
  return {
    cookieHeader,
    id: parsed.data.id,
    username: parsed.data.username,
  };
}

async function newApiGenerateAccessToken(session: NewApiSession): Promise<string> {
  return newApiRequest<string>("/api/user/token", {
    cookieHeader: session.cookieHeader,
    userIdHeader: session.id,
  });
}

function isAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /401|Unauthorized|access token invalid|user id mismatch|not logged in|Authentication is required/i.test(message);
}

function buildNewApiUsername(userId: string): string {
  const digest = crypto.createHash("sha1").update(userId).digest("hex").slice(0, 10);
  return `p${digest}`;
}

function buildNewApiPassword(userId: string): string {
  const digest = crypto.createHash("sha1").update(`pwd:${userId}`).digest("hex").slice(0, 12);
  return `Pol${digest}`;
}

async function newApiAdminSession(): Promise<NewApiSession> {
  await newApiEnsureSetup();
  return newApiLogin(newApiAdminUsername(), newApiAdminPassword());
}

async function newApiAdminAuth(forceRefresh = false): Promise<NewApiCachedAuth> {
  const now = Date.now();
  if (!forceRefresh && cachedNewApiAdminAuth && cachedNewApiAdminAuth.expiresAt > now) {
    return cachedNewApiAdminAuth;
  }
  const session = await newApiAdminSession();
  const accessToken = await newApiGenerateAccessToken(session);
  const next: NewApiCachedAuth = {
    userId: session.id,
    username: session.username,
    accessToken,
    expiresAt: now + 10 * 60 * 1000,
  };
  cachedNewApiAdminAuth = next;
  return next;
}

async function withNewApiAdminAccess<T>(
  task: (auth: NewApiCachedAuth) => Promise<T>,
): Promise<T> {
  const auth = await newApiAdminAuth(false);
  try {
    return await task(auth);
  } catch (error) {
    if (!isAuthFailure(error)) {
      throw error;
    }
    const refreshed = await newApiAdminAuth(true);
    return task(refreshed);
  }
}

async function newApiCreateUserIfMissing(
  userId: string,
  state: PersistedAiAccessState,
): Promise<{
  providerUserId: number;
  username: string;
  password: string;
  providerToken: string;
}> {
  const username = state.providerUsername?.trim() || buildNewApiUsername(userId);
  const password = state.providerPassword?.trim() || buildNewApiPassword(userId);
  const referralContext = readProfileReferralContext(userId);
  const inviterAffCode = !referralContext.aiAccessReferralAppliedAt
    ? referralContext.referredByCode?.trim() || ""
    : "";

  if (inviterAffCode) {
    try {
      await newApiRequest<unknown>("/api/user/register", {
        method: "POST",
        body: {
          username,
          password,
          email: `${username}@polaris.local`,
          aff_code: inviterAffCode,
        },
      });
      markProfileReferralApplied(userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already|已存在|duplicate|exists/i.test(message)) {
        throw error;
      }
    }
  } else {
    try {
      await withNewApiAdminAccess(async (admin) => {
        await newApiRequest<unknown>("/api/user/", {
          method: "POST",
          accessToken: admin.accessToken,
          userIdHeader: admin.userId,
          body: {
            username,
            password,
            display_name: userId.slice(0, 20),
            role: 1,
          },
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already|已存在|duplicate/i.test(message)) {
        throw error;
      }
    }
  }

  const session = await newApiLogin(username, password);
  const providerToken = await newApiGenerateAccessToken(session);
  return {
    providerUserId: session.id,
    username,
    password,
    providerToken,
  };
}

function profilePath(userId: string): string {
  return path.join(USER_ROOT, "profiles", `${userId}.yaml`);
}

function readProfileReferralContext(userId: string): {
  referredByCode: string | null;
  aiAccessReferralAppliedAt: string | null;
} {
  const filePath = profilePath(userId);
  if (!fs.existsSync(filePath)) {
    return {
      referredByCode: null,
      aiAccessReferralAppliedAt: null,
    };
  }
  const raw = (yaml.load(fs.readFileSync(filePath, "utf8")) ?? {}) as Record<string, unknown>;
  const referral = typeof raw.referral === "object" && raw.referral
    ? raw.referral as Record<string, unknown>
    : {};
  return {
    referredByCode: String(referral.referred_by_code ?? "").trim() || null,
    aiAccessReferralAppliedAt: String(referral.ai_access_applied_at ?? "").trim() || null,
  };
}

function markProfileReferralApplied(userId: string): void {
  const filePath = profilePath(userId);
  if (!fs.existsSync(filePath)) {
    return;
  }
  const raw = yaml.load(fs.readFileSync(filePath, "utf8")) as Record<string, unknown> | null;
  const next = raw && typeof raw === "object" ? { ...raw } : {};
  const referral = typeof next.referral === "object" && next.referral
    ? { ...(next.referral as Record<string, unknown>) }
    : {};
  referral.ai_access_applied_at = new Date().toISOString();
  next.referral = referral;
  fs.writeFileSync(filePath, yaml.dump(next, { lineWidth: 120, noRefs: true }), "utf8");
}

async function newApiAddQuota(
  providerUserId: number,
  value: number,
): Promise<void> {
  await withNewApiAdminAccess(async (admin) => {
    await newApiRequest<unknown>("/api/user/manage", {
      method: "POST",
      accessToken: admin.accessToken,
      userIdHeader: admin.userId,
      body: {
        id: providerUserId,
        action: "add_quota",
        value,
        mode: "add",
      },
    });
  });
}

async function newApiGetManagedUser(
  providerUserId: number,
): Promise<NewApiManagedUser> {
  return withNewApiAdminAccess((admin) => newApiRequest<NewApiManagedUser>(
    `/api/user/${providerUserId}`,
    {
      accessToken: admin.accessToken,
      userIdHeader: admin.userId,
    },
  ));
}

async function newApiReadSelfWithToken(
  providerToken: string,
  providerUserId: number,
): Promise<{
  id: number;
  quota: number;
  aff_code?: string;
  aff_quota?: number;
  aff_history_quota?: number;
}> {
  return newApiRequest<{
    id: number;
    quota: number;
    aff_code?: string;
    aff_quota?: number;
    aff_history_quota?: number;
  }>("/api/user/self", {
    accessToken: providerToken,
    userIdHeader: providerUserId,
  });
}

async function newApiReadAffCodeWithToken(
  providerToken: string,
  providerUserId: number,
): Promise<string> {
  return newApiRequest<string>("/api/user/aff", {
    accessToken: providerToken,
    userIdHeader: providerUserId,
  });
}

async function newApiProvisionedToken(
  userId: string,
): Promise<{
  state: PersistedAiAccessState;
  providerUserId: number;
  providerToken: string;
}> {
  const normalizedState = normalizeNewApiState(userId, readPersistedState(userId));
  if (!normalizedState?.provisionedAt || !normalizedState.providerAccountId) {
    throw new Error("AI access is not provisioned yet");
  }
  const providerUserId = Number(normalizedState.providerAccountId);
  if (!Number.isFinite(providerUserId) || providerUserId <= 0) {
    throw new Error("AI access provider user id is missing");
  }
  let providerToken = normalizedState.providerToken?.trim() || "";
  if (!providerToken) {
    const refreshed = await newApiReadFacts(userId, normalizedState);
    const nextState = readPersistedState(userId);
    providerToken = nextState?.providerToken?.trim() || "";
    if (!providerToken) {
      throw new Error(
        refreshed.errorMessage || "AI access provider token is unavailable",
      );
    }
    return {
      state: nextState as PersistedAiAccessState,
      providerUserId,
      providerToken,
    };
  }
  return {
    state: normalizedState,
    providerUserId,
    providerToken,
  };
}

function buildNewApiTopUpMethods(
  payload: NewApiTopUpInfoResponse,
): PortalAiAccessTopUpMethod[] {
  const methods: PortalAiAccessTopUpMethod[] = [];
  for (const method of payload.pay_methods ?? []) {
    const type = method.type?.trim();
    if (!type) {
      continue;
    }
    methods.push({
      id: `epay:${type}`,
      label: method.name?.trim() || type,
      kind: "epay",
      minAmount: normalizePositiveNumber(method.min_topup, payload.min_topup ?? 1),
      fixedAmount: null,
    });
  }
  (payload.waffo_pay_methods ?? []).forEach((method, index) => {
    methods.push({
      id: `waffo:${index}`,
      label: method.name?.trim() || `Waffo ${index + 1}`,
      kind: "waffo",
      minAmount: normalizePositiveNumber(payload.waffo_min_topup, 1),
      fixedAmount: null,
    });
  });
  if (payload.enable_waffo_pancake_topup) {
    methods.push({
      id: "waffo-pancake",
      label: "Waffo Pancake",
      kind: "waffo-pancake",
      minAmount: normalizePositiveNumber(payload.waffo_pancake_min_topup, 1),
      fixedAmount: null,
    });
  }
  for (const product of payload.creem_products ?? []) {
    if (!product.productId) {
      continue;
    }
    const fixedAmount = normalizePositiveNumber(product.price, 0);
    methods.push({
      id: `creem:${product.productId}`,
      label: product.name?.trim() || `Creem ${product.productId}`,
      kind: "creem",
      minAmount: fixedAmount,
      fixedAmount,
    });
  }
  return methods;
}

function extractPaymentRedirectUrl(raw: unknown): string {
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("Payment session did not return a redirect URL");
  }
  const record = raw as Record<string, unknown>;
  const url =
    record.url
    ?? record.pay_link
    ?? record.checkout_url
    ?? record.payment_url;
  if (typeof url === "string" && url.trim()) {
    return url.trim();
  }
  throw new Error("Payment session did not return a redirect URL");
}

function isMissingProviderUserError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|用户不存在|record not found|no rows|不存在/i.test(message);
}

function resetProvisionedState(
  userId: string,
  state: PersistedAiAccessState,
  reason: string,
): PersistedAiAccessState {
  const next: PersistedAiAccessState = {
    ...state,
    version: 1,
    providerBackend: "new-api",
    provisionedAt: undefined,
    providerAccountId: undefined,
    providerUsername: undefined,
    providerPassword: undefined,
    providerToken: undefined,
    balanceAmount: 0,
    balanceUnit: "quota",
    lastTopupAt: undefined,
    lastSyncAt: new Date().toISOString(),
    lastErrorMessage: reason,
  };
  writePersistedState(userId, next);
  return next;
}

function normalizeNewApiState(
  userId: string,
  state: PersistedAiAccessState | null,
): PersistedAiAccessState | null {
  if (!state) {
    return null;
  }
  if (state.providerBackend === "new-api" && (!state.provisionedAt || (state.providerUsername && state.providerPassword))) {
    return state;
  }
  return resetProvisionedState(
    userId,
    state,
    "Stored AI Access state came from the legacy local provider. Re-provision against new-api.",
  );
}

async function newApiReadFacts(
  userId: string,
  state: PersistedAiAccessState | null,
): Promise<PortalAiAccessProviderFacts> {
  const normalizedState = normalizeNewApiState(userId, state);
  if (!normalizedState?.provisionedAt || !normalizedState.providerUsername || !normalizedState.providerPassword) {
    return stateToFacts(normalizedState);
  }

  try {
    let providerUserId = Number(normalizedState.providerAccountId ?? 0);
    let providerUsername = normalizedState.providerUsername;

    if (providerUserId > 0) {
      try {
        const managedUser = await newApiGetManagedUser(providerUserId);
        providerUserId = managedUser.id;
        providerUsername = managedUser.username || providerUsername;
      } catch (error) {
        if (isMissingProviderUserError(error)) {
          return stateToFacts(resetProvisionedState(
            userId,
            normalizedState,
            "Provider user no longer exists. Re-provision AI access.",
          ));
        }
        throw error;
      }
    }

    let effectiveProviderUserId = providerUserId;
    let providerToken = normalizedState.providerToken?.trim() || "";
    let self: {
      id: number;
      quota: number;
      aff_code?: string;
      aff_quota?: number;
      aff_history_quota?: number;
    } | null = null;
    let affCode = "";

    if (providerToken && effectiveProviderUserId > 0) {
      try {
        self = await newApiReadSelfWithToken(providerToken, effectiveProviderUserId);
        const currentSelf = self;
        affCode = await newApiReadAffCodeWithToken(providerToken, effectiveProviderUserId)
          .catch(() => currentSelf.aff_code ?? "");
      } catch (error) {
        if (!isAuthFailure(error)) {
          throw error;
        }
        providerToken = "";
      }
    }

    if (!providerToken) {
      const session = await newApiLogin(providerUsername, normalizedState.providerPassword);
      providerToken = await newApiGenerateAccessToken(session);
      effectiveProviderUserId = session.id;
      self = await newApiReadSelfWithToken(providerToken, effectiveProviderUserId);
      const currentSelf = self;
      affCode = await newApiReadAffCodeWithToken(providerToken, effectiveProviderUserId)
        .catch(() => currentSelf.aff_code ?? "");
    }

    if (!self) {
      throw new Error("Failed to read provider user state from new-api");
    }

    const nextState: PersistedAiAccessState = {
      ...(normalizedState ?? defaultPersistedState(userId)),
      version: 1,
      providerBackend: "new-api",
      provisionedAt: normalizedState.provisionedAt,
      providerAccountId: String(self.id),
      providerUsername,
      providerPassword: normalizedState.providerPassword,
      providerToken,
      billingMode: "payg",
      balanceAmount: convertNewApiQuotaToDisplayAmount(Number(self.quota ?? 0)),
      balanceUnit: "$",
      referralEnabled: true,
      inviteCode: affCode || self.aff_code || "",
      inviteLink: buildInviteLink(affCode || self.aff_code || ""),
      rebateSummary: `${Number(self.aff_quota ?? 0)} quota available`,
      lastTopupAt: normalizedState.lastTopupAt,
      lastSyncAt: new Date().toISOString(),
      lastErrorMessage: undefined,
    };
    writePersistedState(userId, nextState);
    return stateToFacts(nextState);
  } catch (error) {
    const lastErrorMessage = error instanceof Error ? error.message : String(error);
    if (normalizedState) {
      writePersistedState(userId, {
        ...normalizedState,
        lastErrorMessage,
      });
    }
    return {
      ...stateToFacts(normalizedState),
      providerBackend: "new-api",
      healthy: false,
      errorMessage: lastErrorMessage,
    };
  }
}

function defaultPersistedState(userId: string): PersistedAiAccessState {
  const inviteCode = buildInviteCode(userId);
  return {
    version: 1,
    providerBackend: defaultProviderBackend(),
    billingMode: "payg",
    balanceAmount: 0,
    balanceUnit: "credits",
    referralEnabled: true,
    inviteCode,
    inviteLink: buildInviteLink(inviteCode),
    rebateSummary: "0 credits earned",
  };
}

function stateToFacts(state: PersistedAiAccessState | null): PortalAiAccessProviderFacts {
  return {
    providerBackend: state?.providerBackend ?? defaultProviderBackend(),
    accountLinked: Boolean(state?.providerAccountId),
    provisioned: Boolean(state?.provisionedAt),
    billingMode: state?.billingMode ?? "payg",
    balanceAmount: state?.balanceAmount ?? null,
    balanceUnit: state?.balanceUnit ?? "credits",
    referralEnabled: state?.referralEnabled ?? false,
    inviteCode: state?.inviteCode ?? null,
    inviteLink: state?.inviteLink ?? null,
    rebateSummary: state?.rebateSummary ?? null,
    providerAccountId: state?.providerAccountId ?? null,
    providerTokenPresent: Boolean(state?.providerToken),
    providerToken: state?.providerToken ?? null,
    lastTopupAt: state?.lastTopupAt ?? null,
    lastSyncAt: state?.lastSyncAt ?? null,
    healthy: !state?.lastErrorMessage,
    errorMessage: state?.lastErrorMessage ?? null,
    capabilities: {
      provisionAccess: true,
      topUp: true,
      referral: true,
      subscription: false,
    },
  };
}


function hasUsableFunding(facts: PortalAiAccessProviderFacts): boolean {
  return typeof facts.balanceAmount === "number" && facts.balanceAmount > 0;
}

async function ensureRuntimeReadiness(
  userId: string,
  facts: PortalAiAccessProviderFacts,
): Promise<RuntimeReadiness> {
  if (!facts.provisioned || !hasUsableFunding(facts)) {
    return {
      runtimeReady: false,
      credentialId: null,
      credentialSyncStatus: "idle",
      lastInternalSyncAt: facts.lastSyncAt,
      lastErrorMessage: null,
    };
  }

  const persisted = readPersistedState(userId);
  if (persisted?.simulateSetupFailure) {
    const lastInternalSyncAt = new Date().toISOString();
    const lastErrorMessage = "Simulated AI Access runtime setup failure";
    writePersistedState(userId, {
      ...(persisted ?? defaultPersistedState(userId)),
      provisionedAt: persisted?.provisionedAt ?? new Date().toISOString(),
      providerAccountId: persisted?.providerAccountId ?? buildProviderAccountId(userId),
      providerToken: persisted?.providerToken ?? buildProviderToken(),
      lastSyncAt: lastInternalSyncAt,
      lastErrorMessage,
    });
    return {
      runtimeReady: false,
      credentialId: null,
      credentialSyncStatus: "error",
      lastInternalSyncAt,
      lastErrorMessage,
    };
  }

  const activeCredential = resolveActiveManagedCredential({
    userProfileId: userId,
    harness: "codex",
  });
  if (activeCredential) {
    const lastInternalSyncAt = new Date().toISOString();
    if (persisted) {
      writePersistedState(userId, {
        ...persisted,
        lastSyncAt: lastInternalSyncAt,
        lastReadyAt: lastInternalSyncAt,
        lastErrorMessage: undefined,
      });
    }
    return {
      runtimeReady: true,
      credentialId: activeCredential.id,
      credentialSyncStatus: "ready",
      lastInternalSyncAt,
      lastErrorMessage: null,
    };
  }

  try {
    const created = syncAiAccessDefaultCredential(userId, facts);
    const lastInternalSyncAt = new Date().toISOString();
    if (persisted) {
      writePersistedState(userId, {
        ...persisted,
        lastSyncAt: lastInternalSyncAt,
        lastReadyAt: lastInternalSyncAt,
        lastErrorMessage: undefined,
      });
    }
    return {
      runtimeReady: true,
      credentialId: created.id,
      credentialSyncStatus: "ready",
      lastInternalSyncAt,
      lastErrorMessage: null,
    };
  } catch (error) {
    const lastInternalSyncAt = new Date().toISOString();
    const lastErrorMessage = error instanceof Error ? error.message : String(error);
    if (persisted) {
      writePersistedState(userId, {
        ...persisted,
        lastSyncAt: lastInternalSyncAt,
        lastErrorMessage,
      });
    }
    return {
      runtimeReady: false,
      credentialId: null,
      credentialSyncStatus: "error",
      lastInternalSyncAt,
      lastErrorMessage,
    };
  }
}

function syncAiAccessDefaultCredential(
  userId: string,
  facts: PortalAiAccessProviderFacts,
): ManagedCredentialSummary & { created: boolean } {
  if (facts.providerBackend === "new-api") {
    return createManagedHarnessCredential({
      userProfileId: userId,
      harness: "codex",
      credentialId: "codex-new-api",
      label: "new-api",
      providerName: "openai",
      baseUrl: newApiCodexBaseUrl(),
      apiKey: facts.providerToken ?? "",
      activate: true,
      presetId: "openai",
    });
  }
  return createManagedHarnessCredential({
    userProfileId: userId,
    harness: "codex",
    credentialId: "ai-access-codex",
    label: "AI Access",
    providerName: "AI Access",
    ...(facts.providerToken ? { apiKey: facts.providerToken } : {}),
    activate: true,
  });
}

function buildMainAction(
  state: PortalAiAccessState,
): PortalAiAccessView["mainAction"] {
  if (state === "not_provisioned") {
    return {
      headline: "AI access is not provisioned",
      description: "Provision access before the user can fund or use AI features.",
      primaryAction: { kind: "provision_access", enabled: true },
      secondaryAction: { kind: "refresh_status", enabled: true },
    };
  }
  if (state === "funding_needed") {
    return {
      headline: "AI access needs funding",
      description: "Top up this user's balance to make AI access ready to use.",
      primaryAction: { kind: "top_up", enabled: true },
      secondaryAction: { kind: "refresh_status", enabled: true },
    };
  }
  if (state === "error") {
    return {
      headline: "AI access needs attention",
      description: "Automatic setup failed. Retry the background reconciliation.",
      primaryAction: { kind: "retry", enabled: true },
      secondaryAction: { kind: "refresh_status", enabled: true },
      stateReason: "Automatic runtime setup failed",
    };
  }
  return {
    headline: "AI access is ready",
    description: "The user can continue using AI access. Add funds when needed.",
    primaryAction: { kind: "top_up", enabled: true },
    secondaryAction: { kind: "refresh_status", enabled: true },
  };
}

function deriveState(
  facts: PortalAiAccessProviderFacts,
  runtime: RuntimeReadiness,
): PortalAiAccessState {
  if (!facts.provisioned) {
    return "not_provisioned";
  }
  if (!hasUsableFunding(facts)) {
    return "funding_needed";
  }
  if (!runtime.runtimeReady) {
    return "error";
  }
  return "ready";
}

function buildView(
  facts: PortalAiAccessProviderFacts,
  runtime: RuntimeReadiness,
): PortalAiAccessView {
  const state = deriveState(facts, runtime);
  return {
    state,
    summary: {
      accessState: state,
      billingMode: facts.billingMode,
      availableBalance: facts.balanceAmount,
      balanceUnit: facts.balanceUnit,
      referralState: !facts.capabilities.referral
        ? "unavailable"
        : facts.errorMessage
          ? "error"
          : facts.referralEnabled
            ? "enabled"
            : "disabled",
    },
    mainAction: buildMainAction(state),
    accessStatus: {
      provisioningStatus: facts.provisioned ? "provisioned" : "not-provisioned",
      accountLinked: facts.accountLinked,
      runtimeReady: runtime.runtimeReady,
      lastSyncAt: runtime.lastInternalSyncAt ?? facts.lastSyncAt,
      statusMessage: runtime.lastErrorMessage ?? facts.errorMessage,
    },
    billing: {
      billingMode: facts.billingMode,
      subscriptionStatus: "none",
      subscriptionName: null,
      balanceAmount: facts.balanceAmount,
      balanceUnit: facts.balanceUnit,
      lastTopupAt: facts.lastTopupAt,
    },
    referral: {
      referralEnabled: facts.referralEnabled,
      inviteCode: facts.inviteCode,
      inviteLink: facts.inviteLink,
      rebateSummary: facts.rebateSummary,
    },
    advanced: {
      providerBackend: facts.providerBackend,
      providerAccountId: facts.providerAccountId,
      providerTokenPresent: facts.providerTokenPresent,
      credentialSyncStatus: runtime.credentialSyncStatus,
      defaultCredentialId: runtime.credentialId,
      lastInternalSyncAt: runtime.lastInternalSyncAt,
      lastErrorMessage: runtime.lastErrorMessage ?? facts.errorMessage,
    },
    capabilities: facts.capabilities,
  };
}

const localProviderAdapter: PortalAiAccessProviderAdapter = {
  async readFacts(userId: string): Promise<PortalAiAccessProviderFacts> {
    return stateToFacts(readPersistedState(userId));
  },
  async provision(userId: string): Promise<PortalAiAccessProviderFacts> {
    const existing = readPersistedState(userId);
    if (existing?.provisionedAt) {
      return stateToFacts(existing);
    }
    const next: PersistedAiAccessState = {
      ...(existing ?? defaultPersistedState(userId)),
      version: 1,
    providerBackend: defaultProviderBackend(),
      provisionedAt: new Date().toISOString(),
      providerAccountId: existing?.providerAccountId ?? buildProviderAccountId(userId),
      providerToken: existing?.providerToken ?? buildProviderToken(),
      lastErrorMessage: undefined,
    };
    writePersistedState(userId, next);
    return stateToFacts(next);
  },
  async topUp(userId: string): Promise<PortalAiAccessProviderFacts> {
    const base = readPersistedState(userId) ?? defaultPersistedState(userId);
    const now = new Date().toISOString();
    const next: PersistedAiAccessState = {
      ...base,
      version: 1,
      providerBackend: base.providerBackend || defaultProviderBackend(),
      provisionedAt: base.provisionedAt ?? now,
      providerAccountId: base.providerAccountId ?? buildProviderAccountId(userId),
      providerToken: base.providerToken ?? buildProviderToken(),
      balanceAmount: base.balanceAmount + defaultTopUpAmount(),
      lastTopupAt: now,
      lastErrorMessage: undefined,
    };
    writePersistedState(userId, next);
    return stateToFacts(next);
  },
  async refresh(userId: string): Promise<PortalAiAccessProviderFacts> {
    return stateToFacts(readPersistedState(userId));
  },
  async retry(userId: string): Promise<PortalAiAccessProviderFacts> {
    const current = readPersistedState(userId);
    if (current) {
      writePersistedState(userId, {
        ...current,
        lastErrorMessage: undefined,
      });
    }
    return stateToFacts(readPersistedState(userId));
  },
};

const newApiProviderAdapter: PortalAiAccessProviderAdapter = {
  async readFacts(userId: string): Promise<PortalAiAccessProviderFacts> {
    return newApiReadFacts(userId, readPersistedState(userId));
  },
  async provision(userId: string): Promise<PortalAiAccessProviderFacts> {
    const current = normalizeNewApiState(userId, readPersistedState(userId))
      ?? defaultPersistedState(userId);
    const created = await newApiCreateUserIfMissing(userId, current);
    const next: PersistedAiAccessState = {
      ...current,
      version: 1,
      providerBackend: "new-api",
      provisionedAt: current.provisionedAt ?? new Date().toISOString(),
      providerAccountId: String(created.providerUserId),
      providerUsername: created.username,
      providerPassword: created.password,
      providerToken: created.providerToken,
      lastErrorMessage: undefined,
    };
    writePersistedState(userId, next);
    return newApiReadFacts(userId, next);
  },
  async topUp(userId: string): Promise<PortalAiAccessProviderFacts> {
    const current = normalizeNewApiState(userId, readPersistedState(userId))
      ?? defaultPersistedState(userId);
    let next = current;
    if (!current.provisionedAt || !current.providerAccountId) {
      const created = await newApiCreateUserIfMissing(userId, current);
      next = {
        ...current,
        version: 1,
        providerBackend: "new-api",
        provisionedAt: new Date().toISOString(),
        providerAccountId: String(created.providerUserId),
        providerUsername: created.username,
        providerPassword: created.password,
        providerToken: created.providerToken,
      };
    }
    const providerUserId = Number(next.providerAccountId ?? 0);
    if (!providerUserId) {
      throw new Error("new-api provider user id is missing");
    }
    await newApiAddQuota(providerUserId, newApiTopUpQuota());
    const persisted: PersistedAiAccessState = {
      ...next,
      version: 1,
      providerBackend: "new-api",
      providerAccountId: String(providerUserId),
      providerUsername: next.providerUsername,
      providerPassword: next.providerPassword,
      providerToken: next.providerToken,
      lastTopupAt: new Date().toISOString(),
      lastErrorMessage: undefined,
    };
    writePersistedState(userId, persisted);
    return newApiReadFacts(userId, persisted);
  },
  async refresh(userId: string): Promise<PortalAiAccessProviderFacts> {
    return newApiReadFacts(userId, readPersistedState(userId));
  },
  async retry(userId: string): Promise<PortalAiAccessProviderFacts> {
    const current = readPersistedState(userId);
    if (current) {
      writePersistedState(userId, {
        ...current,
        lastErrorMessage: undefined,
      });
    }
    return newApiReadFacts(userId, readPersistedState(userId));
  },
};

function providerAdapter(): PortalAiAccessProviderAdapter {
  if (defaultProviderBackend() === "new-api") {
    return newApiProviderAdapter;
  }
  return localProviderAdapter;
}

export async function getPortalAiAccess(userId: string): Promise<PortalAiAccessView> {
  const facts = await providerAdapter().readFacts(userId);
  const runtime = await ensureRuntimeReadiness(userId, facts);
  return buildView(facts, runtime);
}

export async function performPortalAiAccessAction(
  userId: string,
  action: PortalAiAccessActionKind,
): Promise<PortalAiAccessView> {
  const adapter = providerAdapter();
  const facts =
    action === "provision_access"
      ? await adapter.provision(userId)
      : action === "top_up"
        ? await adapter.topUp(userId)
        : action === "retry"
          ? await adapter.retry(userId)
          : await adapter.refresh(userId);
  const runtime = await ensureRuntimeReadiness(userId, facts);
  return buildView(facts, runtime);
}

export async function provisionPortalAiAccessDefaultCredential(
  userId: string,
): Promise<ManagedCredentialSummary | null> {
  if (defaultProviderBackend() !== "new-api") {
    return null;
  }
  const facts = await newApiProviderAdapter.provision(userId);
  if (!facts.providerToken) {
    throw new Error("AI access provider token is unavailable after provisioning");
  }
  return syncAiAccessDefaultCredential(userId, facts);
}

export async function getPortalAiAccessTopUpInfo(
  userId: string,
): Promise<PortalAiAccessTopUpInfo> {
  if (defaultProviderBackend() !== "new-api") {
    throw new Error("Real top-up is only supported with the new-api backend");
  }
  const { providerToken, providerUserId } = await newApiProvisionedToken(userId);
  const payload = await newApiRequest<NewApiTopUpInfoResponse>("/api/user/topup/info", {
    accessToken: providerToken,
    userIdHeader: providerUserId,
  });
  return {
    currencySymbol: "$",
    amountOptions: (payload.amount_options ?? [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0),
    methods: buildNewApiTopUpMethods(payload),
  };
}

export async function createPortalAiAccessTopUpSession(input: {
  userId: string;
  methodId: string;
  amount: number;
}): Promise<PortalAiAccessTopUpSession> {
  if (defaultProviderBackend() !== "new-api") {
    throw new Error("Real top-up is only supported with the new-api backend");
  }
  const { providerToken, providerUserId } = await newApiProvisionedToken(input.userId);
  const amount = Math.floor(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Top-up amount must be greater than 0");
  }
  let response: unknown;
  if (input.methodId.startsWith("epay:")) {
    response = await newApiRequest<unknown>("/api/user/pay", {
      method: "POST",
      accessToken: providerToken,
      userIdHeader: providerUserId,
      body: {
        amount,
        payment_method: input.methodId.slice("epay:".length),
      },
    });
  } else if (input.methodId.startsWith("waffo:")) {
    response = await newApiRequest<unknown>("/api/user/waffo/pay", {
      method: "POST",
      accessToken: providerToken,
      userIdHeader: providerUserId,
      body: {
        amount,
        pay_method_index: Number(input.methodId.slice("waffo:".length)),
      },
    });
  } else if (input.methodId === "waffo-pancake") {
    response = await newApiRequest<unknown>("/api/user/waffo-pancake/pay", {
      method: "POST",
      accessToken: providerToken,
      userIdHeader: providerUserId,
      body: { amount },
    });
  } else if (input.methodId.startsWith("creem:")) {
    response = await newApiRequest<unknown>("/api/user/creem/pay", {
      method: "POST",
      accessToken: providerToken,
      userIdHeader: providerUserId,
      body: {
        product_id: input.methodId.slice("creem:".length),
        payment_method: "creem",
      },
    });
  } else {
    throw new Error(`Unsupported top-up method '${input.methodId}'`);
  }
  return {
    redirectUrl: extractPaymentRedirectUrl(response),
  };
}


export function writePortalAiAccessStateForTest(
  userId: string,
  value: Partial<PersistedAiAccessState>,
): void {
  const current = readPersistedState(userId) ?? defaultPersistedState(userId);
  writePersistedState(userId, {
    ...current,
    ...value,
    version: 1,
  });
}

export function clearPortalAiAccessStateForTest(userId: string): void {
  fs.rmSync(aiAccessStatePath(userId), { force: true });
}
