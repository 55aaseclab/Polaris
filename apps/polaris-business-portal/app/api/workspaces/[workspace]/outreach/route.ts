import { NextResponse } from "next/server";
import {
  getOutreachSnapshot,
  runOutreachAction,
  type OutreachAction,
  WanghaiOutreachPolicyError,
} from "@/lib/outreach";
import { verifyWanghaiGatewayRequest } from "@/lib/gateway-auth";
import {
  mutateWorkspace,
  readJsonObject,
  requestError,
  workspaceMutationJson,
  workspaceFromContext,
  type RouteContext,
} from "../../../_lib";

export const runtime = "nodejs";

function errorResponse(error: unknown) {
  if (error instanceof WanghaiOutreachPolicyError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.statusCode, headers: { "cache-control": "no-store" } },
    );
  }
  return requestError(error);
}

export async function GET(_request: Request, context: RouteContext<{ workspace: string }>) {
  try {
    const { name, root } = await workspaceFromContext(context);
    return NextResponse.json(getOutreachSnapshot(name));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext<{ workspace: string }>) {
  try {
    const claims = await verifyWanghaiGatewayRequest(request);
    const { name, root } = await workspaceFromContext(context);
    const actionBody = await readJsonObject(request) as OutreachAction & { action?: string };
    if (!actionBody.action || typeof actionBody.action !== "string") {
      throw new Error("Outreach action requires action field");
    }
    if (Object.hasOwn(actionBody, "actor")) {
      throw new Error("actor is derived from the verified gateway identity");
    }
    const mutation = await mutateWorkspace({
      request,
      workspace: name,
      workspaceRoot: root,
      mutate: () => {
        const result = runOutreachAction(name, actionBody as OutreachAction, claims.sub);
        const snapshot = getOutreachSnapshot(name);
        return { ok: true, result, snapshot };
      },
    });
    return workspaceMutationJson(mutation.result, mutation.workspaceVersion);
  } catch (error) {
    return errorResponse(error);
  }
}
