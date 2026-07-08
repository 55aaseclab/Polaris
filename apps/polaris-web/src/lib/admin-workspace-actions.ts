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
  operation: AdminWorkspaceLocalAction | "create" | "delete" | null | undefined;
  localAction: AdminWorkspaceLocalAction | null | undefined;
}): AdminWorkspaceButtonState {
  const effectiveOperation = input.localAction ?? input.operation ?? null;
  const creating = effectiveOperation === "create";
  const starting = effectiveOperation === "start";
  const stopping = effectiveOperation === "stop";
  const rebuilding = effectiveOperation === "rebuild";
  const archiving = effectiveOperation === "archive" || effectiveOperation === "delete";
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
  operation: AdminWorkspaceLocalAction | "create" | "delete" | null | undefined;
  localAction: AdminWorkspaceLocalAction | null | undefined;
  backendReason: string | null | undefined;
}): AdminWorkspaceDisplayState {
  const effectiveOperation = input.localAction ?? input.operation ?? null;

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
  baselineLiveness: string | null | undefined;
  backendLiveness: string | null | undefined;
  operation: AdminWorkspaceLocalAction | "create" | "delete" | null | undefined;
  backendReason: string | null | undefined;
  workspaceExists: boolean;
}): boolean {
  const baselineLiveness = input.baselineLiveness ?? null;
  const backendLiveness = input.backendLiveness ?? null;
  const operation = input.operation ?? null;

  switch (input.localAction) {
    case "start":
      return (
        operation === "start"
        || (baselineLiveness !== "running" && backendLiveness === "running")
      );
    case "stop":
      return (
        operation === "stop"
        || (baselineLiveness === "running" && backendLiveness !== "running")
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
