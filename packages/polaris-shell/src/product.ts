/**
 * Product assembly is **per user**, not per deployment.
 * One polaris stack serves coding and vertical subscribers together.
 *
 * Two independent axes on the user subscription:
 * - **line**: `coding` | `vertical` | `both` — which product family
 * - **plan**: `free` | `pro` — feature richness within that line (reserved; keep)
 */

export type PolarisSurfaceId = "paseo" | "wanghai";

/** Subscription product line (coding agent vs vertical industry). */
export type PolarisSubscriptionLine = "coding" | "vertical" | "both";

export type PolarisWorkspaceLine = "coding" | "vertical";

/**
 * Feature richness within a line. Currently unused for gating but must remain
 * on user-map / session for future entitlements.
 */
export type PolarisPlanTier = "free" | "pro";

export type PolarisProductId = "polaris-coding" | "polaris-vertical";

export interface PolarisProductDefinition {
  id: PolarisProductId;
  line: PolarisWorkspaceLine;
  /** Outer UI surfaces the shell should offer this user. */
  surfaces: readonly PolarisSurfaceId[];
  /**
   * Default in-container runtime when this user creates a matching workspace.
   * paseo-web stays outside; wanghai server stays inside the container.
   */
  workspaceRuntime: {
    paseoDaemon: boolean;
    wanghaiPortal: boolean;
  };
}

export const POLARIS_PRODUCTS: Record<PolarisProductId, PolarisProductDefinition> = {
  "polaris-coding": {
    id: "polaris-coding",
    line: "coding",
    surfaces: ["paseo"],
    workspaceRuntime: {
      paseoDaemon: true,
      wanghaiPortal: false,
    },
  },
  "polaris-vertical": {
    id: "polaris-vertical",
    line: "vertical",
    surfaces: ["paseo", "wanghai"],
    workspaceRuntime: {
      paseoDaemon: true,
      wanghaiPortal: true,
    },
  },
};

export interface ResolveProductForUserInput {
  /**
   * Subscription line on the user record (`user-map.line` / session.line).
   * Primary signal for coding vs vertical.
   */
  line?: string | null;
  /**
   * Alias for line / product id (`coding`, `vertical`, `polaris-coding`, …).
   */
  productId?: string | null;
  /**
   * Surfaces already present on a workspace (e.g. created with wanghai image).
   * Does not change the user's subscription line permanently.
   */
  surfaces?: readonly string[] | null;
  /**
   * free | pro — feature richness. **Not** used to pick coding vs vertical.
   * Accepted so callers can pass the full subscription object without confusion.
   */
  plan?: string | null;
}

/**
 * Resolve which product a **logged-in user** gets from their subscription line.
 * Never read from process env — that would force one flavor per server.
 * Never use `plan` (free/pro) to choose the product family.
 */
export function resolveProductForUser(
  input: ResolveProductForUserInput = {},
): PolarisProductDefinition {
  const fromLine = normalizeSubscriptionLine(input.line ?? input.productId);
  if (fromLine === "coding" || fromLine === "vertical") {
    return productForLine(fromLine);
  }

  // `both` keeps the selection open; use surfaces when they are available.
  if (fromLine === "both") {
    const surfaces = (input.surfaces ?? [])
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (surfaces.includes("wanghai")) {
      return POLARIS_PRODUCTS["polaris-vertical"];
    }
    return POLARIS_PRODUCTS["polaris-coding"];
  }

  // Workspace-level surfaces are a fallback when line is not on the session yet.
  const surfaces = (input.surfaces ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (surfaces.includes("wanghai")) {
    return POLARIS_PRODUCTS["polaris-vertical"];
  }

  // `plan` intentionally ignored for product family selection.
  void input.plan;

  return POLARIS_PRODUCTS["polaris-coding"];
}

/** @deprecated Prefer resolveProductForUser({ line }) */
export function resolveProduct(id: string | null | undefined): PolarisProductDefinition {
  return resolveProductForUser({ line: id, productId: id });
}

export function productHasSurface(
  product: PolarisProductDefinition,
  surface: PolarisSurfaceId,
): boolean {
  return product.surfaces.includes(surface);
}

export function normalizeSubscriptionLine(
  value: string | null | undefined,
): PolarisSubscriptionLine | null {
  const id = value?.trim().toLowerCase() ?? "";
  if (!id) {
    return null;
  }
  if (
    id === "vertical"
    || id === "wanghai"
    || id === "polaris-vertical"
  ) {
    return "vertical";
  }
  if (id === "both" || id === "polaris-both") {
    return "both";
  }
  if (
    id === "coding"
    || id === "paseo"
    || id === "polaris-coding"
  ) {
    return "coding";
  }
  return null;
}

export function normalizePlanTier(value: string | null | undefined): PolarisPlanTier {
  return value?.trim().toLowerCase() === "pro" ? "pro" : "free";
}

export function normalizeWorkspaceLine(
  value: string | null | undefined,
): PolarisWorkspaceLine | null {
  const normalized = normalizeSubscriptionLine(value);
  if (normalized === "coding" || normalized === "vertical") {
    return normalized;
  }
  return null;
}

export function resolveAllowedWorkspaceLines(
  line: string | null | undefined,
): PolarisWorkspaceLine[] {
  const normalized = normalizeSubscriptionLine(line);
  if (normalized === "both") {
    return ["coding", "vertical"];
  }
  if (normalized === "vertical") {
    return ["vertical"];
  }
  if (normalized === "coding") {
    return ["coding"];
  }
  return ["coding"];
}

export function resolveDefaultWorkspaceLine(
  line: string | null | undefined,
): PolarisWorkspaceLine {
  return resolveAllowedWorkspaceLines(line)[0] ?? "coding";
}

function productForLine(line: PolarisWorkspaceLine): PolarisProductDefinition {
  return line === "vertical"
    ? POLARIS_PRODUCTS["polaris-vertical"]
    : POLARIS_PRODUCTS["polaris-coding"];
}
