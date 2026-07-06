export type AdminWorkspaceLocalAction =
  | "start"
  | "stop"
  | "rebuild"
  | "archive"
  | "delete-archive";

export type AdminWorkspaceActionEntry = {
  kind: AdminWorkspaceLocalAction;
  baselineLiveness: string | null;
};

export type AdminWorkspaceButtonState = {
  running: boolean;
  creating: boolean;
  starting: boolean;
  stopping: boolean;
  rebuilding: boolean;
  archiving: boolean;
  transitionActive: boolean;
  primaryLabel:
    | "start_workspace"
    | "stop_workspace"
    | "starting"
    | "stopping";
  archiveLabel:
    | "remove_workspace"
    | "deleting";
  primaryDisabled: boolean;
  archiveDisabled: boolean;
};

export type AdminWorkspaceDisplayState = {
  statusLabel:
    | "workspace_creating"
    | "workspace_starting"
    | "stopping"
    | "deleting"
    | null;
  shouldPoll: boolean;
  rebuildLabel: "rebuild_workspace" | "rebuilding_workspace";
  rebuildDisabled: boolean;
};

export function resolveAdminWorkspaceButtonState(input: {
  backendLiveness: string | null | undefined;
  localAction: AdminWorkspaceLocalAction | null | undefined;
}): AdminWorkspaceButtonState {
  const creating = input.backendLiveness === "creating";
  const starting = input.localAction === "start" || input.backendLiveness === "starting";
  const stopping = input.localAction === "stop" || input.backendLiveness === "stopping";
  const rebuilding = input.localAction === "rebuild";
  const archiving = input.localAction === "archive" || input.backendLiveness === "archiving";
  const running = input.backendLiveness === "running";
  const transitionActive = creating || starting || stopping || rebuilding || archiving;

  return {
    running,
    creating,
    starting,
    stopping,
    rebuilding,
    archiving,
    transitionActive,
    primaryLabel: stopping
      ? "stopping"
      : starting || creating
        ? "starting"
        : running
          ? "stop_workspace"
          : "start_workspace",
    archiveLabel: archiving ? "deleting" : "remove_workspace",
    primaryDisabled: transitionActive,
    archiveDisabled: transitionActive,
  };
}

export function resolveAdminWorkspaceDisplayState(input: {
  backendLiveness: string | null | undefined;
  localAction: AdminWorkspaceLocalAction | null | undefined;
  backendReason: string | null | undefined;
}): AdminWorkspaceDisplayState {
  const backendLiveness = input.backendLiveness ?? null;
  const localAction = input.localAction ?? null;
  const backendReason = input.backendReason ?? null;

  if (localAction === "archive" || backendLiveness === "archiving") {
    return {
      statusLabel: "deleting",
      shouldPoll: true,
      rebuildLabel: "rebuild_workspace",
      rebuildDisabled: true,
    };
  }
  if (localAction === "stop" || backendLiveness === "stopping") {
    return {
      statusLabel: "stopping",
      shouldPoll: true,
      rebuildLabel: "rebuild_workspace",
      rebuildDisabled: true,
    };
  }
  if (
    localAction === "start"
    || localAction === "rebuild"
    || backendLiveness === "creating"
    || backendLiveness === "starting"
  ) {
    return {
      statusLabel: backendLiveness === "creating" ? "workspace_creating" : "workspace_starting",
      shouldPoll: true,
      rebuildLabel: localAction === "rebuild" || backendReason === "workspace rebuild requested"
        ? "rebuilding_workspace"
        : "rebuild_workspace",
      rebuildDisabled: true,
    };
  }

  return {
    statusLabel: null,
    shouldPoll: false,
    rebuildLabel: "rebuild_workspace",
    rebuildDisabled: false,
  };
}

export function shouldClearAdminWorkspaceAction(input: {
  localAction: AdminWorkspaceLocalAction;
  baselineLiveness: string | null | undefined;
  backendLiveness: string | null | undefined;
  backendReason: string | null | undefined;
  workspaceExists: boolean;
}): boolean {
  const baselineLiveness = input.baselineLiveness ?? null;
  const backendLiveness = input.backendLiveness ?? null;
  const backendReason = input.backendReason ?? null;

  switch (input.localAction) {
    case "start":
      return (
        backendLiveness === "starting"
        || backendReason === "workspace start requested"
        || (baselineLiveness !== "running" && backendLiveness === "running")
      );
    case "stop":
      return (
        backendLiveness === "stopping"
        || backendReason === "workspace stop requested"
        || (baselineLiveness === "running" && backendLiveness !== "running")
      );
    case "rebuild":
      return (
        backendLiveness === "starting"
        || backendReason === "workspace rebuild requested"
      );
    case "archive":
      return !input.workspaceExists || backendLiveness === "archiving";
    case "delete-archive":
      return !input.workspaceExists;
    default:
      return false;
  }
}
