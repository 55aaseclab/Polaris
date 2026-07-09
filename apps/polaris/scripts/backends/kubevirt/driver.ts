import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import type { BackendDriver } from "../types.js";
import type { BackendObservation, ReconcilePlan, WorkspaceSpec } from "../../core/workspace.js";
import { renderAndWriteKubevirtWorkspace } from "./render.js";
import { runCommand } from "../../utils/shell.js";
import { workspaceDataClaimName } from "../../core/netfs.js";
import { kubevirtProbePassword } from "./probe-access.js";
import {
  workspaceRuntimeResourceName,
  workspaceRuntimeScopeName,
} from "../../core/workspace-name.js";

function hasKubectlVirt(): boolean {
  const result = spawnSync("kubectl", ["virt", "--help"], { encoding: "utf8" });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  return result.status === 0 || !/unknown command "virt"/i.test(output);
}

function terminateChildProcess(child: ReturnType<typeof spawn>): void {
  if (child.killed) {
    return;
  }
  if (typeof child.pid !== "number") {
    child.kill("SIGTERM");
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall back to the direct child kill path below.
    }
  }
  child.kill("SIGTERM");
}

function runtimeScope(workspace: WorkspaceSpec): string {
  return workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName);
}

function vmName(workspace: WorkspaceSpec): string {
  return workspaceRuntimeResourceName(workspace.userProfile.id, workspace.identity.projectName, "vm");
}

function cloudInitSecretName(workspace: WorkspaceSpec): string {
  return workspaceRuntimeResourceName(
    workspace.userProfile.id,
    workspace.identity.projectName,
    "vm-cloudinit",
  );
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
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      terminateChildProcess(child);
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

function kubevirtProbeShellCommand(command: string): string {
  const wrapped = [
    "set -euo pipefail",
    command,
  ].join("\n");
  return `bash -lc ${shellSingleQuote(wrapped)}`;
}

function kubevirtNodeSshEndpoint(
  workspace: WorkspaceSpec,
  serviceName: string,
): { host: string; port: number } | null {
  const vmiNode = spawnSync(
    "kubectl",
    [
      "-n",
      runtimeScope(workspace),
      "get",
      "vmi",
      vmName(workspace),
      "-o",
      "jsonpath={.status.nodeName}",
    ],
    { encoding: "utf8" },
  );
  const nodeName = String(vmiNode.stdout || "").trim();
  if (vmiNode.status !== 0 || !nodeName) {
    return null;
  }
  const nodeAddress = spawnSync(
    "kubectl",
    [
      "get",
      "node",
      nodeName,
      "-o",
      "jsonpath={.status.addresses[?(@.type==\"InternalIP\")].address}",
    ],
    { encoding: "utf8" },
  );
  const host = String(nodeAddress.stdout || "").trim();
  if (nodeAddress.status !== 0 || !host) {
    return null;
  }
  const sshPort = spawnSync(
    "kubectl",
    [
      "-n",
      runtimeScope(workspace),
      "get",
      "svc",
      serviceName,
      "-o",
      "jsonpath={.spec.ports[?(@.name==\"ssh\")].nodePort}",
    ],
    { encoding: "utf8" },
  );
  const portText = String(sshPort.stdout || "").trim();
  const port = Number(portText);
  if (sshPort.status !== 0 || !Number.isInteger(port) || port <= 0) {
    return null;
  }
  return { host, port };
}

function runKubevirtSshPass(args: {
  host: string;
  port: number;
  workspace: WorkspaceSpec;
  command: string;
  timeoutMs?: number;
}): { ok: boolean; stdout: string } {
  const result = spawnSync(
    "sshpass",
    [
      "-p",
      kubevirtProbePassword(args.workspace),
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
      String(args.port),
      `root@${args.host}`,
      kubevirtProbeShellCommand(args.command),
    ],
    {
      encoding: "utf8",
      timeout: args.timeoutMs ?? 15000,
      killSignal: "SIGTERM",
    },
  );
  return {
    ok: result.status === 0,
    stdout: result.status === 0 ? String(result.stdout || "") : "",
  };
}

async function runKubevirtSshCommand(
  workspace: WorkspaceSpec,
  serviceName: string,
  command: string,
  timeoutMs?: number,
): Promise<{ ok: boolean; stdout: string }> {
  const directEndpoint = kubevirtNodeSshEndpoint(workspace, serviceName);
  if (directEndpoint) {
    const directResult = runKubevirtSshPass({
      host: directEndpoint.host,
      port: directEndpoint.port,
      workspace,
      command,
      timeoutMs,
    });
    if (directResult.ok) {
      return directResult;
    }
  }

  const localPort = await reserveLocalPort();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = await waitForPortForwardReady(
      runtimeScope(workspace),
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
        kubevirtProbeShellCommand(command),
      ],
      {
        encoding: "utf8",
        timeout: timeoutMs ?? 15000,
        killSignal: "SIGTERM",
      },
    );
    return {
      ok: result.status === 0,
      stdout: result.status === 0 ? String(result.stdout || "") : "",
    };
  } catch {
    return { ok: false, stdout: "" };
  } finally {
    if (child && !child.killed) {
      terminateChildProcess(child);
    }
  }
}

async function waitForKubevirtSshReachable(
  workspace: WorkspaceSpec,
  serviceName: string,
  timeoutMs = 120000,
  intervalMs = 2000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await runKubevirtSshCommand(workspace, serviceName, "true");
    if (result.ok) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`KubeVirt SSH probe did not become reachable for ${workspace.identity.projectName} within ${timeoutMs}ms`);
}

async function ensureKubevirtGuestRuntime(
  workspace: WorkspaceSpec,
): Promise<void> {
  const serviceName = kubevirtServiceName(workspace);
  if (!serviceName) {
    throw new Error(`No KubeVirt service found for ${workspace.identity.projectName}`);
  }
  await waitForKubevirtSshReachable(workspace, serviceName);

  const waitForDaemonReady = async (timeoutMs: number): Promise<boolean> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const readyCheck = await runKubevirtSshCommand(
        workspace,
        serviceName,
        [
          "set -eu",
          `test -s ${workspace.agent.runtime.stateRoot}/server-id`,
          `test -f ${normalizeKubevirtCommandRef(workspace)}`,
          `grep -q '"url"[[:space:]]*:' ${normalizeKubevirtCommandRef(workspace)}`,
        ].join("\n"),
        10000,
      );
      if (readyCheck.ok) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return false;
  };

  if (await waitForDaemonReady(120000)) {
    return;
  }

  const result = await runKubevirtSshCommand(
    workspace,
    serviceName,
    "systemctl restart polaris-runtime-bootstrap.service",
    300000,
  );
  if (!result.ok) {
    throw new Error(`Failed to restart Polaris runtime bootstrap in VM ${workspace.identity.projectName}`);
  }

  if (await waitForDaemonReady(120000)) {
    return;
  }

  throw new Error(`Polaris runtime bootstrap did not make the daemon ready in VM ${workspace.identity.projectName}`);
}

interface KubevirtRuntimeSnapshot {
  guestReachable: boolean;
  persistedServerId: string | null;
  pairingRaw: string;
  workspaceDataObserved: boolean;
  workspaceRuntimeObserved: boolean;
  userIdentityObserved: boolean;
  homeObserved: boolean;
  projectRootObserved: boolean;
  managerStateObserved: boolean;
  evolutionStateObserved: boolean;
  codexObserved: boolean;
  claudeObserved: boolean;
  sshObserved: boolean;
}

async function collectKubevirtRuntimeSnapshot(
  workspace: WorkspaceSpec,
  serviceName: string,
): Promise<KubevirtRuntimeSnapshot> {
  const command = [
    "set -eu",
    "printf 'guestReachable=1\\n'",
    "printf 'persistedServerId<<EOF\\n'",
    `cat ${workspace.agent.runtime.stateRoot}/server-id 2>/dev/null || true`,
    "printf 'EOF\\n'",
    "printf 'pairingRaw<<EOF\\n'",
    `cat ${normalizeKubevirtCommandRef(workspace)} 2>/dev/null || true`,
    "printf 'EOF\\n'",
    `test -d ${workspace.attachments.workspaceData.mountRoot} && echo workspaceDataObserved=1 || echo workspaceDataObserved=0`,
    `test -d ${workspace.attachments.workspaceRuntimeState.mountRoot} && echo workspaceRuntimeObserved=1 || echo workspaceRuntimeObserved=0`,
    `test -d ${workspace.attachments.userIdentityState.mountRoot} && echo userIdentityObserved=1 || echo userIdentityObserved=0`,
    `test -d ${workspace.runtime.home} && echo homeObserved=1 || echo homeObserved=0`,
    `if test -L ${workspace.runtime.home}/workspace || test -L ${workspace.runtime.home}/${workspace.profile.workspaceAlias ?? "workspace"}; then echo projectRootObserved=1; else echo projectRootObserved=0; fi`,
    `test -L ${workspace.runtime.home}/.paseo && echo managerStateObserved=1 || echo managerStateObserved=0`,
    `test -d ${workspace.agent.runtime.evolutionRoot} && echo evolutionStateObserved=1 || echo evolutionStateObserved=0`,
    `test -L ${workspace.runtime.home}/.codex && echo codexObserved=1 || echo codexObserved=0`,
    `test -L ${workspace.runtime.home}/.claude && echo claudeObserved=1 || echo claudeObserved=0`,
    `if test -L ${workspace.runtime.home}/.ssh || test -d ${workspace.runtime.home}/.ssh; then echo sshObserved=1; else echo sshObserved=0; fi`,
  ].join("\n");
  const result = await runKubevirtSshCommand(workspace, serviceName, command);
  if (!result.ok) {
    return {
      guestReachable: false,
      persistedServerId: null,
      pairingRaw: "",
      workspaceDataObserved: false,
      workspaceRuntimeObserved: false,
      userIdentityObserved: false,
      homeObserved: false,
      projectRootObserved: false,
      managerStateObserved: false,
      evolutionStateObserved: false,
      codexObserved: false,
      claudeObserved: false,
      sshObserved: false,
    };
  }
  const lines = result.stdout.split(/\r?\n/);
  const scalars = new Map<string, string>();
  const blocks = new Map<string, string>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const blockMatch = line.match(/^([A-Za-z0-9_]+)<<EOF$/);
    if (blockMatch) {
      const key = blockMatch[1] ?? "";
      const content: string[] = [];
      i += 1;
      while (i < lines.length && lines[i] !== "EOF") {
        content.push(lines[i] ?? "");
        i += 1;
      }
      blocks.set(key, content.join("\n").trim());
      continue;
    }
    const scalarMatch = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (scalarMatch) {
      scalars.set(scalarMatch[1] ?? "", scalarMatch[2] ?? "");
    }
  }
  const flag = (key: string): boolean => scalars.get(key) === "1";
  const block = (key: string): string => blocks.get(key) ?? "";
  return {
    guestReachable: flag("guestReachable"),
    persistedServerId: block("persistedServerId") || null,
    pairingRaw: block("pairingRaw"),
    workspaceDataObserved: flag("workspaceDataObserved"),
    workspaceRuntimeObserved: flag("workspaceRuntimeObserved"),
    userIdentityObserved: flag("userIdentityObserved"),
    homeObserved: flag("homeObserved"),
    projectRootObserved: flag("projectRootObserved"),
    managerStateObserved: flag("managerStateObserved"),
    evolutionStateObserved: flag("evolutionStateObserved"),
    codexObserved: flag("codexObserved"),
    claudeObserved: flag("claudeObserved"),
    sshObserved: flag("sshObserved"),
  };
}

export async function readKubevirtPersistedPaseoState(workspace: WorkspaceSpec): Promise<{
  serverId: string;
  pairing: Record<string, unknown> & { url: string };
} | null> {
  const service = spawnSync(
    "kubectl",
    ["-n", runtimeScope(workspace), "get", "svc", runtimeScope(workspace), "-o", "jsonpath={.metadata.name}"],
    { encoding: "utf8" },
  );
  const serviceName = String(service.stdout || "").trim();
  if (service.status !== 0 || !serviceName) {
    return null;
  }
  const snapshot = await collectKubevirtRuntimeSnapshot(workspace, serviceName);
  if (!snapshot.guestReachable || !snapshot.persistedServerId) {
    return null;
  }
  try {
    const pairing = JSON.parse(snapshot.pairingRaw) as Record<string, unknown>;
    return typeof pairing.url === "string" && pairing.url.trim()
      ? {
          serverId: snapshot.persistedServerId,
          pairing: {
            ...pairing,
            url: pairing.url.trim(),
          },
        }
      : null;
  } catch {
    return null;
  }
}

function normalizeKubevirtCommandRef(
  workspace: WorkspaceSpec,
): string {
  return workspace.agent.runtime.pairingFile ?? "/root/.paseo/pairing.json";
}

function patchVmRunStrategy(workspace: WorkspaceSpec, runStrategy: "Always" | "Halted"): void {
  runCommand("kubectl", [
    "-n",
    runtimeScope(workspace),
    "patch",
    "vm",
    vmName(workspace),
    "--type=merge",
    "-p",
    JSON.stringify({ spec: { runStrategy } }),
  ]);
}

function runVmLifecycleAction(workspace: WorkspaceSpec, action: "start" | "stop" | "restart"): void {
  if (hasKubectlVirt()) {
    runCommand("kubectl", ["virt", action, "-n", runtimeScope(workspace), vmName(workspace)]);
    return;
  }
  if (action === "start") {
    patchVmRunStrategy(workspace, "Always");
    return;
  }
  if (action === "stop") {
    patchVmRunStrategy(workspace, "Halted");
    return;
  }
  patchVmRunStrategy(workspace, "Halted");
  patchVmRunStrategy(workspace, "Always");
}

function extractPairingUrl(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { url?: unknown };
    return typeof parsed.url === "string" && parsed.url.trim() ? parsed.url.trim() : undefined;
  } catch {
    return undefined;
  }
}

function kubevirtServiceName(workspace: WorkspaceSpec): string | null {
  const service = spawnSync(
    "kubectl",
    ["-n", runtimeScope(workspace), "get", "svc", runtimeScope(workspace), "-o", "jsonpath={.metadata.name}"],
    { encoding: "utf8" },
  );
  const name = (service.stdout || "").trim();
  return service.status === 0 && name ? name : null;
}

async function syncKubevirtGuestState(
  workspace: WorkspaceSpec,
  mode: "sync-in" | "sync-out",
): Promise<void> {
  const vmi = spawnSync(
    "kubectl",
    ["-n", runtimeScope(workspace), "get", "vmi", vmName(workspace), "-o", "jsonpath={.status.phase}"],
    { encoding: "utf8" },
  );
  if ((vmi.stdout || "").trim() !== "Running") {
    return;
  }
  const serviceName = kubevirtServiceName(workspace);
  if (!serviceName) {
    return;
  }
  const command = `if ! command -v rsync >/dev/null 2>&1; then exit 0; fi
if ! test -x /usr/local/bin/polaris-sync-shared-state; then exit 0; fi
/usr/local/bin/polaris-sync-shared-state ${mode}`;
  const result = await runKubevirtSshCommand(
    workspace,
    serviceName,
    command,
  );
  if (!result.ok) {
    throw new Error(`Failed to ${mode} VM shared state for ${workspace.identity.projectName}`);
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
    runVmLifecycleAction(workspace, "start");
    await ensureKubevirtGuestRuntime(workspace);
  }

  async stop(workspace: WorkspaceSpec): Promise<void> {
    await syncKubevirtGuestState(workspace, "sync-out");
    runVmLifecycleAction(workspace, "stop");
  }

  async restart(workspace: WorkspaceSpec): Promise<void> {
    await syncKubevirtGuestState(workspace, "sync-out");
    runVmLifecycleAction(workspace, "restart");
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
      ["-n", runtimeScope(workspace), "get", "pod", "-l", `vm.kubevirt.io/name=${vmName(workspace)}`, "-o", "jsonpath={.items[0].metadata.name}"],
      { encoding: "utf8" },
    );
    const podName = (launcher.stdout || "").trim();
    if (!podName) {
      throw new Error(`No KubeVirt launcher pod found for ${workspace.identity.projectName}`);
    }
    runCommand("kubectl", ["-n", runtimeScope(workspace), "logs", podName, "--tail=200"]);
  }

  async inspect(workspace: WorkspaceSpec): Promise<BackendObservation> {
    const vm = spawnSync(
      "kubectl",
      ["-n", runtimeScope(workspace), "get", "vm", vmName(workspace), "-o", "jsonpath={.metadata.name}"],
      { encoding: "utf8" },
    );
    const exists = vm.status === 0 && Boolean((vm.stdout || "").trim());
    const vmi = exists
      ? spawnSync("kubectl", ["-n", runtimeScope(workspace), "get", "vmi", vmName(workspace), "-o", "jsonpath={.status.phase}"], { encoding: "utf8" })
      : { status: 1, stdout: "", stderr: "" };
    const phase = (vmi.stdout || "").trim();
    const running = phase === "Running";
    const service = workspace.connectivity.servicePorts.length
      ? spawnSync("kubectl", ["-n", runtimeScope(workspace), "get", "svc", runtimeScope(workspace), "-o", "jsonpath={.metadata.name}"], { encoding: "utf8" })
      : { status: 0, stdout: "", stderr: "" };
    const serviceName = (service.stdout || "").trim();
    const serviceCount = serviceName ? 1 : 0;
    const cloudInit = spawnSync(
      "kubectl",
      ["-n", runtimeScope(workspace), "get", "secret", cloudInitSecretName(workspace), "-o", "jsonpath={.metadata.name}"],
      { encoding: "utf8" },
    );
    const cloudInitPresent = cloudInit.status === 0 && Boolean((cloudInit.stdout || "").trim());
    const workspaceDataVolume = workspaceDataClaimName(workspace);
    const workspaceRuntimeStateVolume =
      workspace.attachments.workspaceRuntimeState.source.volumeRef ??
      workspace.storage.claimName;
    const userIdentityStateVolume =
      workspace.attachments.userIdentityState.source.volumeRef ?? "missing";
    const runtimeSnapshot =
      exists && running && serviceName.length > 0
        ? await collectKubevirtRuntimeSnapshot(workspace, serviceName)
        : null;
    const guestReachable = runtimeSnapshot?.guestReachable ?? false;
    const persistedServerId =
      workspace.agent.enabled && guestReachable
        ? runtimeSnapshot?.persistedServerId ?? null
        : null;
    const pairingUrl =
      workspace.agent.enabled && guestReachable
        ? extractPairingUrl(runtimeSnapshot?.pairingRaw ?? "")
        : undefined;
    return {
      backend: {
        kind: workspace.backend.kind,
        exists,
        running,
        detail: exists ? (running ? `vmi phase ${phase}` : `vm exists, vmi phase ${phase || "missing"}`) : "vm object missing",
      },
      attachments: {
        workspaceData: exists
          ? { observed: runtimeSnapshot?.workspaceDataObserved ?? false, detail: `pvc/${workspaceDataVolume} -> ${workspace.attachments.workspaceData.mountRoot}` }
          : undefined,
        workspaceRuntimeState: exists
          ? { observed: runtimeSnapshot?.workspaceRuntimeObserved ?? false, detail: `pvc/${workspaceRuntimeStateVolume} -> ${workspace.attachments.workspaceRuntimeState.mountRoot}` }
          : undefined,
        userIdentityState: exists
          ? { observed: runtimeSnapshot?.userIdentityObserved ?? false, detail: `pvc/${userIdentityStateVolume} -> ${workspace.attachments.userIdentityState.mountRoot}` }
          : undefined,
      },
      workspaceAssembly: exists && running
        ? {
            home: { observed: runtimeSnapshot?.homeObserved ?? false, detail: workspace.runtime.home },
            projectRoot: { observed: runtimeSnapshot?.projectRootObserved ?? false, detail: `${workspace.runtime.home}/workspace` },
            managerState: { observed: runtimeSnapshot?.managerStateObserved ?? false, detail: workspace.agent.runtime.stateRoot },
            evolutionState: { observed: runtimeSnapshot?.evolutionStateObserved ?? false, detail: workspace.agent.runtime.evolutionRoot },
            codex: { observed: runtimeSnapshot?.codexObserved ?? false, detail: `${workspace.runtime.home}/.codex` },
            claude: { observed: runtimeSnapshot?.claudeObserved ?? false, detail: `${workspace.runtime.home}/.claude` },
            ssh: { observed: runtimeSnapshot?.sshObserved ?? false, detail: `${workspace.runtime.home}/.ssh` },
          }
        : {},
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
        await syncKubevirtGuestState(workspace, "sync-out");
        runVmLifecycleAction(workspace, "restart");
        continue;
      }
      if (action.kind === "repair-runtime-assembly" || action.kind === "clean-ephemeral-runtime") {
        await syncKubevirtGuestState(workspace, "sync-out");
        runVmLifecycleAction(workspace, "restart");
        continue;
      }
      if (action.kind === "report-unrecoverable-drift") {
        throw new Error(action.reason || "kubevirt backend cannot repair workspace drift");
      }
    }
  }
}
