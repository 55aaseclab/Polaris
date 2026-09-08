import { NextResponse } from "next/server";
import {
  deleteWorkspaceWorkflowInstance,
  getWorkspaceWorkflow,
} from "@/lib/workspace-workflows";
import {
  mutateWorkspace,
  requestError,
  routeParams,
  workspaceMutationJson,
  workspaceFromContext,
  type RouteContext,
} from "../../../../_lib";

export async function GET(
  _request: Request,
  context: RouteContext<{ workspace: string; workflowId: string }>,
) {
  try {
    const { name, root } = await workspaceFromContext(context);
    const { workflowId } = await routeParams(context);
    const includeFiles = new URL(_request.url).searchParams.get("include_files") !== "false";
    return NextResponse.json(
      { workflow: getWorkspaceWorkflow(name, root, decodeURIComponent(workflowId), { includeFiles }) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return requestError(error, 404);
  }
}

export async function DELETE(
  _request: Request,
  context: RouteContext<{ workspace: string; workflowId: string }>,
) {
  try {
    const { name, root } = await workspaceFromContext(context);
    const { workflowId } = await routeParams(context);
    const mutation = await mutateWorkspace({
      request: _request,
      workspace: name,
      workspaceRoot: root,
      mutate: () => deleteWorkspaceWorkflowInstance(
        name,
        root,
        decodeURIComponent(workflowId),
      ),
    });
    return workspaceMutationJson(
      { workflow: mutation.result },
      mutation.workspaceVersion,
    );
  } catch (error) {
    return requestError(error);
  }
}
