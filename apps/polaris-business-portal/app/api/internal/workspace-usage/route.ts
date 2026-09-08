import { handleWorkspaceUsageRequest } from "./handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return handleWorkspaceUsageRequest(request);
}
