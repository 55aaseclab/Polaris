import { NextResponse } from "next/server";
import { readOrderBundle, writeOrderMeta, readOrderMeta } from "@polaris/business-core/operations";
import {
  mutateWorkspace,
  readJsonObject,
  requestError,
  routeParams,
  workspaceMutationJson,
  workspaceFromContext,
  type RouteContext,
} from "../../../../_lib";

export async function GET(_request: Request, context: RouteContext<{ workspace: string; orderNo: string }>) {
  try {
    const { root } = await workspaceFromContext(context);
    const { orderNo } = await routeParams(context);
    return NextResponse.json(readOrderBundle(root, decodeURIComponent(orderNo)));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function POST(request: Request, context: RouteContext<{ workspace: string; orderNo: string }>) {
  try {
    const { name, root } = await workspaceFromContext(context);
    const { orderNo } = await routeParams(context);
    const payload = await readJsonObject(request);
    const base = readOrderMeta(root, decodeURIComponent(orderNo));
    if (!base) return NextResponse.json({ error: "Order does not exist" }, { status: 404 });
    const mutation = await mutateWorkspace({
      request,
      workspace: name,
      workspaceRoot: root,
      mutate: () => writeOrderMeta(
        root,
        decodeURIComponent(orderNo),
        { ...base, ...payload, order_no: decodeURIComponent(orderNo) },
      ),
    });
    return workspaceMutationJson({ order: mutation.result }, mutation.workspaceVersion);
  } catch (error) {
    return requestError(error);
  }
}
