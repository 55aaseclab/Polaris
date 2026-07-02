const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

type EnvMap = Record<string, string | undefined>;

type LocationLike = {
  origin: string;
  host: string;
};

export interface ResolvedClerkProviderConfig {
  publishableKey: string;
  signInUrl: string;
  signUpUrl: string;
  proxyUrl?: string;
  isSatellite: boolean;
  domain?: string;
}

function trimValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function requiredAbsoluteUrl(name: string, sourceEnv: EnvMap = env ?? {}): string {
  const value = trimValue(sourceEnv?.[name]);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
}

function deriveFrontendApiHost(sourceEnv: EnvMap = env ?? {}): string | null {
  const publishableKey = trimValue(sourceEnv?.VITE_CLERK_PUBLISHABLE_KEY);
  if (!publishableKey) {
    return null;
  }
  const encoded = publishableKey.split("_").slice(2).join("_");
  if (!encoded) {
    return null;
  }
  try {
    return atob(encoded).replace(/\$$/, "").trim() || null;
  } catch {
    return null;
  }
}

function resolveClerkHostedUrl(
  pathname: "/sign-in/" | "/sign-up/",
  sourceEnv: EnvMap = env ?? {},
): string {
  const signInPath = pathname === "/sign-in/";
  const explicit = trimValue(
    signInPath
      ? sourceEnv?.VITE_CLERK_SIGN_IN_URL
      : sourceEnv?.VITE_CLERK_SIGN_UP_URL,
  );
  if (explicit) {
    try {
      return new URL(explicit).toString();
    } catch {
      throw new Error(
        `${signInPath ? "VITE_CLERK_SIGN_IN_URL" : "VITE_CLERK_SIGN_UP_URL"} must be an absolute URL`,
      );
    }
  }
  const domain = trimValue(sourceEnv?.VITE_CLERK_DOMAIN) ?? deriveFrontendApiHost(sourceEnv);
  if (!domain) {
    throw new Error(
      `${signInPath ? "VITE_CLERK_SIGN_IN_URL" : "VITE_CLERK_SIGN_UP_URL"} is required`,
    );
  }
  return new URL(pathname, `https://${domain.replace(/^https?:\/\//, "")}`).toString();
}

function optionalAbsoluteUrl(
  name: string,
  sourceEnv: EnvMap = env ?? {},
): string | undefined {
  const value = trimValue(sourceEnv?.[name]);
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
}

function normalizeDomain(value: string): string {
  return value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function resolveSatelliteDomain(
  sourceEnv: EnvMap,
  location: LocationLike | undefined,
): string | undefined {
  const explicit = trimValue(sourceEnv.VITE_CLERK_SATELLITE_DOMAIN);
  if (!explicit) {
    return undefined;
  }
  if (explicit === "auto") {
    return location?.host ? normalizeDomain(location.host) : undefined;
  }
  return normalizeDomain(explicit);
}

export function clerkPublishableKey(): string {
  const value = trimValue(env?.VITE_CLERK_PUBLISHABLE_KEY);
  if (!value) {
    throw new Error("VITE_CLERK_PUBLISHABLE_KEY is required");
  }
  return value;
}

export function clerkSignInUrl(): string {
  return resolveClerkHostedUrl("/sign-in/");
}

export function clerkSignUpUrl(): string {
  return resolveClerkHostedUrl("/sign-up/");
}

export function clerkDomain(): string | undefined {
  return trimValue(env?.VITE_CLERK_DOMAIN) ?? undefined;
}

export function clerkProxyUrl(): string | undefined {
  return optionalAbsoluteUrl("VITE_CLERK_PROXY_URL");
}

export function resolveClerkProviderConfig(input?: {
  env?: EnvMap;
  location?: LocationLike;
}): ResolvedClerkProviderConfig {
  const sourceEnv = input?.env ?? env ?? {};
  const location = input?.location;
  const publishableKey = (() => {
    const value = trimValue(sourceEnv.VITE_CLERK_PUBLISHABLE_KEY);
    if (!value) {
      throw new Error("VITE_CLERK_PUBLISHABLE_KEY is required");
    }
    return value;
  })();
  const signInUrl = resolveClerkHostedUrl("/sign-in/", sourceEnv);
  const signUpUrl = resolveClerkHostedUrl("/sign-up/", sourceEnv);
  const proxyUrl = optionalAbsoluteUrl("VITE_CLERK_PROXY_URL", sourceEnv);
  const satelliteDomain = resolveSatelliteDomain(sourceEnv, location);
  const isSatellite = Boolean(
    satelliteDomain
      && location?.origin
      && new URL(signInUrl).origin !== location.origin,
  );

  return {
    publishableKey,
    signInUrl,
    signUpUrl,
    ...(proxyUrl ? { proxyUrl } : {}),
    isSatellite,
    ...(isSatellite && satelliteDomain ? { domain: satelliteDomain } : {}),
  };
}

function defaultAfterAuthUrl(): string {
  return new URL("/", window.location.origin).toString();
}

function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

function resolveAfterAuthUrl(value: string | undefined): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return defaultAfterAuthUrl();
  }

  try {
    const resolved = new URL(trimmed, window.location.origin);
    const normalizedPath = normalizePath(resolved.pathname);
    if (normalizedPath === "/sign-in" || normalizedPath === "/sign-up") {
      return defaultAfterAuthUrl();
    }
    return resolved.toString();
  } catch {
    return defaultAfterAuthUrl();
  }
}

export function buildClerkUrl(target: string, redirectUrl?: string): string {
  const resolved = new URL(target);
  if (redirectUrl) {
    resolved.searchParams.set("redirect_url", resolveAfterAuthUrl(redirectUrl));
  }
  return resolved.toString();
}
