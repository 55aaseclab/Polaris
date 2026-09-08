import {
  hasWanghaiStandaloneCapability,
  WANGHAI_STANDALONE_ISSUER,
  WANGHAI_STANDALONE_READ_CAPABILITY,
  verifyWanghaiGatewayRequest,
  WanghaiGatewayAuthError,
  type VerifiedWanghaiGatewayClaims,
  type VerifiedWanghaiMutationAdmission,
} from "@/lib/gateway-auth";
import { stripWanghaiBasePath } from "@/lib/paths";

type MutationDefinition = {
  action: string;
  body: "json" | "multipart" | "empty";
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  requiresExpectedVersion: boolean;
  workspaceSource: "path" | "body";
};

// This is a structural claim verifier. Polaris or the trusted standalone
// adapter supplies the signed action; Wanghai does not mint policy decisions.
const MUTATION_DEFINITIONS: readonly MutationDefinition[] = [
  { action: "workspace.create", body: "json", method: "POST", path: "/api/workspaces", requiresExpectedVersion: false, workspaceSource: "body" },
  { action: "workflow.create", body: "json", method: "POST", path: "/api/workspaces/:workspace/workflows", requiresExpectedVersion: true, workspaceSource: "path" },
  { action: "workflow.delete", body: "empty", method: "DELETE", path: "/api/workspaces/:workspace/workflows/:workflowId", requiresExpectedVersion: true, workspaceSource: "path" },
  { action: "workflow.paseo.update", body: "json", method: "PUT", path: "/api/workspaces/:workspace/workflows/:workflowId/paseo", requiresExpectedVersion: true, workspaceSource: "path" },
  { action: "order.create", body: "json", method: "POST", path: "/api/workspaces/:workspace/orders", requiresExpectedVersion: true, workspaceSource: "path" },
  { action: "order.update", body: "json", method: "POST", path: "/api/workspaces/:workspace/orders/:orderNo", requiresExpectedVersion: true, workspaceSource: "path" },
  { action: "order.submodule.update", body: "json", method: "POST", path: "/api/workspaces/:workspace/orders/:orderNo/submodules/:kind", requiresExpectedVersion: true, workspaceSource: "path" },
  { action: "manual-review.update", body: "json", method: "PATCH", path: "/api/workspaces/:workspace/manual-review", requiresExpectedVersion: true, workspaceSource: "path" },
  { action: "manual-review.export", body: "json", method: "POST", path: "/api/workspaces/:workspace/manual-review", requiresExpectedVersion: true, workspaceSource: "path" },
  { action: "outreach.execute", body: "json", method: "POST", path: "/api/workspaces/:workspace/outreach", requiresExpectedVersion: true, workspaceSource: "path" },
  { action: "product.create", body: "json", method: "POST", path: "/api/workspaces/:workspace/products", requiresExpectedVersion: true, workspaceSource: "path" },
  { action: "product.update", body: "json", method: "PUT", path: "/api/workspaces/:workspace/products/:sku", requiresExpectedVersion: true, workspaceSource: "path" },
  { action: "product.asset.upload", body: "multipart", method: "POST", path: "/api/workspaces/:workspace/products/:sku", requiresExpectedVersion: true, workspaceSource: "path" },
  { action: "product.delete", body: "empty", method: "DELETE", path: "/api/workspaces/:workspace/products/:sku", requiresExpectedVersion: true, workspaceSource: "path" },
  { action: "product.asset.delete", body: "empty", method: "DELETE", path: "/api/workspaces/:workspace/products/:sku/assets", requiresExpectedVersion: true, workspaceSource: "path" },
  { action: "seo.site.create", body: "json", method: "POST", path: "/api/workspaces/:workspace/seo/sites", requiresExpectedVersion: true, workspaceSource: "path" },
  { action: "seo.site.update", body: "json", method: "PATCH", path: "/api/workspaces/:workspace/seo/sites/:siteId", requiresExpectedVersion: true, workspaceSource: "path" },
  { action: "seo.metrics.snapshot", body: "json", method: "POST", path: "/api/workspaces/:workspace/seo/sites/:siteId/metrics", requiresExpectedVersion: true, workspaceSource: "path" },
];

export function assertWanghaiMutationAdmission(
  request: Request,
  claims: VerifiedWanghaiGatewayClaims,
): VerifiedWanghaiMutationAdmission | undefined {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    if (
      claims.iss === WANGHAI_STANDALONE_ISSUER
      && !hasWanghaiStandaloneCapability(claims, WANGHAI_STANDALONE_READ_CAPABILITY)
    ) {
      throw new WanghaiGatewayAuthError("A standalone read capability is required", 403);
    }
    return undefined;
  }
  const admission = claims.admission;
  if (!admission) {
    throw new WanghaiGatewayAuthError(
      claims.iss === WANGHAI_STANDALONE_ISSUER
        ? "A standalone semantic mutation admission is required"
        : "A Polaris semantic mutation admission is required",
      403,
    );
  }
  const definition = MUTATION_DEFINITIONS.find((candidate) => candidate.action === admission.action);
  if (!definition || definition.method !== method || !bodyMatches(request, definition.body)) {
    throw new WanghaiGatewayAuthError("The mutation admission does not match this request", 403);
  }
  const params = matchPath(
    definition.path,
    stripWanghaiBasePath(new URL(request.url).pathname),
  );
  if (!params) {
    throw new WanghaiGatewayAuthError("The mutation admission does not match this request", 403);
  }
  if (definition.workspaceSource === "path" && params.workspace !== admission.workspace_id) {
    throw new WanghaiGatewayAuthError("The mutation workspace scope is invalid", 403);
  }
  if (definition.requiresExpectedVersion && admission.expected_version === undefined) {
    throw new WanghaiGatewayAuthError("The mutation expected version is required", 403);
  }
  if (
    claims.iss === WANGHAI_STANDALONE_ISSUER
    && !hasWanghaiStandaloneCapability(claims, admission.action)
  ) {
    throw new WanghaiGatewayAuthError(
      "The standalone identity does not admit this Wanghai action",
      403,
    );
  }
  if (!admission.quota_reservation_id) {
    throw new WanghaiGatewayAuthError(
      claims.iss === WANGHAI_STANDALONE_ISSUER
        ? "The standalone quota admission is required"
        : "The Polaris quota reservation is required",
      403,
    );
  }
  return admission;
}

export async function assertWanghaiJsonMutationAdmission(
  request: Request,
  body: Record<string, unknown>,
): Promise<void> {
  const claims = await verifyWanghaiGatewayRequest(request);
  const admission = assertWanghaiMutationAdmission(request, claims);
  if (admission?.action === "workspace.create" && body.workspace_id !== admission.workspace_id) {
    throw new WanghaiGatewayAuthError("The mutation workspace scope is invalid", 403);
  }
}

export async function assertWanghaiFormMutationAdmission(request: Request): Promise<void> {
  const claims = await verifyWanghaiGatewayRequest(request);
  assertWanghaiMutationAdmission(request, claims);
}

function bodyMatches(request: Request, body: MutationDefinition["body"]): boolean {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (body === "multipart") return contentType === "multipart/form-data";
  if (body === "json") return contentType === "application/json";
  return true;
}

function matchPath(template: string, pathname: string): Record<string, string> | null {
  const expected = template.slice(1).split("/");
  const actual = pathname.slice(1).split("/");
  if (expected.length !== actual.length || actual.some((segment) => !segment)) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const expectedSegment = expected[index];
    let actualSegment: string;
    try {
      actualSegment = decodeURIComponent(actual[index]);
    } catch {
      return null;
    }
    if (!actualSegment || actualSegment.includes("/") || actualSegment.includes("\\")) return null;
    if (expectedSegment.startsWith(":")) {
      params[expectedSegment.slice(1)] = actualSegment;
    } else if (expectedSegment !== actualSegment) {
      return null;
    }
  }
  return params;
}
