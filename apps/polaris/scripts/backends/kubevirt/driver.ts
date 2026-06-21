import { spawnSync } from "node:child_process";
import type { BackendDriver } from "../types.js";
import type { BackendObservation, ReconcilePlan, WorkspaceSpec } from "../../core/workspace.js";
import { renderAndWriteKubevirtWorkspace } from "./render.js";
import { runCommand } from "../../utils/shell.js";

function hasKubectlVirt(): boolean {
  const result = spawnSync("kubectl", ["virt", "--help"], { encoding: "utf8" });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  return result.status === 0 || !/unknown command "virt"/i.test(output);
}

function patchVmRunStrategy(project: string, runStrategy: "Always" | "Halted"): void {
  runCommand("kubectl", [
    "-n",
    project,
    "patch",
    "vm",
    `${project}-vm`,
    "--type=merge",
    "-p",
    JSON.stringify({ spec: { runStrategy } }),
  ]);
}

function runVmLifecycleAction(project: string, action: "start" | "stop" | "restart"): void {
  if (hasKubectlVirt()) {
    runCommand("kubectl", ["virt", action, "-n", project, `${project}-vm`]);
    return;
  }
  if (action === "start") {
    patchVmRunStrategy(project, "Always");
    return;
  }
  if (action === "stop") {
    patchVmRunStrategy(project, "Halted");
    return;
  }
  patchVmRunStrategy(project, "Halted");
  patchVmRunStrategy(project, "Always");
}

export class KubevirtDriver implements BackendDriver {
  readonly kind = "kubevirt-vm" as const;

  async create(workspace: WorkspaceSpec): Promise<void> {
    renderAndWriteKubevirtWorkspace(workspace);
  }

  async start(workspace: WorkspaceSpec): Promise<void> {
    const outputPath = renderAndWriteKubevirtWorkspace(workspace);
    runCommand("kubectl", ["apply", "-f", outputPath]);
    runVmLifecycleAction(workspace.identity.projectName, "start");
  }

  async stop(workspace: WorkspaceSpec): Promise<void> {
    runVmLifecycleAction(workspace.identity.projectName, "stop");
  }

  async restart(workspace: WorkspaceSpec): Promise<void> {
    runVmLifecycleAction(workspace.identity.projectName, "restart");
  }

  async rebuild(workspace: WorkspaceSpec): Promise<void> {
    renderAndWriteKubevirtWorkspace(workspace);
  }

  async render(workspace: WorkspaceSpec): Promise<void> {
    renderAndWriteKubevirtWorkspace(workspace);
  }

  async apply(workspace: WorkspaceSpec): Promise<void> {
    const outputPath = renderAndWriteKubevirtWorkspace(workspace);
    runCommand("kubectl", ["apply", "-f", outputPath]);
  }

  async logs(workspace: WorkspaceSpec): Promise<void> {
    const launcher = spawnSync(
      "kubectl",
      ["-n", workspace.identity.projectName, "get", "pod", "-l", `vm.kubevirt.io/name=${workspace.identity.projectName}-vm`, "-o", "jsonpath={.items[0].metadata.name}"],
      { encoding: "utf8" },
    );
    const podName = (launcher.stdout || "").trim();
    if (!podName) {
      throw new Error(`No KubeVirt launcher pod found for ${workspace.identity.projectName}`);
    }
    runCommand("kubectl", ["-n", workspace.identity.projectName, "logs", podName, "--tail=200"]);
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
    const cloudInit = spawnSync(
      "kubectl",
      ["-n", workspace.identity.projectName, "get", "secret", `${workspace.profile.assetBaseName}-vm-cloudinit`, "-o", "jsonpath={.metadata.name}"],
      { encoding: "utf8" },
    );
    const cloudInitPresent = cloudInit.status === 0 && Boolean((cloudInit.stdout || "").trim());
    return {
      backend: {
        kind: workspace.backend.kind,
        exists,
        running,
        detail: exists ? (running ? `vmi phase ${phase}` : `vm exists, vmi phase ${phase || "missing"}`) : "vm object missing",
      },
      attachments: {
        workspaceData: exists ? { observed: true, detail: "project PVC referenced by VM" } : undefined,
        workspaceRuntimeState: exists ? { observed: true, detail: "runtime state references VM storage" } : undefined,
        userIdentityState: exists ? { observed: cloudInitPresent, detail: cloudInitPresent ? "rendered into cloud-init secret" : "cloud-init secret missing" } : undefined,
        userSshState: exists ? { observed: true, detail: "guest-side SSH state is backend-managed" } : undefined,
      },
      runtimeAssembly: exists && running
        ? {
            home: { observed: true, detail: workspace.runtime.home },
            projectRoot: { observed: true, detail: workspace.attachments.workspaceData.mountRoot },
            managerState: { observed: workspace.agent.enabled, detail: workspace.agent.enabled ? workspace.agent.runtime.stateRoot : "daemon disabled" },
            evolutionState: { observed: workspace.agent.enabled, detail: workspace.agent.enabled ? workspace.agent.runtime.evolutionRoot : "daemon disabled" },
            codex: { observed: cloudInitPresent, detail: workspace.attachments.userIdentityState.mountRoot },
            claude: { observed: cloudInitPresent, detail: workspace.attachments.userIdentityState.mountRoot },
            ssh: { observed: true, detail: workspace.attachments.userSshState.mountRoot },
          }
        : {},
      daemon: workspace.agent.enabled
        ? {
            manager: exists && running
              ? { observed: cloudInitPresent, detail: cloudInitPresent ? "bootstrapped by cloud-init" : "cloud-init secret missing" }
              : { observed: false, detail: workspace.agent.runtime.readyFile },
          }
        : {},
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
        runVmLifecycleAction(workspace.identity.projectName, "restart");
        continue;
      }
      if (action.kind === "repair-runtime-assembly" || action.kind === "clean-ephemeral-runtime") {
        runVmLifecycleAction(workspace.identity.projectName, "restart");
        continue;
      }
      if (action.kind === "report-unrecoverable-drift") {
        throw new Error(action.reason || "kubevirt backend cannot repair workspace drift");
      }
    }
  }
}
