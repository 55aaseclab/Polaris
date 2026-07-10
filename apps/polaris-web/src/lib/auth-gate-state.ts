import type { PortalSession } from "./api";

export function hasAuthenticatedBackendSession(
  session: PortalSession | null,
): boolean {
  return Boolean(session?.authenticated && session.clerkUserId);
}

export function resolveAuthGateState(input: {
  isLoaded: boolean;
  userId: string | null | undefined;
  sessionLoading: boolean;
  backendSession: PortalSession | null;
}) {
  const hasBackendSession = hasAuthenticatedBackendSession(input.backendSession);
  return {
    hasBackendSession,
    shouldRedirect:
      input.isLoaded
      && !input.userId
      && !input.sessionLoading
      && !hasBackendSession,
    shouldRender:
      input.isLoaded
      && !input.sessionLoading
      && Boolean(input.userId || hasBackendSession),
  };
}
