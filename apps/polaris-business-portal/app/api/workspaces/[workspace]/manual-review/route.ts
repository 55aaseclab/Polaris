import { NextResponse } from "next/server";
import {
  exportManualReview,
  getManualReview,
  saveManualReview,
  WanghaiManualReviewPolicyError,
} from "@/lib/manual-review";
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
  if (error instanceof WanghaiManualReviewPolicyError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.statusCode, headers: { "cache-control": "no-store" } },
    );
  }
  return requestError(error);
}

function assetPath(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Review request requires asset_path");
  }
  return value;
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Review request must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export async function GET(request: Request, context: RouteContext<{ workspace: string }>) {
  try {
    const { root } = await workspaceFromContext(context);
    const path = new URL(request.url).searchParams.get("path");
    return NextResponse.json(getManualReview(root, assetPath(path)));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext<{ workspace: string }>) {
  try {
    const { name, root } = await workspaceFromContext(context);
    const body = bodyObject(await readJsonObject(request));
    if (typeof body.record_id !== "string") {
      throw new Error("Review request requires record_id");
    }
    const recordId = body.record_id;
    const mutation = await mutateWorkspace({
      request,
      workspace: name,
      workspaceRoot: root,
      mutate: () => saveManualReview(
        root,
        assetPath(body.asset_path),
        recordId,
        body.status,
        body.note,
      ),
    });
    return workspaceMutationJson(mutation.result, mutation.workspaceVersion);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext<{ workspace: string }>) {
  try {
    const { name, root } = await workspaceFromContext(context);
    const body = bodyObject(await readJsonObject(request));
    const mutation = await mutateWorkspace({
      request,
      workspace: name,
      workspaceRoot: root,
      mutate: () => exportManualReview(
        root,
        assetPath(body.asset_path),
        body.action === "complete-analysis",
      ),
    });
    return workspaceMutationJson(mutation.result, mutation.workspaceVersion);
  } catch (error) {
    return errorResponse(error);
  }
}
