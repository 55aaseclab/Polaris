import { NextRequest, NextResponse } from "next/server";
import { listPrebuiltWorkflows, type WorkspaceType } from "@/lib/prebuilt-workflows";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const workspaceType = request.nextUrl.searchParams.get("workspace_type");
    const normalized = normalizeWorkspaceType(workspaceType);
    return NextResponse.json({ workflows: listPrebuiltWorkflows(normalized) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function normalizeWorkspaceType(value: string | null): WorkspaceType | null {
  if (value === "ecommerce" || value === "research" || value === "unclassified") return value;
  return null;
}
