import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import {
  authenticatePortalIdentity,
  exchangeAuthingAuthorizationCode,
} from "./index.js";

function withEnv(
  entries: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return fn().finally(() => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

test("exchangeAuthingAuthorizationCode returns the access token as the portal session token", async () => {
  await withEnv(
    {
      POLARIS_AUTHING_APP_ID: "app-id",
      POLARIS_AUTHING_APP_SECRET: "app-secret",
      POLARIS_AUTHING_ISSUER: "https://auth.example/oidc",
      POLARIS_AUTHING_TOKEN_URL: "https://auth.example/oidc/token",
      POLARIS_AUTHING_JWKS_URL: undefined,
    },
    async () => {
      const originalFetch = globalThis.fetch;
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        requests.push({ url, init });
        if (url === "https://auth.example/oidc/token") {
          return new Response(
            JSON.stringify({
              access_token: "access-token-123",
              id_token: "id-token-123",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (url === "https://auth.example/oidc/me") {
          return new Response(
            JSON.stringify({
              sub: "authing-user-a",
              username: "Authing-User-A",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;
      try {
        const result = await exchangeAuthingAuthorizationCode({
          code: "auth-code",
          codeVerifier: "pkce-verifier",
          redirectUri: "https://app.example/auth/callback",
        });
        assert.equal(result.token, "access-token-123");
        assert.equal(result.idToken, "id-token-123");
        assert.equal(requests.length, 2);
        assert.equal(requests[0]?.url, "https://auth.example/oidc/token");
        assert.equal(requests[1]?.url, "https://auth.example/oidc/me");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

test("authenticatePortalIdentity resolves identity from Authing user info without JWKS", async () => {
  await withEnv(
    {
      POLARIS_AUTHING_ISSUER: "https://auth.example/oidc",
      POLARIS_AUTHING_JWKS_URL: undefined,
    },
    async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        assert.equal(url, "https://auth.example/oidc/me");
        const headers = new Headers(init?.headers ?? {});
        assert.equal(
          headers.get("authorization"),
          "Bearer access-token-123",
        );
        return new Response(
          JSON.stringify({
            sub: "authing-user-b",
            username: "Authing-User-B",
            phone_number: "+41 555 0100",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }) as typeof fetch;
      try {
        const req = {
          headers: {
            authorization: "Bearer access-token-123",
          },
        } as IncomingMessage;
        const identity = await authenticatePortalIdentity(req);
        assert.equal(identity.authingUserId, "authing-user-b");
        assert.equal(identity.authingUsername, "authing-user-b");
        assert.equal(identity.authingPhoneNumber, "+41 555 0100");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});
