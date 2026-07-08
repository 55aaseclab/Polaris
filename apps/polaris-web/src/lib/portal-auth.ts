import { buildClerkUrl, clerkSignInUrl, clerkSignUpUrl } from "@/lib/clerk";

function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

export function portalSignInUrl(): string {
  if (typeof window === "undefined") {
    return clerkSignInUrl();
  }
  const redirectTarget = normalizePath(window.location.pathname) === "/sign-in"
    || normalizePath(window.location.pathname) === "/sign-up"
    ? new URL("/", window.location.origin).toString()
    : window.location.href;
  return buildClerkUrl(clerkSignInUrl(), redirectTarget);
}

export function portalSignUpUrl(): string {
  if (typeof window === "undefined") {
    return clerkSignUpUrl();
  }
  return buildClerkUrl(
    clerkSignUpUrl(),
    new URL("/", window.location.origin).toString(),
  );
}
