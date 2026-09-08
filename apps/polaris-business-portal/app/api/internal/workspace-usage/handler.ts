import { NextResponse } from "next/server";
import {
  measureWorkspaceUsage,
  type WorkspaceUsage,
} from "@polaris/business-core/workspace-usage";
import {
  assertWanghaiQuotaMeasurementRequest,
  WanghaiGatewayAuthError,
} from "@/lib/gateway-auth";

export async function handleWorkspaceUsageRequest(
  request: Request,
  readUsage: () => WorkspaceUsage = measureWorkspaceUsage,
) {
  try {
    await assertWanghaiQuotaMeasurementRequest(request);
    const usage = readUsage();
    return NextResponse.json(
      {
        schema_version: 1,
        category: "active_workspace",
        usage_bytes: usage.usageBytes,
        file_count: usage.fileCount,
        entry_count: usage.entryCount,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof WanghaiGatewayAuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode, headers: { "cache-control": "no-store" } },
      );
    }
    return NextResponse.json(
      { error: "Workspace usage is unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
