import { NextResponse, type NextRequest } from "next/server";
import {
  verifyWanghaiGatewayRequest,
  wanghaiGatewayFrameAncestorsDirective,
  WanghaiGatewayAuthError,
} from "@/lib/gateway-auth";
import { verifiedWanghaiGatewayHeaders } from "@/lib/gateway-headers";
import { assertWanghaiMutationAdmission } from "@/lib/mutation-admission";
import { WANGHAI_BASE_PATH } from "@/lib/paths";

export const config = {
  // The explicit root entry is required when Next applies the base path;
  // otherwise the shell page can render without gateway verification.
  matcher: ["/", "/((?!healthz|readyz).*)"],
};

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (
    pathname === "/healthz"
    || pathname === "/readyz"
    || pathname === `${WANGHAI_BASE_PATH}/healthz`
    || pathname === `${WANGHAI_BASE_PATH}/readyz`
  ) {
    return NextResponse.next();
  }
  try {
    const claims = await verifyWanghaiGatewayRequest(request);
    assertWanghaiMutationAdmission(request, claims);
    const frameAncestors = wanghaiGatewayFrameAncestorsDirective();
    const headers = verifiedWanghaiGatewayHeaders(request.headers, claims);
    const response = NextResponse.next({ request: { headers } });
    response.headers.set("cache-control", "no-store");
    response.headers.set("content-security-policy", frameAncestors);
    response.headers.set("referrer-policy", "same-origin");
    response.headers.set("x-content-type-options", "nosniff");
    return response;
  } catch (error) {
    if (error instanceof WanghaiGatewayAuthError) {
      return failureResponse(error.message, error.statusCode);
    }
    return failureResponse("Wanghai gateway verification failed", 401);
  }
}

function failureResponse(
  message: string,
  status: number,
  extraHeaders: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(
    { error: message },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "content-security-policy": "frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        ...extraHeaders,
      },
    },
  );
}
