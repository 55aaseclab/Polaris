import { WANGHAI_BASE_PATH, stripWanghaiBasePath, wanghaiPath } from "@/lib/paths";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const WORKSPACE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const EXPECTED_VERSION_HEADER = "x-polaris-expected-version";

/** Adds one browser-generated idempotency key to a mutable gateway request. */
export function withWanghaiMutationIdempotency(
  init: RequestInit = {},
  idempotencyKey?: string,
): RequestInit {
  const method = String(init.method ?? "GET").toUpperCase();
  if (SAFE_METHODS.has(method)) return init;
  const headers = new Headers(init.headers);
  if (!headers.get("idempotency-key")) {
    headers.set("idempotency-key", idempotencyKey ?? createIdempotencyKey());
  }
  return { ...init, headers };
}

/**
 * Fetches the current local version immediately before a versioned mutation.
 * Polaris signs the resulting precondition; Wanghai only verifies and applies
 * it while serializing the local filesystem write.
 */
export async function wanghaiMutationFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const normalizedInput = normalizeRequestInput(input);
  const method = requestMethod(normalizedInput, init);
  const request = withWanghaiMutationIdempotency({ ...init, method });
  if (SAFE_METHODS.has(method)) return fetch(normalizedInput, request);

  const headers = new Headers(request.headers);
  const workspace = workspaceFromRequestTarget(normalizedInput);
  if (workspace && !headers.has(EXPECTED_VERSION_HEADER)) {
    headers.set(
      EXPECTED_VERSION_HEADER,
      String(await fetchWorkspaceVersion(workspace, init)),
    );
  }
  return fetch(normalizedInput, { ...request, headers });
}

function normalizeRequestInput(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input === "string") return wanghaiPath(input);
  if (input instanceof URL) return normalizeRequestUrl(input);
  if (input instanceof Request) {
    const normalizedUrl = normalizeRequestUrl(new URL(input.url));
    if (normalizedUrl.toString() === input.url) return input;
    return new Request(normalizedUrl, input);
  }
  return input;
}

function normalizeRequestUrl(input: URL): URL {
  if (input.pathname === WANGHAI_BASE_PATH || input.pathname.startsWith(`${WANGHAI_BASE_PATH}/`)) {
    return input;
  }
  input.pathname = `${WANGHAI_BASE_PATH}${input.pathname === "/" ? "/" : input.pathname}`;
  return input;
}

function requestMethod(input: RequestInfo | URL, init: RequestInit): string {
  const inherited = input instanceof Request ? input.method : "GET";
  return String(init.method ?? inherited).toUpperCase();
}

function workspaceFromRequestTarget(input: RequestInfo | URL): string | undefined {
  const raw = input instanceof Request
    ? input.url
    : input instanceof URL
      ? input.toString()
      : input;
  let pathname: string;
  try {
    pathname = stripWanghaiBasePath(new URL(raw, "https://wanghai.invalid").pathname);
  } catch {
    return undefined;
  }
  const parts = pathname.split("/");
  if (parts.length < 4 || parts[1] !== "api" || parts[2] !== "workspaces") return undefined;
  let workspace: string;
  try {
    workspace = decodeURIComponent(parts[3]);
  } catch {
    return undefined;
  }
  return WORKSPACE_ID_PATTERN.test(workspace) ? workspace : undefined;
}

async function fetchWorkspaceVersion(
  workspace: string,
  init: RequestInit,
): Promise<number> {
  const response = await fetch(
    wanghaiPath(`/api/workspaces/${encodeURIComponent(workspace)}/version`),
    {
      cache: "no-store",
      credentials: init.credentials,
      signal: init.signal,
    },
  );
  const payload = await response.json().catch(() => null) as {
    error?: unknown;
    workspace_version?: unknown;
  } | null;
  if (!response.ok) {
    const message = typeof payload?.error === "string"
      ? payload.error
      : `Unable to read workspace version: ${response.status}`;
    throw new Error(message);
  }
  const version = payload?.workspace_version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
    throw new Error("Workspace version response is invalid");
  }
  return version;
}

function createIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  if (typeof cryptoApi?.getRandomValues !== "function") {
    if (process.env.NEXT_PUBLIC_POLARIS_BUSINESS_LOCAL_DEVELOPMENT === "1") {
      // The local HTTP adapter replaces this with a signed admission; this
      // fallback only keeps insecure test-host browsers usable.
      return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }
    throw new Error("The browser does not support secure mutation idempotency keys");
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
