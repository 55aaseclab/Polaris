export type WanghaiMutationMethod = "POST" | "PUT" | "PATCH" | "DELETE";
export type WanghaiMutationBody = "json" | "multipart" | "empty";
export type WanghaiMutationRole = "operator" | "admin";

export interface WanghaiMutationAction {
  readonly id: string;
  readonly version: 1;
  readonly method: WanghaiMutationMethod;
  readonly pathTemplate: string;
  readonly body: WanghaiMutationBody;
  readonly minimumRole: WanghaiMutationRole;
  readonly workspaceSource: "path" | "body";
  readonly requiresExpectedVersion: boolean;
  readonly externalSideEffect: boolean;
}

export interface WanghaiMutationMatch {
  readonly action: WanghaiMutationAction;
  readonly params: Readonly<Record<string, string>>;
  readonly workspaceId?: string;
}

const WORKSPACE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const MAX_ROUTE_SEGMENT_LENGTH = 128;

const ACTION_CATALOG = [
  {
    id: "workspace.create",
    version: 1,
    method: "POST",
    pathTemplate: "/api/workspaces",
    body: "json",
    minimumRole: "operator",
    workspaceSource: "body",
    requiresExpectedVersion: false,
    externalSideEffect: false,
  },
  {
    id: "workflow.create",
    version: 1,
    method: "POST",
    pathTemplate: "/api/workspaces/:workspace/workflows",
    body: "json",
    minimumRole: "operator",
    workspaceSource: "path",
    requiresExpectedVersion: true,
    externalSideEffect: false,
  },
  {
    id: "workflow.delete",
    version: 1,
    method: "DELETE",
    pathTemplate: "/api/workspaces/:workspace/workflows/:workflowId",
    body: "empty",
    minimumRole: "operator",
    workspaceSource: "path",
    requiresExpectedVersion: true,
    externalSideEffect: false,
  },
  {
    id: "workflow.paseo.update",
    version: 1,
    method: "PUT",
    pathTemplate: "/api/workspaces/:workspace/workflows/:workflowId/paseo",
    body: "json",
    minimumRole: "operator",
    workspaceSource: "path",
    requiresExpectedVersion: true,
    externalSideEffect: false,
  },
  {
    id: "order.update",
    version: 1,
    method: "POST",
    pathTemplate: "/api/workspaces/:workspace/orders/:orderNo",
    body: "json",
    minimumRole: "operator",
    workspaceSource: "path",
    requiresExpectedVersion: true,
    externalSideEffect: false,
  },
  {
    id: "order.submodule.update",
    version: 1,
    method: "POST",
    pathTemplate: "/api/workspaces/:workspace/orders/:orderNo/submodules/:kind",
    body: "json",
    minimumRole: "operator",
    workspaceSource: "path",
    requiresExpectedVersion: true,
    externalSideEffect: false,
  },
  {
    id: "manual-review.update",
    version: 1,
    method: "PATCH",
    pathTemplate: "/api/workspaces/:workspace/manual-review",
    body: "json",
    minimumRole: "operator",
    workspaceSource: "path",
    requiresExpectedVersion: true,
    externalSideEffect: false,
  },
  {
    id: "manual-review.export",
    version: 1,
    method: "POST",
    pathTemplate: "/api/workspaces/:workspace/manual-review",
    body: "json",
    minimumRole: "operator",
    workspaceSource: "path",
    requiresExpectedVersion: true,
    externalSideEffect: false,
  },
  {
    id: "outreach.execute",
    version: 1,
    method: "POST",
    pathTemplate: "/api/workspaces/:workspace/outreach",
    body: "json",
    minimumRole: "admin",
    workspaceSource: "path",
    requiresExpectedVersion: true,
    externalSideEffect: true,
  },
  {
    id: "product.create",
    version: 1,
    method: "POST",
    pathTemplate: "/api/workspaces/:workspace/products",
    body: "json",
    minimumRole: "operator",
    workspaceSource: "path",
    requiresExpectedVersion: true,
    externalSideEffect: false,
  },
  {
    id: "product.update",
    version: 1,
    method: "PUT",
    pathTemplate: "/api/workspaces/:workspace/products/:sku",
    body: "json",
    minimumRole: "operator",
    workspaceSource: "path",
    requiresExpectedVersion: true,
    externalSideEffect: false,
  },
  {
    id: "product.asset.upload",
    version: 1,
    method: "POST",
    pathTemplate: "/api/workspaces/:workspace/products/:sku",
    body: "multipart",
    minimumRole: "operator",
    workspaceSource: "path",
    requiresExpectedVersion: true,
    externalSideEffect: false,
  },
  {
    id: "product.delete",
    version: 1,
    method: "DELETE",
    pathTemplate: "/api/workspaces/:workspace/products/:sku",
    body: "empty",
    minimumRole: "operator",
    workspaceSource: "path",
    requiresExpectedVersion: true,
    externalSideEffect: false,
  },
  {
    id: "product.asset.delete",
    version: 1,
    method: "DELETE",
    pathTemplate: "/api/workspaces/:workspace/products/:sku/assets",
    body: "empty",
    minimumRole: "operator",
    workspaceSource: "path",
    requiresExpectedVersion: true,
    externalSideEffect: false,
  },
  {
    id: "seo.site.create",
    version: 1,
    method: "POST",
    pathTemplate: "/api/workspaces/:workspace/seo/sites",
    body: "json",
    minimumRole: "operator",
    workspaceSource: "path",
    requiresExpectedVersion: true,
    externalSideEffect: false,
  },
  {
    id: "seo.site.update",
    version: 1,
    method: "PATCH",
    pathTemplate: "/api/workspaces/:workspace/seo/sites/:siteId",
    body: "json",
    minimumRole: "operator",
    workspaceSource: "path",
    requiresExpectedVersion: true,
    externalSideEffect: false,
  },
  {
    id: "seo.metrics.snapshot",
    version: 1,
    method: "POST",
    pathTemplate: "/api/workspaces/:workspace/seo/sites/:siteId/metrics",
    body: "json",
    minimumRole: "operator",
    workspaceSource: "path",
    requiresExpectedVersion: true,
    externalSideEffect: false,
  },
] as const satisfies readonly WanghaiMutationAction[];

export function listWanghaiMutationActions(): readonly WanghaiMutationAction[] {
  return ACTION_CATALOG;
}

export function findWanghaiMutationAction(id: string): WanghaiMutationAction | undefined {
  const normalized = id.trim();
  return ACTION_CATALOG.find((action) => action.id === normalized);
}

export function matchWanghaiMutationAction(input: {
  method?: string;
  pathname: string;
}): WanghaiMutationMatch | null {
  const method = String(input.method ?? "GET").toUpperCase();
  if (!isMutationMethod(method)) return null;
  const segments = normalizePathname(input.pathname);

  for (const action of ACTION_CATALOG) {
    if (action.method !== method) continue;
    const params = matchPathTemplate(action.pathTemplate, segments);
    if (!params) continue;
    const workspaceId = action.workspaceSource === "path"
      ? validateWorkspaceId(params.workspace)
      : undefined;
    return { action, params, workspaceId };
  }
  return null;
}

function isMutationMethod(method: string): method is WanghaiMutationMethod {
  return method === "POST"
    || method === "PUT"
    || method === "PATCH"
    || method === "DELETE";
}

function normalizePathname(pathname: string): string[] {
  const raw = String(pathname ?? "");
  if (
    !raw
    || raw.length > 4_096
    || !raw.startsWith("/")
    || raw.startsWith("//")
    || raw.includes("\\")
    || /[\u0000-\u001f\u007f?#]/u.test(raw)
  ) {
    throw new Error("Wanghai mutation path is invalid");
  }
  if (raw === "/") return [];
  return raw.slice(1).split("/").map((segment) => {
    if (!segment) throw new Error("Wanghai mutation path contains an empty segment");
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error("Wanghai mutation path is not valid URI encoding");
    }
    if (
      !decoded
      || decoded.length > MAX_ROUTE_SEGMENT_LENGTH
      || decoded.includes("/")
      || decoded.includes("\\")
      || decoded === "."
      || decoded === ".."
      || /[\u0000-\u001f\u007f]/u.test(decoded)
    ) {
      throw new Error("Wanghai mutation path contains an unsafe segment");
    }
    return decoded;
  });
}

function matchPathTemplate(
  template: string,
  segments: readonly string[],
): Record<string, string> | null {
  const templateSegments = template.slice(1).split("/");
  if (templateSegments.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < templateSegments.length; index += 1) {
    const expected = templateSegments[index];
    const actual = segments[index];
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = actual;
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

function validateWorkspaceId(value: string | undefined): string {
  if (!value || !WORKSPACE_ID_PATTERN.test(value)) {
    throw new Error("Wanghai mutation workspace ID is invalid");
  }
  return value;
}
