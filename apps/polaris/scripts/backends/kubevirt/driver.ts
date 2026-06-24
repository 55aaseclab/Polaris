import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import type { BackendDriver } from "../types.js";
import type { BackendObservation, ReconcilePlan, WorkspaceSpec } from "../../core/workspace.js";
import {
  evaluateDaemonStatusObservation,
  evaluatePairingObservation,
  parsePaseoDaemonStatus,
  parseConnectionOfferServerId,
} from "../../core/paseo.js";
import { renderAndWriteKubevirtWorkspace } from "./render.js";
import { runCommand } from "../../utils/shell.js";
import { workspaceDataClaimName } from "../../core/netfs.js";
import { kubevirtProbePassword } from "./probe-access.js";

function hasKubectlVirt(): boolean {
  const result = spawnSync("kubectl", ["virt", "--help"], { encoding: "utf8" });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  return result.status === 0 || !/unknown command "virt"/i.test(output);
}

function waitForPortForwardReady(
  project: string,
  serviceName: string,
  localPort: number,
  remotePort: number,
): Promise<ReturnType<typeof spawn>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "kubectl",
      [
        "-n",
        project,
        "port-forward",
        `svc/${serviceName}`,
        `${localPort}:${remotePort}`,
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
      server.close((error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function shellSingleQuote(input: string): string {
  return `'${input.replace(/'/g, `'\\''`)}'`;
}

async function runKubevirtSshCommand(
  workspace: WorkspaceSpec,
  serviceName: string,
  command: string,
): Promise<{ ok: boolean; stdout: string }> {
  const localPort = await reserveLocalPort();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = await waitForPortForwardReady(
      workspace.identity.projectName,
      serviceName,
      localPort,
      22,
    );
    const result = spawnSync(
      "sshpass",
      [
        "-p",
        kubevirtProbePassword(workspace),
        "ssh",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "PreferredAuthentications=password",
        "-o",
        "PubkeyAuthentication=no",
        "-p",
        String(localPort),
        "root@127.0.0.1",
        `sh -lc ${shellSingleQuote(command)}`,
      ],
      { encoding: "utf8" },
    );
    return {
      ok: result.status === 0,
      stdout: result.status === 0 ? String(result.stdout || "") : "",
    };
  } catch {
    return { ok: false, stdout: "" };
  } finally {
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
  }
}

function normalizeKubevirtCommandRef(
  workspace: WorkspaceSpec,
): string {
  return workspace.agent.runtime.pairingFile ?? "/root/.paseo/pairing.json";
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
    const execCheck = async (command: string): Promise<boolean> => {
      if (!exists || !running || serviceName.length === 0) return false;
      return (await runKubevirtSshCommand(workspace, serviceName, command)).ok;
    };
    const execOutput = async (command: string): Promise<string> => {
      if (!exists || !running || serviceName.length === 0) return "";
      return (await runKubevirtSshCommand(workspace, serviceName, command)).stdout;
    };
    const guestReachable = await execCheck("printf ok");
    const daemonStatusRaw =
      workspace.agent.enabled && guestReachable
        ? await execOutput(`PASEO_HOME=${workspace.agent.runtime.stateRoot} paseo daemon status --json`)
        : "";
    const daemonStatus = parsePaseoDaemonStatus(daemonStatusRaw);
    const persistedServerId =
      workspace.agent.enabled && guestReachable
        ? (await execOutput(`cat ${workspace.agent.runtime.stateRoot}/server-id 2>/dev/null`)).trim() || null
        : null;
    const daemonObserved =
      workspace.agent.enabled && exists && running
        ? evaluateDaemonStatusObservation({
            status: daemonStatus,
            persistedServerId,
            readyFileDetail: workspace.agent.runtime.readyFile ?? "/tmp/.ready",
          })
        : workspace.agent.enabled
          ? { observed: false, detail: workspace.agent.runtime.readyFile ?? "/tmp/.ready" }
          : { observed: true, detail: "daemon not required" };
    const pairingUrl =
      workspace.agent.enabled && guestReachable
        ? extractPairingUrl(await execOutput(`cat ${normalizeKubevirtCommandRef(workspace)} 2>/dev/null`))
        : undefined;
    const pairingObserved =
      workspace.agent.enabled && exists && running
          ? evaluatePairingObservation({
            expectedServerId: daemonStatus?.serverId ?? persistedServerId,
            cachedServerId: pairingUrl ? parseConnectionOfferServerId(pairingUrl) ?? null : null,
            pairingUrl,
            pairingFileDetail: workspace.agent.runtime.pairingFile ?? "/root/.paseo/pairing.json",
          })
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
        workspaceData: exists
          ? { observed: await execCheck(`test -d ${workspace.attachments.workspaceData.mountRoot}`), detail: `pvc/${workspaceDataVolume} -> ${workspace.attachments.workspaceData.mountRoot}` }
          : undefined,
        workspaceRuntimeState: exists
          ? { observed: await execCheck(`test -d ${workspace.attachments.workspaceRuntimeState.mountRoot}`), detail: `pvc/${workspaceRuntimeStateVolume} -> ${workspace.attachments.workspaceRuntimeState.mountRoot}` }
          : undefined,
        userIdentityState: exists
          ? { observed: await execCheck(`test -d ${workspace.attachments.userIdentityState.mountRoot}`), detail: `pvc/${userIdentityStateVolume} -> ${workspace.attachments.userIdentityState.mountRoot}` }
          : undefined,
        userSshState: exists
          ? { observed: await execCheck(`test -d ${workspace.attachments.userSshState.mountRoot}`), detail: `pvc/${userSshStateVolume} -> ${workspace.attachments.userSshState.mountRoot}` }
          : undefined,
      },
      runtimeAssembly: exists && running
        ? {
            home: { observed: await execCheck(`test -d ${workspace.runtime.home}`), detail: workspace.runtime.home },
            projectRoot: { observed: await execCheck(`test -L ${workspace.runtime.home}/workspace || test -L ${workspace.runtime.home}/${workspace.profile.workspaceAlias ?? "workspace"}`), detail: `${workspace.runtime.home}/workspace` },
            managerState: { observed: await execCheck(`test -L ${workspace.runtime.home}/.paseo`), detail: workspace.agent.runtime.stateRoot },
            evolutionState: { observed: await execCheck(`test -d ${workspace.agent.runtime.evolutionRoot}`), detail: workspace.agent.runtime.evolutionRoot },
            codex: { observed: await execCheck(`test -L ${workspace.runtime.home}/.codex`), detail: `${workspace.runtime.home}/.codex` },
            claude: { observed: await execCheck(`test -L ${workspace.runtime.home}/.claude`), detail: `${workspace.runtime.home}/.claude` },
            ssh: { observed: await execCheck(`test -L ${workspace.runtime.home}/.ssh || test -d ${workspace.runtime.home}/.ssh`), detail: `${workspace.runtime.home}/.ssh` },
          }
        : {},
      daemon: workspace.agent.enabled
        ? {
            manager: exists && running
              ? daemonObserved
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
