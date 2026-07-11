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
  const currentUrl = new URL(window.location.href);
  const inviteCode = currentUrl.searchParams.get("invite")?.trim()
    || currentUrl.searchParams.get("code")?.trim()
    || "";
  const redirectTarget = new URL("/", window.location.origin);
  if (inviteCode) {
    redirectTarget.searchParams.set("invite", inviteCode);
  }
  return buildClerkUrl(
    clerkSignUpUrl(),
    redirectTarget.toString(),
  );
}
