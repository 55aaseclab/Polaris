import * as React from "react";

type TokenResponse = {
  token?: string;
};

export type AuthingUser = {
  id: string;
  username: string | null;
  primaryEmailAddress: { emailAddress: string } | null;
  fullName: string | null;
};

type AuthingContextValue = {
  isLoaded: boolean;
  error: string | null;
  user: AuthingUser | null;
  getToken: () => Promise<string | null>;
  signIn: (screenHint?: string) => void;
  signOut: () => void;
};

const AuthingContext = React.createContext<AuthingContextValue | null>(null);
const storageKey = "polaris_authing_session";
const verifierKey = "polaris_authing_pkce_verifier";
const stateKey = "polaris_authing_state";
const authingConfig = __POLARIS_AUTHING_CONFIG__;

function required(value: string, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function redirectUri(): string {
  return authingConfig.redirectUri
    || `${window.location.origin}/auth/callback`;
}

function base64Url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    return globalThis.crypto.getRandomValues(bytes);
  }
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

async function challenge(verifier: string): Promise<{
  value: string;
  method: "S256" | "plain";
}> {
  if (typeof globalThis.crypto?.subtle?.digest === "function") {
    return {
      value: base64Url(new Uint8Array(await globalThis.crypto.subtle.digest(
        "SHA-256", new TextEncoder().encode(verifier),
      ))),
      method: "S256",
    };
  }
  console.warn("Using plain PKCE for local HTTP development; use HTTPS in production.");
  return { value: verifier, method: "plain" };
}

function decodeJwt(token: string): Record<string, unknown> {
  const encoded = token.split(".")[1];
  if (!encoded) throw new Error("Authing did not return a valid ID token");
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(encoded.length / 4) * 4, "=",
  );
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

function userFromToken(token: string): AuthingUser {
  const claims = decodeJwt(token);
  const id = String(claims.sub ?? "").trim();
  if (!id) throw new Error("Authing ID token does not contain a subject");
  const email = String(claims.email ?? "").trim();
  const username = String(
    claims.username ?? claims.preferred_username ?? claims.nickname ?? "",
  ).trim() || null;
  const name = String(claims.name ?? claims.nickname ?? "").trim() || username;
  return {
    id,
    username,
    primaryEmailAddress: email ? { emailAddress: email } : null,
    fullName: name,
  };
}

export function AuthingProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = React.useState<string | null>(() => {
    try { return sessionStorage.getItem(storageKey); } catch { return null; }
  });
  const [isLoaded, setIsLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const callbackHandledRef = React.useRef(false);

  React.useEffect(() => {
    const completeSignIn = async () => {
      const params = new URLSearchParams(window.location.search);
      const code = params.get("code");
      if (!code || window.location.pathname !== "/auth/callback") {
        setIsLoaded(true);
        return;
      }
      if (callbackHandledRef.current) {
        return;
      }
      callbackHandledRef.current = true;
      const state = params.get("state");
      const verifier = sessionStorage.getItem(verifierKey);
      if (!verifier || state !== sessionStorage.getItem(stateKey)) {
        throw new Error("Authing login state could not be verified");
      }
      const response = await fetch("/api/auth/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code,
          codeVerifier: verifier,
          redirectUri: redirectUri(),
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(String(payload?.error ?? "Authing could not complete sign-in"));
      }
      const result = await response.json() as TokenResponse;
      const token = result.token?.trim();
      if (!token) throw new Error("Authing did not return a session token");
      sessionStorage.setItem(storageKey, token);
      sessionStorage.removeItem(verifierKey);
      sessionStorage.removeItem(stateKey);
      setToken(token);
      window.history.replaceState({}, "", "/");
      setIsLoaded(true);
    };
    void completeSignIn().catch((cause: unknown) => {
      sessionStorage.removeItem(storageKey);
      sessionStorage.removeItem(verifierKey);
      sessionStorage.removeItem(stateKey);
      if (window.location.pathname === "/auth/callback") {
        window.history.replaceState({}, "", "/sign-in");
      }
      setToken(null);
      setError(cause instanceof Error ? cause.message : "Authing could not complete sign-in");
      setIsLoaded(true);
    });
  }, []);

  const value = React.useMemo<AuthingContextValue>(() => ({
    isLoaded,
    error,
    user: token ? userFromToken(token) : null,
    getToken: async () => token,
    signIn: (screenHint?: string) => {
      void (async () => {
        const verifier = base64Url(randomBytes(32));
        const state = base64Url(randomBytes(24));
        const pkce = await challenge(verifier);
        sessionStorage.setItem(verifierKey, verifier);
        sessionStorage.setItem(stateKey, state);
        const url = new URL(required(
          authingConfig.authorizationUrl,
          "POLARIS_AUTHING_AUTHORIZATION_URL",
        ));
        url.search = new URLSearchParams({
          client_id: required(authingConfig.appId, "POLARIS_AUTHING_APP_ID"), response_type: "code",
          scope: "openid profile email", redirect_uri: redirectUri(), state,
          code_challenge: pkce.value, code_challenge_method: pkce.method,
          ...(screenHint ? { screen_hint: screenHint } : {}),
        }).toString();
        window.location.assign(url.toString());
      })();
    },
    signOut: () => {
      sessionStorage.removeItem(storageKey);
      setToken(null);
      const url = new URL(required(
        authingConfig.logoutUrl,
        "POLARIS_AUTHING_LOGOUT_URL",
      ));
      url.searchParams.set(
        "post_logout_redirect_uri",
        authingConfig.logoutRedirectUri || window.location.origin,
      );
      window.location.assign(url.toString());
    },
  }), [error, isLoaded, token]);
  return <AuthingContext.Provider value={value}>{children}</AuthingContext.Provider>;
}

function useAuthingContext(): AuthingContextValue {
  const context = React.useContext(AuthingContext);
  if (!context) throw new Error("AuthingProvider is required");
  return context;
}

export function useAuth() {
  const { isLoaded, error, user, getToken } = useAuthingContext();
  return { isLoaded, error, userId: user?.id ?? null, getToken };
}

export function useUser() { return { user: useAuthingContext().user }; }
export function useAuthing() { return useAuthingContext(); }
