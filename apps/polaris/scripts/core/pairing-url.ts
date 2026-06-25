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

export function rewritePairingUrlToAppBase(input: string, appBaseUrl: string): string {
  const trimmed = input.trim();
  const offer = extractOfferFragment(trimmed);
  if (!offer) {
    return trimmed;
  }
  return `${appBaseUrl.replace(/\/$/, "")}/#offer=${offer}`;
}

export function normalizePairingUrl(
  input: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  const appBaseUrl = resolveConfiguredPaseoAppBaseUrl(env);
  return appBaseUrl ? rewritePairingUrlToAppBase(trimmed, appBaseUrl) : trimmed;
}
