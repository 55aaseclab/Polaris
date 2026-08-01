export {
  SHELL_ROUTE_PREFIXES,
  shellPath,
  isShellPath,
  type ShellRouteId,
} from "./routes.js";
export {
  POLARIS_PRODUCTS,
  resolveProduct,
  resolveProductForUser,
  productHasSurface,
  normalizeSubscriptionLine,
  normalizePlanTier,
  type PolarisProductId,
  type PolarisProductDefinition,
  type PolarisSurfaceId,
  type PolarisSubscriptionLine,
  type PolarisPlanTier,
  type ResolveProductForUserInput,
} from "./product.js";
export {
  buildOpenCodingHref,
  buildOpenWanghaiPortalHref,
  SHELL_HOST_API,
  type HostOpenTarget,
  type HostSurfaceAction,
} from "./hosts.js";
export {
  emptyWorkspaceDefaults,
  formatDockerBaseImage,
  SHELL_USER_MIGRATION_SOURCES,
  type ShellUserPageModel,
  type ShellWorkspaceDefaults,
} from "./user.js";
