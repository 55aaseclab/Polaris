import { readWorkspaceWorkflowConfigSource } from "@/lib/workspace-workflows";
import { jsonError, routeParams, workspaceFromContext, type RouteContext } from "@/app/api/_lib";

export async function GET(
  _request: Request,
  context: RouteContext<{ workspace: string; workflowId: string }>,
) {
  try {
    const { name } = await workspaceFromContext(context);
    const { workflowId } = await routeParams(context);
    const source = readWorkspaceWorkflowConfigSource(name, decodeURIComponent(workflowId));
    return new Response(source.yaml, {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      },
      status: 200,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 404);
  }
}
