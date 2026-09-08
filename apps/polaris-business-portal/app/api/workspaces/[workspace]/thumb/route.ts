import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getNamedCacheDir } from "@polaris/business-core/repo";
import {
  MAX_ASSET_RESPONSE_BYTES,
  requestError,
  safeAssetPath,
  workspaceFromContext,
  type RouteContext,
} from "../../../_lib";
import { assetResponseHeaders } from "@/lib/asset-response";
import { wanghaiGatewayFrameAncestorsDirective } from "@/lib/gateway-auth";
import {
  THUMBNAIL_CONVERSION_OPTIONS,
  thumbnailConversionArgs,
} from "@/lib/local-process-policy";

const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export async function GET(request: Request, context: RouteContext<{ workspace: string }>) {
  try {
    const { root, name } = await workspaceFromContext(context);
    const url = new URL(request.url);
    const assetPath = url.searchParams.get("path");
    if (!assetPath) return NextResponse.json({ error: "Missing path" }, { status: 400 });
    const sourcePath = safeAssetPath(root, assetPath);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) return NextResponse.json({ error: "Asset not found" }, { status: 404 });

    const sourceStat = fs.statSync(sourcePath);
    if (sourceStat.size > MAX_ASSET_RESPONSE_BYTES) {
      return NextResponse.json(
        { error: "Asset exceeds the response size limit" },
        { status: 413, headers: { "cache-control": "no-store" } },
      );
    }
    const sourceExt = path.extname(sourcePath).toLowerCase();
    if (!IMAGE_TYPES[sourceExt]) return NextResponse.json({ error: "Unsupported thumbnail type" }, { status: 400 });
    if (sourceExt === ".svg") {
      return new Response(fs.readFileSync(sourcePath), {
        headers: cacheHeaders(sourcePath, sourceStat, "image/svg+xml"),
      });
    }

    const key = crypto.createHash("sha1").update(`${name}:${assetPath}:${sourceStat.size}:${Math.trunc(sourceStat.mtimeMs)}`).digest("hex");
    const cacheDir = path.join(getNamedCacheDir("admin-portal-thumbs"), name);
    const thumbPath = path.join(cacheDir, `${key}.webp`);
    fs.mkdirSync(cacheDir, { recursive: true });

    if (!fs.existsSync(thumbPath)) {
      const result = spawnSync(
        "convert",
        thumbnailConversionArgs(sourcePath, thumbPath),
        THUMBNAIL_CONVERSION_OPTIONS,
      );
      if (result.status !== 0) {
        return new Response(fs.readFileSync(sourcePath), {
          headers: cacheHeaders(sourcePath, sourceStat, IMAGE_TYPES[sourceExt] ?? "application/octet-stream"),
        });
      }
    }

    const thumbStat = fs.statSync(thumbPath);
    const etag = `"${thumbStat.size}-${Math.trunc(thumbStat.mtimeMs)}"`;
    const headers = assetResponseHeaders({
      contentType: "image/webp",
      etag,
      fileName: path.basename(thumbPath),
      frameAncestorsDirective: wanghaiGatewayFrameAncestorsDirective(),
      lastModified: thumbStat.mtime.toUTCString(),
    });
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(fs.readFileSync(thumbPath), {
      headers,
    });
  } catch (error) {
    return requestError(error);
  }
}

function cacheHeaders(filePath: string, stat: fs.Stats, contentType: string) {
  return assetResponseHeaders({
    contentType,
    etag: `"${stat.size}-${Math.trunc(stat.mtimeMs)}"`,
    fileName: path.basename(filePath),
    frameAncestorsDirective: wanghaiGatewayFrameAncestorsDirective(),
    lastModified: stat.mtime.toUTCString(),
  });
}
