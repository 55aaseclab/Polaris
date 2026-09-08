import { NextResponse } from "next/server";
import {
  patchSeoSite,
  readSeoSite,
  seoSiteDetail,
  setSeoTaskState,
  type SeoSiteStatus,
  type SeoTaskStatus,
} from "@polaris/business-core/seo-ops";
import {
  mutateWorkspace,
  readJsonObject,
  requestError,
  workspaceMutationJson,
  workspaceFromContext,
  type RouteContext,
} from "../../../../../_lib";

export async function GET(
  _request: Request,
  context: RouteContext<{ workspace: string; siteId: string }>,
) {
  try {
    const { name: workspace, root } = await workspaceFromContext(context);
    const { siteId } = await context.params;
    const detail = seoSiteDetail(root, decodeURIComponent(siteId));
    return NextResponse.json(detail);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext<{ workspace: string; siteId: string }>,
) {
  try {
    const { name: workspace, root } = await workspaceFromContext(context);
    const { siteId } = await context.params;
    const id = decodeURIComponent(siteId);
    const payload = await readJsonObject(request);

    if (payload.task_id && payload.task_status) {
      const mutation = await mutateWorkspace({
        request,
        workspace,
        workspaceRoot: root,
        mutate: () => setSeoTaskState(
          root,
          id,
          String(payload.task_id),
          payload.task_status as SeoTaskStatus,
          payload.task_note === undefined
            ? undefined
            : payload.task_note === null
              ? null
              : String(payload.task_note),
        ),
      });
      return workspaceMutationJson(
        seoSiteDetail(root, mutation.result.site_id),
        mutation.workspaceVersion,
      );
    }

    const mutation = await mutateWorkspace({
      request,
      workspace,
      workspaceRoot: root,
      mutate: () => patchSeoSite(root, id, {
        name: typeof payload.name === "string" ? payload.name : undefined,
        primary_domain:
          typeof payload.primary_domain === "string" ? payload.primary_domain : undefined,
        status: payload.status as SeoSiteStatus | undefined,
        locale: payload.locale as "zh" | "en" | "multi" | undefined,
        markets: Array.isArray(payload.markets)
          ? payload.markets.map((item) => String(item))
          : undefined,
        positioning:
          payload.positioning && typeof payload.positioning === "object"
            ? (payload.positioning as Record<string, string | null>)
            : undefined,
        integrations:
          payload.integrations && typeof payload.integrations === "object"
            ? (payload.integrations as Record<string, string | null>)
            : undefined,
        notes: Array.isArray(payload.notes) ? payload.notes.map(String) : undefined,
      }),
    });
    // touch read to ensure valid
    readSeoSite(root, mutation.result.site_id);
    return workspaceMutationJson(
      seoSiteDetail(root, mutation.result.site_id),
      mutation.workspaceVersion,
    );
  } catch (error) {
    return requestError(error);
  }
}
