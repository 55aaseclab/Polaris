import type {
  PortalWorkspaceLiveSummary,
  PortalWorkspaceStaticSummary,
  PortalWorkspaceSummary,
  PortalWorkspaceStatus,
} from "./api";

export type WorkspaceRequestPending = "start" | "stop" | "delete" | null;

export function mergeWorkspaceStaticAndLive(
  staticWorkspaces: PortalWorkspaceStaticSummary[],
  liveByWorkspace: Record<string, PortalWorkspaceLiveSummary | undefined>,
): PortalWorkspaceSummary[] {
  return staticWorkspaces.map((workspace) => ({
    name: workspace.name,
    drivers: workspace.availableDrivers.map((target) => ({
      backend: target.backend,
      ...(target.profile ? { profile: target.profile } : {}),
    })),
    status: liveByWorkspace[workspace.name]?.status ?? null,
  }));
}

export function resolveWorkspaceDetailDriverState(input: {
  driverStatus: NonNullable<PortalWorkspaceStatus["driver"]>["status"] | null | undefined;
  requestPending: WorkspaceRequestPending;
}) {
  const running = input.driverStatus === "running";
  const starting =
    input.driverStatus === "creating"
    || input.driverStatus === "starting"
    || input.driverStatus === "rebuilding";
  const stopping = input.driverStatus === "stopping";
  const deleting = input.driverStatus === "archiving" || input.driverStatus === "deleting";
  const transitionActive = starting || stopping || deleting;

  return {
    running,
    starting,
    stopping,
    deleting,
    transitionActive,
    actionLocked: transitionActive || input.requestPending !== null,
  };
}
