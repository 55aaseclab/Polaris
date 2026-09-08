import { NextResponse } from "next/server";
import { listCustomers } from "@polaris/business-core/operations";
import { workspaceFromContext, type RouteContext } from "../../../_lib";

export async function GET(_request: Request, context: RouteContext<{ workspace: string }>) {
  try {
    const { root } = await workspaceFromContext(context);
    return NextResponse.json({ customers: listCustomers(root) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
