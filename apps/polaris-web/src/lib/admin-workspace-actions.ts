export type AdminWorkspaceButtonState = {
  running: boolean;
  creating: boolean;
  starting: boolean;
  stopping: boolean;
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

export function resolveAdminWorkspaceButtonState(input: {
  backendLiveness: string | null | undefined;
  localAction: "start" | "stop" | "archive" | "delete-archive" | null | undefined;
}): AdminWorkspaceButtonState {
  const creating = input.backendLiveness === "creating";
  const starting = input.localAction === "start" || input.backendLiveness === "starting";
  const stopping = input.localAction === "stop" || input.backendLiveness === "stopping";
  const archiving = input.localAction === "archive" || input.backendLiveness === "archiving";
  const running = input.backendLiveness === "running";
  const transitionActive = creating || starting || stopping || archiving;

  return {
    running,
    creating,
    starting,
    stopping,
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
