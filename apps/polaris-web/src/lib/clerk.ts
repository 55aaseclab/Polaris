const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

function trimValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function requiredAbsoluteUrl(name: string): string {
  const value = trimValue(env?.[name]);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
}

function optionalAbsoluteUrl(name: string): string | undefined {
  const value = trimValue(env?.[name]);
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
}

export function clerkPublishableKey(): string {
  const value = trimValue(env?.VITE_CLERK_PUBLISHABLE_KEY);
  if (!value) {
    throw new Error("VITE_CLERK_PUBLISHABLE_KEY is required");
  }
  return value;
}

export function clerkSignInUrl(): string {
  return requiredAbsoluteUrl("VITE_CLERK_SIGN_IN_URL");
}

export function clerkSignUpUrl(): string {
  return requiredAbsoluteUrl("VITE_CLERK_SIGN_UP_URL");
}

export function clerkDomain(): string | undefined {
  return trimValue(env?.VITE_CLERK_DOMAIN) ?? undefined;
}

export function clerkProxyUrl(): string | undefined {
  return optionalAbsoluteUrl("VITE_CLERK_PROXY_URL");
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
