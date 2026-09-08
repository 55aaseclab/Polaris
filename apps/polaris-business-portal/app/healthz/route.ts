export const dynamic = "force-dynamic";

const POLARIS_BUSINESS_HEALTHZ_RELEASE_MARKER = "2026-09-08-business-portal";

export function GET() {
  return Response.json({
    ok: true,
    service: "polaris-business-portal",
    release_marker: POLARIS_BUSINESS_HEALTHZ_RELEASE_MARKER,
  });
}
