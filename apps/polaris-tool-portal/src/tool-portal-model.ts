import {
  getPolarisToolPortalDetail,
  listPolarisToolPortalCatalogRows,
  type PolarisToolPortalCatalogRow,
  type PolarisToolPortalDetail,
} from "polaris-tools/source";

export interface ToolPortalRoute {
  readonly slug?: string;
  readonly packId?: string;
  readonly packSlug?: string;
}

export type ToolPortalScopeFilter = "all" | PolarisToolPortalCatalogRow["scope"];

export interface ToolPortalCatalogFilter {
  readonly query: string;
  readonly scope: ToolPortalScopeFilter;
  readonly packId: string;
}

export const TOOL_PORTAL_BASE_PATH = "/tools";

export function normalizeToolPortalPath(pathname: string): string {
  const normalized = pathname.replace(/\/+$/u, "") || "/";
  if (normalized === TOOL_PORTAL_BASE_PATH) return "/";
  if (normalized.startsWith(`${TOOL_PORTAL_BASE_PATH}/`)) {
    return normalized.slice(TOOL_PORTAL_BASE_PATH.length) || "/";
  }
  return normalized;
}

export function parseToolPortalRoute(pathname: string): ToolPortalRoute {
  const path = normalizeToolPortalPath(pathname);
  if (path === "/" || path === "" || path === "/console" || path === "/publisher") return {};
  const pack = path.match(/^\/packs\/([^/]+)\/([^/]+)$/u);
  if (pack) {
    return {
      packId: decodeURIComponent(pack[1] ?? ""),
      packSlug: decodeURIComponent(pack[2] ?? ""),
    };
  }
  const slug = path.match(/^\/([^/]+)$/u)?.[1];
  if (slug) return { slug: decodeURIComponent(slug) };
  return {};
}

export function catalogRows(): readonly PolarisToolPortalCatalogRow[] {
  return listPolarisToolPortalCatalogRows(TOOL_PORTAL_BASE_PATH);
}

export function filterToolPortalCatalogRows(
  rows: readonly PolarisToolPortalCatalogRow[],
  filter: ToolPortalCatalogFilter,
): readonly PolarisToolPortalCatalogRow[] {
  const query = normalizeSearchTerm(filter.query);
  return rows.filter((row) => {
    if (filter.scope !== "all" && row.scope !== filter.scope) return false;
    if (filter.packId && row.domainPack?.id !== filter.packId) return false;
    if (!query) return true;
    return toolPortalCatalogSearchText(row).includes(query);
  });
}

export function toolDetail(slug: string): PolarisToolPortalDetail | undefined {
  return getPolarisToolPortalDetail(slug, TOOL_PORTAL_BASE_PATH);
}

export function domainPackToolRow(
  rows: readonly PolarisToolPortalCatalogRow[],
  route: ToolPortalRoute,
): PolarisToolPortalCatalogRow | undefined {
  if (!route.packId || !route.packSlug) return undefined;
  return rows.find((row) =>
    row.scope === "domain-pack"
    && row.domainPack?.id === route.packId
    && row.slug === route.packSlug
  );
}

export function formatLiveState(value: string): string {
  return value === "mock-only" ? "Mock only" : "Live blocked";
}

function normalizeSearchTerm(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function toolPortalCatalogSearchText(row: PolarisToolPortalCatalogRow): string {
  return normalizeSearchTerm([
    row.id,
    row.slug,
    row.name,
    row.summary,
    row.scopeLabel,
    row.domainPack?.id,
    row.domainPack?.version,
    row.effect,
    row.risk,
    row.liveState,
    ...row.tags,
    ...(row.fields ?? []).flatMap((field) => [
      field.id,
      field.label,
      field.type,
      field.placeholder,
      field.required ? "required" : "optional",
    ]),
    ...row.toolCalls.flatMap((call) => [
      call.id,
      call.port,
      call.version,
      call.builtin,
      call.mappedToolId,
      call.effect,
      call.unresolved ? "unresolved" : undefined,
    ]),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" "));
}
