import { spawnSync } from "node:child_process";
import type { BackendDriver } from "../types.js";
import type { BackendObservation, ReconcilePlan, WorkspaceSpec } from "../../core/workspace.js";
import { renderAndWriteKubevirtWorkspace } from "./render.js";

export class KubevirtDriver implements BackendDriver {
  readonly kind = "kubevirt-vm" as const;

  async create(workspace: WorkspaceSpec): Promise<void> {
    renderAndWriteKubevirtWorkspace(workspace);
  }

  async start(_workspace: WorkspaceSpec): Promise<void> {
    throw new Error("Workspace backend 'kubevirt-vm' start is not implemented in the TypeScript control plane yet");
  }

  async stop(_workspace: WorkspaceSpec): Promise<void> {
    throw new Error("Workspace backend 'kubevirt-vm' stop is not implemented in the TypeScript control plane yet");
  }

  async restart(_workspace: WorkspaceSpec): Promise<void> {
    throw new Error("Workspace backend 'kubevirt-vm' restart is not implemented in the TypeScript control plane yet");
  }

  async rebuild(workspace: WorkspaceSpec): Promise<void> {
    renderAndWriteKubevirtWorkspace(workspace);
  }

  async render(workspace: WorkspaceSpec): Promise<void> {
    renderAndWriteKubevirtWorkspace(workspace);
  }

  async apply(_workspace: WorkspaceSpec): Promise<void> {
    throw new Error("Workspace backend 'kubevirt-vm' does not support live apply in the TypeScript control plane yet");
  }

  async inspect(workspace: WorkspaceSpec): Promise<BackendObservation> {
    const vm = spawnSync(
      "kubectl",
      ["-n", workspace.identity.projectName, "get", "vm", `${workspace.identity.projectName}-vm`, "-o", "jsonpath={.metadata.name}"],
      { encoding: "utf8" },
    );
    const exists = vm.status === 0 && Boolean((vm.stdout || "").trim());
    return {
      backend: {
        kind: workspace.backend.kind,
        exists,
        running: false,
        detail: exists ? "vm object exists" : "vm object missing",
      },
      attachments: {
        workspaceData: { observed: exists },
        workspaceRuntimeState: { observed: exists },
        userIdentityState: { observed: true, detail: "rendered into cloud-init today" },
        userSshState: { observed: true, detail: "guest-side handling not fully observed yet" },
      },
      runtimeAssembly: {},
      daemon: {},
      services: {
        declared: workspace.connectivity.servicePorts.length ? 1 : 0,
        observed: 0,
        detail: "live service observation not implemented yet",
      },
    };
  }

  async executeReconcilePlan(workspace: WorkspaceSpec, plan: ReconcilePlan): Promise<void> {
    for (const action of plan.actions) {
      if (action.kind === "render") {
        renderAndWriteKubevirtWorkspace(workspace);
      }
    }
  }
}
