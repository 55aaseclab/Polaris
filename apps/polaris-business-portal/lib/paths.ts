export const WANGHAI_BASE_PATH = "/wanghai";

/** Add the fixed public mount to a browser-relative Wanghai URL. */
export function wanghaiPath(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return `${WANGHAI_BASE_PATH}/`;
  if (raw.startsWith("//") || /^[a-z][a-z\d+.-]*:/iu.test(raw)) return raw;

  const parsed = new URL(raw, "https://wanghai.invalid");
  if (isWanghaiBasePath(parsed.pathname)) return raw;
  parsed.pathname = `${WANGHAI_BASE_PATH}${parsed.pathname === "/" ? "/" : parsed.pathname}`;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** Convert an incoming public pathname to the surface path used by contracts. */
export function stripWanghaiBasePath(pathname: string): string {
  const path = String(pathname ?? "");
  if (path === WANGHAI_BASE_PATH || path === `${WANGHAI_BASE_PATH}/`) return "/";
  if (path.startsWith(`${WANGHAI_BASE_PATH}/`)) {
    return path.slice(WANGHAI_BASE_PATH.length) || "/";
  }
  return path || "/";
}

function isWanghaiBasePath(pathname: string): boolean {
  return pathname === WANGHAI_BASE_PATH || pathname.startsWith(`${WANGHAI_BASE_PATH}/`);
}
