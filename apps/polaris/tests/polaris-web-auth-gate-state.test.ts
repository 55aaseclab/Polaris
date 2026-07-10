import test from "node:test";
import assert from "node:assert/strict";
import { resolveAuthGateState } from "../../polaris-web/src/lib/auth-gate-state";
import type { PortalSession } from "../../polaris-web/src/lib/api";

function authenticatedSession(): PortalSession {
  return {
    authenticated: true,
    clerkUserId: "user_123",
    clerkUsername: "demo",
    polarisUserId: "demo",
    role: "user",
  };
}

test("auth gate redirects after logout when only a stale cached session used to remain", () => {
  const state = resolveAuthGateState({
    isLoaded: true,
    userId: null,
    sessionLoading: false,
    backendSession: null,
  });

  assert.equal(state.shouldRedirect, true);
  assert.equal(state.shouldRender, false);
});

test("auth gate allows rendering while a fresh authenticated backend session exists", () => {
  const state = resolveAuthGateState({
    isLoaded: true,
    userId: null,
    sessionLoading: false,
    backendSession: authenticatedSession(),
  });

  assert.equal(state.shouldRedirect, false);
  assert.equal(state.shouldRender, true);
});

test("auth gate keeps rendering while Clerk user is present even if backend session is refreshing", () => {
  const state = resolveAuthGateState({
    isLoaded: true,
    userId: "user_123",
    sessionLoading: true,
    backendSession: authenticatedSession(),
  });

  assert.equal(state.shouldRedirect, false);
  assert.equal(state.shouldRender, false);
});
