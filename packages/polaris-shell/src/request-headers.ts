export function buildPortalRequestHeaders(
  initHeaders: HeadersInit | undefined,
  authToken: string | null,
): Headers {
  const headers = new Headers(initHeaders);
  const token = authToken?.trim();
  if (token && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${token.replace(/^Bearer\s+/i, "").trim()}`);
  }
  return headers;
}
