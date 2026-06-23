import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import type { BackendDriver } from "../types.js";
import type { BackendObservation, ObservationItem, ReconcilePlan, WorkspaceSpec } from "../../core/workspace.js";
import { renderAndWriteKubevirtWorkspace } from "./render.js";
import { runCommand } from "../../utils/shell.js";
import { workspaceDataClaimName } from "../../core/netfs.js";

function hasKubectlVirt(): boolean {
  const result = spawnSync("kubectl", ["virt", "--help"], { encoding: "utf8" });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  return result.status === 0 || !/unknown command "virt"/i.test(output);
}

function waitForPortForwardReady(
  project: string,
  serviceName: string,
  localPort: number,
): Promise<ReturnType<typeof spawn>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "kubectl",
      [
        "-n",
        project,
        "port-forward",
        `svc/${serviceName}`,
        `${localPort}:6767`,
        "--address",
        "127.0.0.1",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("Timed out waiting for kubectl port-forward"));
    }, 8000);
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      if (!/Forwarding from 127\.0\.0\.1:/u.test(text) || settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(child);
    };
    const onExit = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`kubectl port-forward exited early (${code ?? "unknown"})`));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function connectTcpOnce(localPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: localPort });
    const finish = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function connectTcp(localPort: number): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await connectTcpOnce(localPort)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function reserveLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve a local port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function probeTcpReachability(project: string, serviceName: string): Promise<boolean> {
  const localPort = await reserveLocalPort();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = await waitForPortForwardReady(project, serviceName, localPort);
    return await connectTcp(localPort);
  } catch {
    return false;
  } finally {
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
  }
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

function extractPairingUrl(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { url?: unknown };
    return typeof parsed.url === "string" && parsed.url.trim() ? parsed.url.trim() : undefined;
  } catch {
    return undefined;
  }
}

function probeKubevirtPairingState(project: string, claimName: string): ObservationItem {
  const podName = `${project}-pairing-inspect`;
  const manifest = [
    "apiVersion: v1",
    "kind: Pod",
    "metadata:",
    `  name: ${podName}`,
    `  namespace: ${project}`,
    "spec:",
    "  restartPolicy: Never",
    "  containers:",
    "    - name: inspect",
    "      image: busybox:1.36",
    "      command: [\"sh\", \"-lc\", \"sleep 60\"]",
    "      volumeMounts:",
    "        - name: workspace-runtime-state",
    "          mountPath: /workspace/state",
    "  volumes:",
    "    - name: workspace-runtime-state",
    "      persistentVolumeClaim:",
    `        claimName: ${claimName}`,
    "",
  ].join("\n");
  const result = (() => {
    try {
      const apply = spawnSync("kubectl", ["apply", "-f", "-"], {
        input: manifest,
        encoding: "utf8",
      });
      if (apply.status !== 0) {
        return { observed: false, detail: "pairing inspection pod apply failed" };
      }
      const ready = spawnSync(
        "kubectl",
        ["-n", project, "wait", "--for=condition=Ready", `pod/${podName}`, "--timeout=60s"],
        { encoding: "utf8" },
      );
      if (ready.status !== 0) {
        return { observed: false, detail: "pairing inspection pod not ready" };
      }
      const inspect = spawnSync(
        "kubectl",
        [
          "-n",
          project,
          "exec",
          podName,
          "--",
          "sh",
          "-lc",
          "test -s /workspace/state/paseo/pairing.json && test -s /workspace/state/paseo/server-id && test -s /workspace/state/paseo/daemon-keypair.json && ! tail -n 40 /workspace/state/paseo/daemon.log 2>/dev/null | grep -q 'missing hello'",
        ],
        { encoding: "utf8" },
      );
      const pairingFile = spawnSync(
        "kubectl",
        [
          "-n",
          project,
          "exec",
          podName,
          "--",
          "sh",
          "-lc",
          "cat /workspace/state/paseo/pairing.json",
        ],
        { encoding: "utf8" },
      );
      const pairingUrl = pairingFile.status === 0
        ? extractPairingUrl(String(pairingFile.stdout || ""))
        : undefined;
      return inspect.status === 0
        ? { observed: true, detail: "/root/.paseo/pairing.json", url: pairingUrl }
        : { observed: false, detail: "/root/.paseo/pairing.json" };
    } catch {
      return { observed: false, detail: "pairing inspection failed" };
    }
  })();
  spawnSync("kubectl", ["-n", project, "delete", "pod", podName, "--ignore-not-found"], { encoding: "utf8" });
  return result;
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
    const serviceName = (service.stdout || "").trim();
    const serviceCount = serviceName ? 1 : 0;
    const cloudInit = spawnSync(
      "kubectl",
      ["-n", workspace.identity.projectName, "get", "secret", `${workspace.identity.projectName}-vm-cloudinit`, "-o", "jsonpath={.metadata.name}"],
      { encoding: "utf8" },
    );
    const cloudInitPresent = cloudInit.status === 0 && Boolean((cloudInit.stdout || "").trim());
    const workspaceDataVolume = workspaceDataClaimName(workspace);
    const workspaceRuntimeStateVolume =
      workspace.attachments.workspaceRuntimeState.source.volumeRef ??
      workspace.storage.claimName;
    const userIdentityStateVolume =
      workspace.attachments.userIdentityState.source.volumeRef ?? "missing";
    const userSshStateVolume =
      workspace.attachments.userSshState.source.volumeRef ?? "missing";
    const guestReachable =
      exists &&
      running &&
      workspace.connectivity.servicePorts.length > 0 &&
      serviceName.length > 0 &&
      await probeTcpReachability(workspace.identity.projectName, serviceName);
    const pairingObserved =
      workspace.agent.enabled && exists && running
        ? probeKubevirtPairingState(
            workspace.identity.projectName,
            workspaceRuntimeStateVolume,
          )
        : workspace.agent.enabled
          ? { observed: false, detail: workspace.agent.runtime.pairingFile }
          : { observed: true, detail: "daemon not required" };
    return {
      backend: {
        kind: workspace.backend.kind,
        exists,
        running,
        detail: exists ? (running ? `vmi phase ${phase}` : `vm exists, vmi phase ${phase || "missing"}`) : "vm object missing",
      },
      attachments: {
        workspaceData: exists ? { observed: true, detail: `pvc/${workspaceDataVolume} -> ${workspace.attachments.workspaceData.mountRoot}` } : undefined,
        workspaceRuntimeState: exists ? { observed: true, detail: `pvc/${workspaceRuntimeStateVolume} -> ${workspace.attachments.workspaceRuntimeState.mountRoot}` } : undefined,
        userIdentityState: exists ? { observed: true, detail: `pvc/${userIdentityStateVolume} -> ${workspace.attachments.userIdentityState.mountRoot}` } : undefined,
        userSshState: exists ? { observed: true, detail: `pvc/${userSshStateVolume} -> ${workspace.attachments.userSshState.mountRoot}` } : undefined,
      },
      runtimeAssembly: exists && running
        ? {
            home: { observed: true, detail: workspace.runtime.home },
            projectRoot: { observed: true, detail: workspace.attachments.workspaceData.mountRoot },
            managerState: { observed: workspace.agent.enabled && guestReachable, detail: workspace.agent.enabled ? workspace.agent.runtime.stateRoot : "daemon disabled" },
            evolutionState: { observed: workspace.agent.enabled && guestReachable, detail: workspace.agent.enabled ? workspace.agent.runtime.evolutionRoot : "daemon disabled" },
            codex: { observed: cloudInitPresent, detail: workspace.attachments.userIdentityState.mountRoot },
            claude: { observed: cloudInitPresent, detail: workspace.attachments.userIdentityState.mountRoot },
            ssh: { observed: guestReachable, detail: workspace.attachments.userSshState.mountRoot },
          }
        : {},
      daemon: workspace.agent.enabled
        ? {
            manager: exists && running
              ? { observed: cloudInitPresent && guestReachable, detail: cloudInitPresent && guestReachable ? "guest service reachable" : "guest service unreachable" }
              : { observed: false, detail: workspace.agent.runtime.readyFile },
            pairing: pairingObserved,
          }
        : { pairing: pairingObserved },
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
