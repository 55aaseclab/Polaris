import { NextResponse } from "next/server";
import {
  createManualMetricsSnapshot,
  listSeoMetrics,
  syncGa4MetricsPlaceholder,
} from "@polaris/business-core/seo-ops";
import {
  mutateWorkspace,
  readJsonObject,
  requestError,
  workspaceMutationJson,
  workspaceFromContext,
  type RouteContext,
} from "../../../../../../_lib";

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function GET(
  _request: Request,
  context: RouteContext<{ workspace: string; siteId: string }>,
) {
  try {
    const { name: workspace, root } = await workspaceFromContext(context);
    const { siteId } = await context.params;
    const id = decodeURIComponent(siteId);
    return NextResponse.json({ metrics: listSeoMetrics(root, id) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

export async function POST(
  request: Request,
  context: RouteContext<{ workspace: string; siteId: string }>,
) {
  try {
    const { name: workspace, root } = await workspaceFromContext(context);
    const { siteId } = await context.params;
    const id = decodeURIComponent(siteId);
    const payload = await readJsonObject(request);

    if (payload.action === "sync_ga4") {
      const mutation = await mutateWorkspace({
        request,
        workspace,
        workspaceRoot: root,
        mutate: () => syncGa4MetricsPlaceholder(root, id, {
          period_start: typeof payload.period_start === "string" ? payload.period_start : undefined,
          period_end: typeof payload.period_end === "string" ? payload.period_end : undefined,
        }),
      });
      return workspaceMutationJson(
        { snapshot: mutation.result },
        mutation.workspaceVersion,
        { status: 201 },
      );
    }

    const periodStart = typeof payload.period_start === "string" ? payload.period_start : "";
    const periodEnd = typeof payload.period_end === "string" ? payload.period_end : "";
    if (!periodStart || !periodEnd) {
      throw new Error("period_start and period_end are required for manual metrics");
    }
    const totalsIn =
      payload.totals && typeof payload.totals === "object"
        ? (payload.totals as Record<string, unknown>)
        : {};
    const mutation = await mutateWorkspace({
      request,
      workspace,
      workspaceRoot: root,
      mutate: () => createManualMetricsSnapshot(root, id, {
        period_start: periodStart,
        period_end: periodEnd,
        source: "manual",
        totals: {
          sessions: num(totalsIn.sessions),
          users: num(totalsIn.users),
          pageviews: num(totalsIn.pageviews),
          organic_sessions: num(totalsIn.organic_sessions),
          clicks: num(totalsIn.clicks),
          impressions: num(totalsIn.impressions),
          ctr: num(totalsIn.ctr),
          avg_position: num(totalsIn.avg_position),
        },
        notes: Array.isArray(payload.notes) ? payload.notes.map(String) : [],
      }),
    });
    return workspaceMutationJson(
      { snapshot: mutation.result },
      mutation.workspaceVersion,
      { status: 201 },
    );
  } catch (error) {
    return requestError(error);
  }
}
