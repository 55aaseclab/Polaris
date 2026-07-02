import test from "node:test";
import assert from "node:assert/strict";
import { resolveClerkProviderConfig } from "../../polaris-web/src/lib/clerk.ts";

test("resolveClerkProviderConfig keeps cross-origin sign-in as a primary app by default", () => {
  const config = resolveClerkProviderConfig({
    env: {
      VITE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xvc2luZy1qYXktMTguY2xlcmsuYWNjb3VudHMuZGV2JA",
      VITE_CLERK_DOMAIN: "closing-jay-18.clerk.accounts.dev",
      VITE_CLERK_SIGN_IN_URL: "http://128.178.122.44:8000/sign-in/",
      VITE_CLERK_SIGN_UP_URL: "http://128.178.122.44:8000/sign-up/",
    },
    location: {
      origin: "http://128.178.122.44:8081",
      host: "128.178.122.44:8081",
    },
  });

  assert.equal(config.isSatellite, false);
  assert.equal(config.domain, undefined);
  assert.equal(config.signInUrl, "http://128.178.122.44:8000/sign-in/");
  assert.equal(config.signUpUrl, "http://128.178.122.44:8000/sign-up/");
});

test("resolveClerkProviderConfig only enables satellite mode when explicitly configured", () => {
  const config = resolveClerkProviderConfig({
    env: {
      VITE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xvc2luZy1qYXktMTguY2xlcmsuYWNjb3VudHMuZGV2JA",
      VITE_CLERK_DOMAIN: "closing-jay-18.clerk.accounts.dev",
      VITE_CLERK_SATELLITE_DOMAIN: "auto",
      VITE_CLERK_SIGN_IN_URL: "http://128.178.122.44:8000/sign-in/",
      VITE_CLERK_SIGN_UP_URL: "http://128.178.122.44:8000/sign-up/",
    },
    location: {
      origin: "http://128.178.122.44:8081",
      host: "128.178.122.44:8081",
    },
  });

  assert.equal(config.isSatellite, true);
  assert.equal(config.domain, "128.178.122.44:8081");
});

test("resolveClerkProviderConfig keeps same-origin sign-in as a primary app", () => {
  const config = resolveClerkProviderConfig({
    env: {
      VITE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xvc2luZy1qYXktMTguY2xlcmsuYWNjb3VudHMuZGV2JA",
      VITE_CLERK_SIGN_IN_URL: "http://127.0.0.1:8081/sign-in/",
      VITE_CLERK_SIGN_UP_URL: "http://127.0.0.1:8081/sign-up/",
    },
    location: {
      origin: "http://127.0.0.1:8081",
      host: "127.0.0.1:8081",
    },
  });

  assert.equal(config.isSatellite, false);
  assert.equal(config.domain, undefined);
});
