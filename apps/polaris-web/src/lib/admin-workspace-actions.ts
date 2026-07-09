export type AdminWorkspaceLocalAction =
  | "start"
  | "stop"
  | "rebuild"
  | "archive"
  | "delete-archive";

export type AdminWorkspaceActionEntry = {
  kind: AdminWorkspaceLocalAction;
  baselineRuntimeLifecycle: string | null;
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
  runtimeLifecycle: string | null | undefined;
  driverStatus: string | null | undefined;
  localAction: AdminWorkspaceLocalAction | null | undefined;
}): AdminWorkspaceButtonState {
  const derivedOperation =
    input.driverStatus === "creating"
      ? "create"
      : input.driverStatus === "starting"
        ? "start"
        : input.driverStatus === "stopping"
          ? "stop"
          : input.driverStatus === "rebuilding"
            ? "rebuild"
            : input.driverStatus === "archiving"
              ? "archive"
              : input.driverStatus === "deleting"
                ? "delete"
                : null;
  const effectiveOperation = input.localAction ?? derivedOperation;
  const creating = effectiveOperation === "create";
  const starting = effectiveOperation === "start";
  const stopping = effectiveOperation === "stop";
  const rebuilding = effectiveOperation === "rebuild";
  const archiving = effectiveOperation === "archive" || effectiveOperation === "delete";
  const running = input.runtimeLifecycle === "running";
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
  driverStatus: string | null | undefined;
  localAction: AdminWorkspaceLocalAction | null | undefined;
}): AdminWorkspaceDisplayState {
  const derivedOperation =
    input.driverStatus === "creating"
      ? "create"
      : input.driverStatus === "starting"
        ? "start"
        : input.driverStatus === "stopping"
          ? "stop"
          : input.driverStatus === "rebuilding"
            ? "rebuild"
            : input.driverStatus === "archiving"
              ? "archive"
              : input.driverStatus === "deleting"
                ? "delete"
                : null;
  const effectiveOperation = input.localAction ?? derivedOperation;

  if (effectiveOperation === "archive" || effectiveOperation === "delete") {
    return {
      statusLabel: "deleting",
      shouldPoll: true,
      rebuildLabel: "rebuild_workspace",
      rebuildDisabled: true,
    };
  }
  if (effectiveOperation === "stop") {
    return {
      statusLabel: "stopping",
      shouldPoll: true,
      rebuildLabel: "rebuild_workspace",
      rebuildDisabled: true,
    };
  }
  if (
    effectiveOperation === "create"
    || effectiveOperation === "start"
    || effectiveOperation === "rebuild"
  ) {
    return {
      statusLabel: effectiveOperation === "create" ? "workspace_creating" : "workspace_starting",
      shouldPoll: true,
      rebuildLabel: effectiveOperation === "rebuild"
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
  baselineRuntimeLifecycle: string | null | undefined;
  runtimeLifecycle: string | null | undefined;
  driverStatus: string | null | undefined;
  workspaceExists: boolean;
}): boolean {
  const baselineRuntimeLifecycle = input.baselineRuntimeLifecycle ?? null;
  const runtimeLifecycle = input.runtimeLifecycle ?? null;
  const operation =
    input.driverStatus === "creating"
      ? "create"
      : input.driverStatus === "starting"
        ? "start"
        : input.driverStatus === "stopping"
          ? "stop"
          : input.driverStatus === "rebuilding"
            ? "rebuild"
            : input.driverStatus === "archiving"
              ? "archive"
              : input.driverStatus === "deleting"
                ? "delete"
                : null;

  switch (input.localAction) {
    case "start":
      return (
        operation === "start"
        || (baselineRuntimeLifecycle !== "running" && runtimeLifecycle === "running")
      );
    case "stop":
      return (
        operation === "stop"
        || (baselineRuntimeLifecycle === "running" && runtimeLifecycle !== "running")
      );
    case "rebuild":
      return (
        operation === "rebuild"
      );
    case "archive":
      return !input.workspaceExists || operation === "archive" || operation === "delete";
    case "delete-archive":
      return !input.workspaceExists;
    default:
      return false;
  }
}
