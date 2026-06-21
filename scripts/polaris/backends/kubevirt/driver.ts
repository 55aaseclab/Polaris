import { spawnSync } from "node:child_process";
import type { BackendDriver } from "../types.js";
import type { BackendObservation, ReconcilePlan, WorkspaceSpec } from "../../core/workspace.js";
import { renderAndWriteKubevirtWorkspace } from "./render.js";
import { runCommand } from "../../utils/shell.js";

export class KubevirtDriver implements BackendDriver {
  readonly kind = "kubevirt-vm" as const;

  async create(workspace: WorkspaceSpec): Promise<void> {
    renderAndWriteKubevirtWorkspace(workspace);
  }

  async start(_workspace: WorkspaceSpec): Promise<void> {
    runCommand("kubectl", ["virt", "start", "-n", _workspace.identity.projectName, `${_workspace.identity.projectName}-vm`]);
  }

  async stop(_workspace: WorkspaceSpec): Promise<void> {
    runCommand("kubectl", ["virt", "stop", "-n", _workspace.identity.projectName, `${_workspace.identity.projectName}-vm`]);
  }

  async restart(_workspace: WorkspaceSpec): Promise<void> {
    runCommand("kubectl", ["virt", "restart", "-n", _workspace.identity.projectName, `${_workspace.identity.projectName}-vm`]);
  }

  async rebuild(workspace: WorkspaceSpec): Promise<void> {
    renderAndWriteKubevirtWorkspace(workspace);
  }

  async render(workspace: WorkspaceSpec): Promise<void> {
    renderAndWriteKubevirtWorkspace(workspace);
  }

  async apply(_workspace: WorkspaceSpec): Promise<void> {
    const outputPath = renderAndWriteKubevirtWorkspace(_workspace);
    runCommand("kubectl", ["apply", "-f", outputPath]);
  }

  async inspect(workspace: WorkspaceSpec): Promise<BackendObservation> {
    const vm = spawnSync(
      "kubectl",
      ["-n", workspace.identity.projectName, "get", "vm", `${workspace.identity.projectName}-vm`, "-o", "jsonpath={.metadata.name}"],
      { encoding: "utf8" },
    );
    const exists = vm.status === 0 && Boolean((vm.stdout || "").trim());
    const vmi = exists
      ? spawnSync("kubectl", ["-n", workspace.identity.projectName, "get", "vmi", `${workspace.identity.projectName}-vm`, "-o", "jsonpath={.status.phase}"], { encoding: "utf8" })
      : { status: 1, stdout: "", stderr: "" };
    const phase = (vmi.stdout || "").trim();
    const running = phase === "Running";
    const service = workspace.connectivity.servicePorts.length
      ? spawnSync("kubectl", ["-n", workspace.identity.projectName, "get", "svc", workspace.identity.projectName, "-o", "jsonpath={.metadata.name}"], { encoding: "utf8" })
      : { status: 0, stdout: "", stderr: "" };
    const serviceCount = (service.stdout || "").trim() ? 1 : 0;
    return {
      backend: {
        kind: workspace.backend.kind,
        exists,
        running,
        detail: exists ? (running ? `vmi phase ${phase}` : `vm exists, vmi phase ${phase || "missing"}`) : "vm object missing",
      },
      attachments: {
        workspaceData: { observed: exists, detail: "project PVC referenced by VM" },
        workspaceRuntimeState: { observed: exists, detail: "runtime state shares VM storage surface today" },
        userIdentityState: { observed: true, detail: "rendered into cloud-init today" },
        userSshState: { observed: true, detail: "guest-side handling is backend-managed" },
      },
      runtimeAssembly: {},
      daemon: {},
      services: {
        declared: workspace.connectivity.servicePorts.length ? 1 : 0,
        observed: serviceCount,
        detail: serviceCount ? "service object present" : "service object missing",
      },
    };
  }

  async executeReconcilePlan(workspace: WorkspaceSpec, plan: ReconcilePlan): Promise<void> {
    for (const action of plan.actions) {
      if (action.kind === "render") {
        renderAndWriteKubevirtWorkspace(workspace);
        continue;
      }
      if (action.kind === "apply") {
        const outputPath = renderAndWriteKubevirtWorkspace(workspace);
        runCommand("kubectl", ["apply", "-f", outputPath]);
        continue;
      }
      if (action.kind === "restart-runtime") {
        runCommand("kubectl", ["virt", "restart", "-n", workspace.identity.projectName, `${workspace.identity.projectName}-vm`]);
      }
    }
  }
}
