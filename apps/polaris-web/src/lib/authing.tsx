import * as React from "react";

type TokenResponse = {
  access_token?: string;
  id_token?: string;
  expires_in?: number;
};

export type AuthingUser = {
  id: string;
  username: string | null;
  primaryEmailAddress: { emailAddress: string } | null;
  fullName: string | null;
};

type AuthingContextValue = {
  isLoaded: boolean;
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

async function challenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(verifier),
  )));
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
  const username = String(claims.preferred_username ?? claims.nickname ?? "").trim() || null;
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

  React.useEffect(() => {
    const completeSignIn = async () => {
      const params = new URLSearchParams(window.location.search);
      const code = params.get("code");
      if (!code || window.location.pathname !== "/auth/callback") {
        setIsLoaded(true);
        return;
      }
      const state = params.get("state");
      const verifier = sessionStorage.getItem(verifierKey);
      if (!verifier || state !== sessionStorage.getItem(stateKey)) {
        throw new Error("Authing login state could not be verified");
      }
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: required(authingConfig.appId, "POLARIS_AUTHING_APP_ID"),
        code,
        redirect_uri: redirectUri(),
        code_verifier: verifier,
      });
      const response = await fetch(required(
        authingConfig.tokenUrl,
        "POLARIS_AUTHING_TOKEN_URL",
      ), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!response.ok) throw new Error("Authing could not complete sign-in");
      const result = await response.json() as TokenResponse;
      const idToken = result.id_token?.trim();
      if (!idToken) throw new Error("Authing did not return an ID token");
      sessionStorage.setItem(storageKey, idToken);
      sessionStorage.removeItem(verifierKey);
      sessionStorage.removeItem(stateKey);
      setToken(idToken);
      window.history.replaceState({}, "", "/");
      setIsLoaded(true);
    };
    void completeSignIn().catch(() => {
      sessionStorage.removeItem(storageKey);
      setToken(null);
      setIsLoaded(true);
    });
  }, []);

  const value = React.useMemo<AuthingContextValue>(() => ({
    isLoaded,
    user: token ? userFromToken(token) : null,
    getToken: async () => token,
    signIn: (screenHint?: string) => {
      void (async () => {
        const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
        const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
        sessionStorage.setItem(verifierKey, verifier);
        sessionStorage.setItem(stateKey, state);
        const url = new URL(required(
          authingConfig.authorizationUrl,
          "POLARIS_AUTHING_AUTHORIZATION_URL",
        ));
        url.search = new URLSearchParams({
          client_id: required(authingConfig.appId, "POLARIS_AUTHING_APP_ID"), response_type: "code",
          scope: "openid profile email", redirect_uri: redirectUri(), state,
          code_challenge: await challenge(verifier), code_challenge_method: "S256",
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
      url.searchParams.set("post_logout_redirect_uri", window.location.origin);
      window.location.assign(url.toString());
    },
  }), [isLoaded, token]);
  return <AuthingContext.Provider value={value}>{children}</AuthingContext.Provider>;
}

function useAuthingContext(): AuthingContextValue {
  const context = React.useContext(AuthingContext);
  if (!context) throw new Error("AuthingProvider is required");
  return context;
}

export function useAuth() {
  const { isLoaded, user, getToken } = useAuthingContext();
  return { isLoaded, userId: user?.id ?? null, getToken };
}

export function useUser() { return { user: useAuthingContext().user }; }
export function useAuthing() { return useAuthingContext(); }
