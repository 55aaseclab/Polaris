/** Product lines and surfaces available to a Polaris workspace. */
export type PolarisSurfaceId = "paseo" | "wanghai";

/** Workspace product line. */
export type PolarisWorkspaceLine = "coding" | "vertical" | "both";

export type PolarisVaultLine = "coding" | "vertical";

export type PolarisProductId = "polaris-coding" | "polaris-vertical";

export interface PolarisProductDefinition {
  id: PolarisProductId;
  line: PolarisVaultLine;
  /** Outer UI surfaces the shell should offer the workspace. */
  surfaces: readonly PolarisSurfaceId[];
  /**
   * Default in-container runtime for a matching vault.
   * paseo-web stays outside; wanghai server stays inside the container.
   */
  vaultRuntime: {
    paseoDaemon: boolean;
    wanghaiPortal: boolean;
  };
}

export const POLARIS_PRODUCTS: Record<PolarisProductId, PolarisProductDefinition> = {
  "polaris-coding": {
    id: "polaris-coding",
    line: "coding",
    surfaces: ["paseo"],
    vaultRuntime: {
      paseoDaemon: true,
      wanghaiPortal: false,
    },
  },
  "polaris-vertical": {
    id: "polaris-vertical",
    line: "vertical",
    surfaces: ["paseo", "wanghai"],
    vaultRuntime: {
      paseoDaemon: true,
      wanghaiPortal: true,
    },
  },
};

export interface WorkspaceProductInput {
  line?: string | null;
  productId?: string | null;
  surfaces?: readonly string[] | null;
}

export function resolveWorkspaceProduct(
  input: WorkspaceProductInput = {},
): PolarisProductDefinition {
  const fromLine = normalizeWorkspaceLine(input.line ?? input.productId);
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

  // Vault-level surfaces are a fallback when line is not on the session yet.
  const surfaces = (input.surfaces ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (surfaces.includes("wanghai")) {
    return POLARIS_PRODUCTS["polaris-vertical"];
  }


  return POLARIS_PRODUCTS["polaris-coding"];
}

/** @deprecated Prefer resolveWorkspaceProduct({ line }) */
export function resolveProduct(id: string | null | undefined): PolarisProductDefinition {
  return resolveWorkspaceProduct({ line: id, productId: id });
}

export function productHasSurface(
  product: PolarisProductDefinition,
  surface: PolarisSurfaceId,
): boolean {
  return product.surfaces.includes(surface);
}

export function normalizeWorkspaceLine(
  value: string | null | undefined,
): PolarisWorkspaceLine | null {
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

export function normalizeVaultLine(
  value: string | null | undefined,
): PolarisVaultLine | null {
  const normalized = normalizeWorkspaceLine(value);
  if (normalized === "coding" || normalized === "vertical") {
    return normalized;
  }
  return null;
}

export function resolveAllowedVaultLines(
  line: string | null | undefined,
): PolarisVaultLine[] {
  const normalized = normalizeWorkspaceLine(line);
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

export function resolveDefaultVaultLine(
  line: string | null | undefined,
): PolarisVaultLine {
  return resolveAllowedVaultLines(line)[0] ?? "coding";
}

function productForLine(line: PolarisVaultLine): PolarisProductDefinition {
  return line === "vertical"
    ? POLARIS_PRODUCTS["polaris-vertical"]
    : POLARIS_PRODUCTS["polaris-coding"];
}
