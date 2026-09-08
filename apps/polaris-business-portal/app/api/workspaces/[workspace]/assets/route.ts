import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  listFilesRecursive,
  MAX_ASSET_RESPONSE_BYTES,
  requestError,
  safeAssetPath,
  workspaceFromContext,
  type RouteContext,
} from "../../../_lib";
import { assetResponseHeaders } from "@/lib/asset-response";
import { wanghaiGatewayFrameAncestorsDirective } from "@/lib/gateway-auth";

const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".err": "text/plain; charset=utf-8",
  ".out": "text/plain; charset=utf-8",
};

function assetKind(assetPath: string) {
  const extension = path.extname(assetPath).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"].includes(extension)) return "image";
  if (extension === ".pdf") return "pdf";
  if ([".json", ".csv", ".xlsx", ".xls"].includes(extension)) return "data";
  return "document";
}

function isBrowsableAsset(assetPath: string) {
  return !assetPath.split("/").some((part) => part.startsWith("."));
}

export async function GET(request: Request, context: RouteContext<{ workspace: string }>) {
  try {
    const { root } = await workspaceFromContext(context);
    const url = new URL(request.url);
    const assetPath = url.searchParams.get("path");
    if (!assetPath) {
      const assets = listFilesRecursive(root, root, 400)
        .filter((asset) => isBrowsableAsset(asset.path))
        .map((asset) => ({ ...asset, kind: assetKind(asset.path) }));
      return NextResponse.json(
        { assets, truncated: assets.length === 400 },
        { headers: { "cache-control": "private, no-store" } },
      );
    }
    const filePath = safeAssetPath(root, assetPath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return NextResponse.json({ error: "未找到资产" }, { status: 404 });
    }
    const ext = path.extname(filePath).toLowerCase();
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_ASSET_RESPONSE_BYTES) {
      return NextResponse.json(
        { error: "资产超过响应大小限制" },
        { status: 413, headers: { "cache-control": "no-store" } },
      );
    }
    const etag = `"${stat.size}-${Math.trunc(stat.mtimeMs)}"`;
    const headers = assetResponseHeaders({
      contentType: TYPES[ext] ?? "application/octet-stream",
      etag,
      fileName: path.basename(filePath),
      frameAncestorsDirective: wanghaiGatewayFrameAncestorsDirective(),
      lastModified: stat.mtime.toUTCString(),
    });
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers,
      });
    }
    return new Response(fs.readFileSync(filePath), {
      headers,
    });
  } catch (error) {
    return requestError(error);
  }
}
