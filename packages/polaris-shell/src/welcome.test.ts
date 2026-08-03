import assert from "node:assert/strict";
import test from "node:test";
import { resolveWelcomeAction } from "./welcome.js";

test("welcome auto-signs in when auth is enabled and the session is missing", () => {
  assert.equal(
    resolveWelcomeAction({
      authMode: "authing-browser-session",
      session: null,
    }),
    "auto-sign-in",
  );
});

test("welcome skips the ui and goes straight to hosts when auth is disabled", () => {
  assert.equal(
    resolveWelcomeAction({
      authMode: "disabled",
      session: null,
    }),
    "navigate-hosts",
  );
});

test("welcome keeps authenticated users on the host flow", () => {
  assert.equal(
    resolveWelcomeAction({
      authMode: "authing-browser-session",
      session: {
        authenticated: true,
        polarisUserId: "demo",
      },
    }),
    "navigate-hosts",
  );
});
