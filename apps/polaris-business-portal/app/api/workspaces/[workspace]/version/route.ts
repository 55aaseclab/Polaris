import { NextResponse } from "next/server";
import { readWorkspaceVersion } from "@polaris/business-core/workspace-version";
import {
  requestError,
  workspaceFromContext,
  type RouteContext,
} from "../../../_lib";

export async function GET(
  _request: Request,
  context: RouteContext<{ workspace: string }>,
) {
  try {
    const { root } = await workspaceFromContext(context);
    const workspaceVersion = readWorkspaceVersion(root);
    return NextResponse.json(
      { workspace_version: workspaceVersion },
      {
        headers: {
          "cache-control": "no-store",
          "x-polaris-workspace-version": String(workspaceVersion),
        },
      },
    );
  } catch (error) {
    return requestError(error);
  }
}
