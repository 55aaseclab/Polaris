export {
  SHELL_ROUTE_PREFIXES,
  shellPath,
  isShellPath,
  wanghaiEmbedPath,
  WANGHAI_EMBED_ROUTE_PREFIX,
  type ShellRouteId,
} from "./routes.js";
export {
  POLARIS_PRODUCTS,
  resolveProduct,
  resolveProductForUser,
  resolveAllowedWorkspaceLines,
  resolveDefaultWorkspaceLine,
  normalizeWorkspaceLine,
  productHasSurface,
  normalizeSubscriptionLine,
  normalizePlanTier,
  type PolarisProductId,
  type PolarisProductDefinition,
  type PolarisSurfaceId,
  type PolarisSubscriptionLine,
  type PolarisWorkspaceLine,
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
  SHELL_USER_MIGRATION_SOURCES,
  type ShellUserPageModel,
} from "./user.js";
export {
  resolveShellHostActions,
  type ShellHostSummary,
  type ShellHostSurfaceAction,
  type ShellSession,
} from "./api.js";
