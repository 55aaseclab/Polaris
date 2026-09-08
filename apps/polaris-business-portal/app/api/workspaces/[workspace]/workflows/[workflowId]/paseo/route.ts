import { NextResponse } from "next/server";
import { updateWorkspaceWorkflowPaseoAgent } from "@/lib/workspace-workflows";
import {
  mutateWorkspace,
  readJsonObject,
  requestError,
  routeParams,
  workspaceMutationJson,
  workspaceFromContext,
  type RouteContext,
} from "@/app/api/_lib";

export async function PUT(
  request: Request,
  context: RouteContext<{ workspace: string; workflowId: string }>,
) {
  try {
    const { name, root } = await workspaceFromContext(context);
    const { workflowId } = await routeParams(context);
    const body = await readJsonObject(request);
    if (typeof body.agent_id !== "string") throw new Error("缺少 agent_id");
    const agentId = body.agent_id;

    const mutation = await mutateWorkspace({
      request,
      workspace: name,
      workspaceRoot: root,
      mutate: () => updateWorkspaceWorkflowPaseoAgent(
        name,
        root,
        decodeURIComponent(workflowId),
        agentId,
      ),
    });
    return workspaceMutationJson({ workflow: mutation.result }, mutation.workspaceVersion);
  } catch (error) {
    return requestError(error);
  }
}
