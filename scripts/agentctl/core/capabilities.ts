import type { WorkspaceSpec } from "./workspace.js";

const POD_PROFILES = new Set(["gvisor", "kata-qemu", "kata-clh", "kata-qemu-tdx"]);

export function validateWorkspace(workspace: WorkspaceSpec): void {
  if (!workspace.identity.projectName) {
    throw new Error("Workspace project name is required");
  }

  if (!workspace.attachments.workspaceData.mountRoot) {
    throw new Error("workspace-data must declare a mount root");
  }
  if (!workspace.attachments.workspaceRuntimeState.mountRoot) {
    throw new Error("workspace-runtime-state must declare a mount root");
  }
  if (!workspace.attachments.userIdentityState.mountRoot) {
    throw new Error("user-identity-state must declare a mount root");
  }
  if (!workspace.attachments.userSshState.mountRoot) {
    throw new Error("user-ssh-state must declare a mount root");
  }
  if (!workspace.attachments.ephemeralRuntime.mountRoot) {
    throw new Error("ephemeral-runtime must declare a mount root");
  }

  if (workspace.attachments.workspaceData.scope !== "workspace" || workspace.attachments.workspaceData.sharing !== "exclusive") {
    throw new Error("workspace-data must remain workspace-scoped and non-shared");
  }
  if (workspace.attachments.workspaceRuntimeState.scope !== "workspace" || workspace.attachments.workspaceRuntimeState.sharing !== "exclusive") {
    throw new Error("workspace-runtime-state must remain workspace-scoped and non-shared");
  }
  if (workspace.attachments.userIdentityState.scope !== "user" || workspace.attachments.userIdentityState.sharing !== "cross-workspace") {
    throw new Error("user-identity-state must remain user-scoped and cross-workspace");
  }
  if (workspace.attachments.userSshState.scope !== "user" || workspace.attachments.userSshState.sharing !== "cross-workspace") {
    throw new Error("user-ssh-state must remain user-scoped and cross-workspace");
  }
  if (workspace.attachments.workspaceRuntimeState.durablePaths.some((entry) => entry.includes("paseo")) === false) {
    throw new Error("workspace-runtime-state must contain the durable paseo state path");
  }
  if (workspace.attachments.userIdentityState.durablePaths.some((entry) => entry.includes("/identity/")) === false) {
    throw new Error("user-identity-state must expose identity attachment roots");
  }
  if (workspace.attachments.userSshState.durablePaths.some((entry) => entry === "/ssh") === false) {
    throw new Error("user-ssh-state must expose the shared SSH attachment root");
  }
  if (workspace.attachments.ephemeralRuntime.staleArtifacts.length === 0) {
    throw new Error("ephemeral-runtime must define stale artifact cleanup targets");
  }

  if (workspace.backend.kind === "pod") {
    if (!POD_PROFILES.has(workspace.backend.profile)) {
      throw new Error(`Workspace backend 'pod' requires a supported profile; got ${workspace.backend.profile}`);
    }
    for (const envVar of workspace.runtime.plainEnvVars) {
      if (envVar.value.includes("/workspace/")) {
        throw new Error(`Workspace backend 'pod' cannot set env var ${envVar.name} to a /workspace path`);
      }
    }
  }

  if (workspace.backend.kind === "kubevirt-vm") {
    if (workspace.backend.specFiles.length === 0) {
      throw new Error("Workspace backend 'kubevirt-vm' requires backend spec files");
    }
  }
}
