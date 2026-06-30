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

function deriveFrontendApiHost(): string | null {
  const publishableKey = trimValue(env?.VITE_CLERK_PUBLISHABLE_KEY);
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

function resolveClerkHostedUrl(pathname: "/sign-in/" | "/sign-up/"): string {
  const signInPath = pathname === "/sign-in/";
  const explicit = trimValue(
    signInPath
      ? env?.VITE_CLERK_SIGN_IN_URL
      : env?.VITE_CLERK_SIGN_UP_URL,
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
  const domain = trimValue(env?.VITE_CLERK_DOMAIN) ?? deriveFrontendApiHost();
  if (!domain) {
    throw new Error(
      `${signInPath ? "VITE_CLERK_SIGN_IN_URL" : "VITE_CLERK_SIGN_UP_URL"} is required`,
    );
  }
  return new URL(pathname, `https://${domain.replace(/^https?:\/\//, "")}`).toString();
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
