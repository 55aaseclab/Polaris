import { NextResponse } from "next/server";
import { createWorkspaceWorkflowInstance, listWorkspaceWorkflows } from "@/lib/workspace-workflows";
import {
  mutateWorkspace,
  readJsonObject,
  requestError,
  workspaceMutationJson,
  workspaceFromContext,
  type RouteContext,
} from "../../../_lib";

export async function GET(request: Request, context: RouteContext<{ workspace: string }>) {
  try {
    const { name, root } = await workspaceFromContext(context);
    const includeFiles = new URL(request.url).searchParams.get("include_files") !== "false";
    return NextResponse.json(
      { workflows: listWorkspaceWorkflows(name, root, { includeFiles }) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(request: Request, context: RouteContext<{ workspace: string }>) {
  try {
    const { name, root } = await workspaceFromContext(context);
    const body = await readJsonObject(request);
    const templateId = typeof body.template_id === "string" ? body.template_id : "";
    if (!templateId) throw new Error("缺少 template_id");

    const mutation = await mutateWorkspace({
      request,
      workspace: name,
      workspaceRoot: root,
      mutate: () => createWorkspaceWorkflowInstance(name, root, templateId, {
        workflowId: typeof body.workflow_id === "string" ? body.workflow_id : undefined,
      }),
    });
    return workspaceMutationJson({ workflow: mutation.result }, mutation.workspaceVersion, { status: 201 });
  } catch (error) {
    return requestError(error);
  }
}
