import { isWanghaiGatewayReady } from "@/lib/gateway-auth";

export const dynamic = "force-dynamic";

export function GET() {
  const configured = isWanghaiGatewayReady();
  return Response.json(
    { ok: configured, service: "polaris-business-portal" },
    { status: configured ? 200 : 503 },
  );
}
