import { NextResponse } from "next/server";
import {
  CONFIGURED_WORKSPACE_TYPES,
  createWorkspace,
  listWorkspaces,
  STANDARD_MODULES,
} from "@polaris/business-core/workspaces";
import { readWorkspaceVersion } from "@polaris/business-core/workspace-version";
import { listWorkspaceWorkflows } from "@/lib/workspace-workflows";
import { readJsonObject, requestError, workspaceMutationJson } from "../_lib";

export async function GET() {
  return NextResponse.json({
    workspaces: listWorkspaces().map((workspace) => ({
      name: workspace.name,
      type: workspace.type,
      workspace_version: readWorkspaceVersion(workspace.path),
    })),
    modules: STANDARD_MODULES,
  });
}

export async function POST(request: Request) {
  try {
    const payload = await readJsonObject(request);

    const workspaceId = typeof payload.workspace_id === "string"
      ? payload.workspace_id.trim()
      : "";
    const workspaceType = typeof payload.workspace_type === "string"
      ? payload.workspace_type.trim()
      : "";

    if (!workspaceId) {
      return NextResponse.json({ error: "workspace id 不能为空" }, { status: 400 });
    }
    if (!CONFIGURED_WORKSPACE_TYPES.includes(workspaceType as (typeof CONFIGURED_WORKSPACE_TYPES)[number])) {
      return NextResponse.json({ error: "workspace type 必须显式选择" }, { status: 400 });
    }

    const created = createWorkspace({
      customer: typeof payload.customer === "string" ? payload.customer : workspaceId,
      description: typeof payload.description === "string" ? payload.description : "",
      type: workspaceType as (typeof CONFIGURED_WORKSPACE_TYPES)[number],
      workspace: workspaceId,
    });
    listWorkspaceWorkflows(created.name, created.path);

    return workspaceMutationJson({
      workspace: {
        name: created.name,
        type: created.type,
      },
    }, readWorkspaceVersion(created.path), { status: 201 });
  } catch (error) {
    return requestError(error);
  }
}
