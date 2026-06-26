const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

function trimValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function clerkPublishableKey(): string {
  const value = trimValue(env?.VITE_CLERK_PUBLISHABLE_KEY);
  if (!value) {
    throw new Error("VITE_CLERK_PUBLISHABLE_KEY is required");
  }
  return value;
}

export function clerkSignInUrl(): string {
  return trimValue(env?.VITE_CLERK_SIGN_IN_URL) ?? "/sign-in";
}

export function clerkSignUpUrl(): string {
  return trimValue(env?.VITE_CLERK_SIGN_UP_URL) ?? "/sign-up";
}

export function isExternalAuthUrl(target: string): boolean {
  if (typeof window === "undefined") {
    return /^https?:\/\//.test(target);
  }
  const resolved = new URL(target, window.location.origin);
  return resolved.origin !== window.location.origin;
}

export function buildClerkUrl(target: string, redirectUrl?: string): string {
  if (typeof window === "undefined") {
    return target;
  }
  const resolved = new URL(target, window.location.origin);
  if (redirectUrl) {
    resolved.searchParams.set("redirect_url", redirectUrl);
  }
  return resolved.toString();
}
