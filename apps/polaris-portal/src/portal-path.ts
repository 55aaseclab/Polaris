// The server sets this marker when the portal is mounted behind a reverse proxy.
export function portalBase(): string {
  return typeof document === "undefined" ? "" : document.documentElement.dataset.portalBase || "";
}

export function portalHref(path: string, base = portalBase()): string {
  if (!base || !path.startsWith("/") || path.startsWith("//")) return path;
  return base + path;
}

export function portalPathname(path: string, base = portalBase()): string {
  if (base && path === base) return "/";
  return base && path.startsWith(base + "/") ? path.slice(base.length) : path;
}
