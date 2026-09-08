import { NextResponse } from "next/server";
import {
  createSeoSite,
  ensureSeoOpsLayout,
  listSeoSites,
  seoSiteSummary,
  type CreateSeoSiteInput,
  type SeoSiteStatus,
} from "@polaris/business-core/seo-ops";
import {
  mutateWorkspace,
  readJsonObject,
  requestError,
  workspaceMutationJson,
  workspaceFromContext,
  type RouteContext,
} from "../../../../_lib";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown): string | null {
  const t = text(value);
  return t || null;
}

export async function GET(_request: Request, context: RouteContext<{ workspace: string }>) {
  try {
    const { name: workspace, root } = await workspaceFromContext(context);
    ensureSeoOpsLayout(root);
    const sites = listSeoSites(root).map((site) => seoSiteSummary(root, site));
    return NextResponse.json({ sites });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

export async function POST(request: Request, context: RouteContext<{ workspace: string }>) {
  try {
    const { name: workspace, root } = await workspaceFromContext(context);
    const payload = await readJsonObject(request);
    const siteId = text(payload.site_id);
    const name = text(payload.name);
    const domain = text(payload.primary_domain);
    if (!siteId || !name || !domain) {
      throw new Error("site_id, name, and primary_domain are required");
    }
    const input: CreateSeoSiteInput = {
      site_id: siteId,
      name,
      primary_domain: domain,
      status: (payload.status as SeoSiteStatus | undefined) ?? "planning",
      locale: (payload.locale as "zh" | "en" | "multi" | undefined) ?? "en",
      markets: Array.isArray(payload.markets)
        ? payload.markets.map((item) => String(item)).filter(Boolean)
        : undefined,
      icp: optionalText(payload.icp),
      one_liner: optionalText(payload.one_liner),
      search_fit: optionalText(payload.search_fit),
      ga4_property_id: optionalText(payload.ga4_property_id),
      gsc_site_url: optionalText(payload.gsc_site_url),
      clarity_project_id: optionalText(payload.clarity_project_id),
      notes: Array.isArray(payload.notes) ? payload.notes.map(String) : [],
    };
    const mutation = await mutateWorkspace({
      request,
      workspace,
      workspaceRoot: root,
      mutate: () => createSeoSite(root, input),
    });
    return workspaceMutationJson(
      { site: seoSiteSummary(root, mutation.result) },
      mutation.workspaceVersion,
      { status: 201 },
    );
  } catch (error) {
    return requestError(error);
  }
}
