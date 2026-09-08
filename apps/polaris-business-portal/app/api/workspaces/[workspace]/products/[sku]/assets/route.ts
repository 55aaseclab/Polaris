import { NextResponse } from "next/server";
import { deleteProductAsset } from "@polaris/business-core/products";
import { productDetail } from "../../_product";
import {
  mutateWorkspace,
  requestError,
  routeParams,
  workspaceMutationJson,
  workspaceFromContext,
  type RouteContext,
} from "../../../../../_lib";

export async function DELETE(
  request: Request,
  context: RouteContext<{ workspace: string; sku: string }>,
) {
  try {
    const { name, root } = await workspaceFromContext(context);
    const { sku } = await routeParams(context);
    const relativePath = new URL(request.url).searchParams.get("path") ?? "";
    const mutation = await mutateWorkspace({
      request,
      workspace: name,
      workspaceRoot: root,
      mutate: () => deleteProductAsset(root, decodeURIComponent(sku), relativePath),
    });
    return workspaceMutationJson(
      { product: productDetail(mutation.result) },
      mutation.workspaceVersion,
    );
  } catch (error) {
    return requestError(error);
  }
}
