function normalizeBaseUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function normalizeScope(input: string | null | undefined): string | null {
  const trimmed = String(input ?? "").trim();
  return trimmed || null;
}

export function resolveConfiguredPaseoAppBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured =
    env.POLARIS_PASEO_APP_BASE_URL?.trim() || env.PASEO_APP_BASE_URL?.trim() || "";
  return configured ? normalizeBaseUrl(configured) : null;
}

export function extractOfferFragment(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const fragment = "#offer=";
  const index = trimmed.indexOf(fragment);
  if (index === -1) {
    return null;
  }
  const encoded = trimmed.slice(index + fragment.length).trim();
  return encoded || null;
}

export function applyPairingUrlScope(
  input: string,
  scope: string | null | undefined,
): string {
  const trimmed = input.trim();
  const normalizedScope = normalizeScope(scope);
  if (!trimmed || !normalizedScope) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    url.searchParams.set("scope", normalizedScope);
    return url.toString();
  } catch {
    return trimmed;
  }
}

export function rewritePairingUrlToAppBase(
  input: string,
  appBaseUrl: string,
  scope?: string | null,
): string {
  const trimmed = input.trim();
  const offer = extractOfferFragment(trimmed);
  if (!offer) {
    return applyPairingUrlScope(trimmed, scope);
  }
  const normalizedScope = normalizeScope(scope);
  try {
    const url = new URL(appBaseUrl);
    if (normalizedScope) {
      url.searchParams.set("scope", normalizedScope);
    }
    url.hash = `offer=${offer}`;
    return url.toString();
  } catch {
    return applyPairingUrlScope(`${appBaseUrl.replace(/\/$/, "")}/#offer=${offer}`, scope);
  }
}

export function normalizePairingUrl(
  input: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  scope?: string | null,
): string | undefined {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  const appBaseUrl = resolveConfiguredPaseoAppBaseUrl(env);
  return appBaseUrl
    ? rewritePairingUrlToAppBase(trimmed, appBaseUrl, scope)
    : applyPairingUrlScope(trimmed, scope);
}
