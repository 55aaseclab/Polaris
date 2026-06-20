import type { WorkspaceSpec } from "./workspace.js";

const POD_PROFILES = new Set(["gvisor", "kata-qemu", "kata-clh", "kata-qemu-tdx"]);

export function validateWorkspace(workspace: WorkspaceSpec): void {
  if (!workspace.identity.projectName) {
    throw new Error("Workspace project name is required");
  }

  if (workspace.backend.kind === "pod") {
    if (!POD_PROFILES.has(workspace.backend.profile)) {
      throw new Error(`Workspace backend 'pod' requires a supported profile; got ${workspace.backend.profile}`);
    }
    for (const authFile of workspace.runtime.authFiles) {
      if (authFile.mountPath.includes("/workspace/")) {
        throw new Error(`Workspace backend 'pod' cannot mount auth file ${authFile.key} under /workspace`);
      }
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
