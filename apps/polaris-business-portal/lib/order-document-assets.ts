import { wanghaiPath } from "./paths.js";

/** Resolve an order document path from its order-directory-relative metadata path. */
export function orderDocumentAssetUrl(
  workspace: string,
  orderNo: string,
  documentPath: string,
): string {
  const encodedPath = ["assets", "订单管理", orderNo, ...documentPath.split("/")]
    .map((part) => encodeURIComponent(part))
    .join("/");
  return wanghaiPath(
    `/api/workspaces/${encodeURIComponent(workspace)}/assets?path=${encodedPath}`,
  );
}
