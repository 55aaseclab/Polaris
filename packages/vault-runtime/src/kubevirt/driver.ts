import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import type {
  BackendDriver,
  BackendObservation,
  ReconcilePlan,
  RuntimeDriverDependencies,
  VaultRuntimeSpec,
} from "../types.js";
import { renderKubevirtVault } from "./render.js";
import { vaultDataClaimName } from "../core/netfs.js";
import { defaultRuntimeDriverDependencies } from "../runtime-deps.js";
import {
  vaultRuntimeResourceName,
  vaultRuntimeScopeName,
} from "../core/vault-name.js";

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

function runtimeScope(vault: VaultRuntimeSpec): string {
  return vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName);
}

function privateSurfaceEnabled(vault: VaultRuntimeSpec): boolean {
  return Boolean(vault.integration.privateSurface);
}

function privateSurfaceDeploymentName(vault: VaultRuntimeSpec): string {
  return vaultRuntimeResourceName(
    vault.userProfile.id,
    vault.identity.projectName,
    vault.integration.privateSurface?.id ?? "surface",
  );
}

function scalePrivateSurfaceDeployment(
  vault: VaultRuntimeSpec,
  replicas: 0 | 1,
  dependencies: RuntimeDriverDependencies,
): void {
  if (!privateSurfaceEnabled(vault)) {
    return;
  }
  dependencies.runCommand("kubectl", [
    "-n",
    runtimeScope(vault),
    "scale",
    "deployment",
    privateSurfaceDeploymentName(vault),
    `--replicas=${replicas}`,
  ]);
}

function vmName(vault: VaultRuntimeSpec): string {
  return vaultRuntimeResourceName(vault.userProfile.id, vault.identity.projectName, "vm");
}

function cloudInitSecretName(vault: VaultRuntimeSpec): string {
  return vaultRuntimeResourceName(
    vault.userProfile.id,
    vault.identity.projectName,
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
  vault: VaultRuntimeSpec,
  serviceName: string,
): { host: string; port: number } | null {
  const vmiNode = spawnSync(
    "kubectl",
    [
      "-n",
      runtimeScope(vault),
      "get",
      "vmi",
      vmName(vault),
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
      runtimeScope(vault),
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
  vault: VaultRuntimeSpec;
  command: string;
  timeoutMs?: number;
}): { ok: boolean; stdout: string } {
  const result = spawnSync(
    "sshpass",
    [
      "-p",
      args.vault.integration.kubevirtProbePassword,
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
  vault: VaultRuntimeSpec,
  serviceName: string,
  command: string,
  timeoutMs?: number,
): Promise<{ ok: boolean; stdout: string }> {
  const directEndpoint = kubevirtNodeSshEndpoint(vault, serviceName);
  if (directEndpoint) {
    const directResult = runKubevirtSshPass({
      host: directEndpoint.host,
      port: directEndpoint.port,
      vault,
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
      runtimeScope(vault),
      serviceName,
      localPort,
      22,
    );
    const result = spawnSync(
      "sshpass",
      [
        "-p",
        vault.integration.kubevirtProbePassword,
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
  vault: VaultRuntimeSpec,
  serviceName: string,
  timeoutMs = 120000,
  intervalMs = 2000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await runKubevirtSshCommand(vault, serviceName, "true");
    if (result.ok) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`KubeVirt SSH probe did not become reachable for ${vault.identity.projectName} within ${timeoutMs}ms`);
}

async function ensureKubevirtGuestRuntime(
  vault: VaultRuntimeSpec,
): Promise<void> {
  const serviceName = kubevirtServiceName(vault);
  if (!serviceName) {
    throw new Error(`No KubeVirt service found for ${vault.identity.projectName}`);
  }
  await waitForKubevirtSshReachable(vault, serviceName);

  const waitForDaemonReady = async (timeoutMs: number): Promise<boolean> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const readyCheck = await runKubevirtSshCommand(
        vault,
        serviceName,
        [
          "set -eu",
          `test -s ${vault.agent.runtime.stateRoot}/server-id`,
          `test -f ${normalizeKubevirtCommandRef(vault)}`,
          `grep -q '"url"[[:space:]]*:' ${normalizeKubevirtCommandRef(vault)}`,
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
    vault,
    serviceName,
    "systemctl restart polaris-runtime-bootstrap.service",
    300000,
  );
  if (!result.ok) {
    throw new Error(`Failed to restart Polaris runtime bootstrap in VM ${vault.identity.projectName}`);
  }

  if (await waitForDaemonReady(120000)) {
    return;
  }

  throw new Error(`Polaris runtime bootstrap did not make the daemon ready in VM ${vault.identity.projectName}`);
}

interface KubevirtRuntimeSnapshot {
  guestReachable: boolean;
  persistedServerId: string | null;
  pairingRaw: string;
  vaultDataObserved: boolean;
  vaultRuntimeObserved: boolean;
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
  vault: VaultRuntimeSpec,
  serviceName: string,
): Promise<KubevirtRuntimeSnapshot> {
  const command = [
    "set -eu",
    "printf 'guestReachable=1\\n'",
    "printf 'persistedServerId<<EOF\\n'",
    `cat ${vault.agent.runtime.stateRoot}/server-id 2>/dev/null || true`,
    "printf 'EOF\\n'",
    "printf 'pairingRaw<<EOF\\n'",
    `cat ${normalizeKubevirtCommandRef(vault)} 2>/dev/null || true`,
    "printf 'EOF\\n'",
    `test -d ${vault.attachments.vaultData.mountRoot} && echo vaultDataObserved=1 || echo vaultDataObserved=0`,
    `test -d ${vault.attachments.vaultRuntimeState.mountRoot} && echo vaultRuntimeObserved=1 || echo vaultRuntimeObserved=0`,
    `test -d ${vault.attachments.userIdentityState.mountRoot} && echo userIdentityObserved=1 || echo userIdentityObserved=0`,
    `test -d ${vault.runtime.home} && echo homeObserved=1 || echo homeObserved=0`,
    `if test -L ${vault.runtime.home}/vault || test -L ${vault.runtime.home}/${vault.profile.vaultAlias ?? "vault"}; then echo projectRootObserved=1; else echo projectRootObserved=0; fi`,
    `test -L ${vault.runtime.home}/.paseo && echo managerStateObserved=1 || echo managerStateObserved=0`,
    `test -d ${vault.agent.runtime.evolutionRoot} && echo evolutionStateObserved=1 || echo evolutionStateObserved=0`,
    `test -L ${vault.runtime.home}/.codex && echo codexObserved=1 || echo codexObserved=0`,
    `test -L ${vault.runtime.home}/.claude && echo claudeObserved=1 || echo claudeObserved=0`,
    `if test -L ${vault.runtime.home}/.ssh || test -d ${vault.runtime.home}/.ssh; then echo sshObserved=1; else echo sshObserved=0; fi`,
  ].join("\n");
  const result = await runKubevirtSshCommand(vault, serviceName, command);
  if (!result.ok) {
    return {
      guestReachable: false,
      persistedServerId: null,
      pairingRaw: "",
      vaultDataObserved: false,
      vaultRuntimeObserved: false,
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
    vaultDataObserved: flag("vaultDataObserved"),
    vaultRuntimeObserved: flag("vaultRuntimeObserved"),
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

export async function readKubevirtPersistedPaseoState(vault: VaultRuntimeSpec): Promise<{
  serverId: string;
  pairing: Record<string, unknown> & { url: string };
} | null> {
  const service = spawnSync(
    "kubectl",
    ["-n", runtimeScope(vault), "get", "svc", runtimeScope(vault), "-o", "jsonpath={.metadata.name}"],
    { encoding: "utf8" },
  );
  const serviceName = String(service.stdout || "").trim();
  if (service.status !== 0 || !serviceName) {
    return null;
  }
  const snapshot = await collectKubevirtRuntimeSnapshot(vault, serviceName);
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
  vault: VaultRuntimeSpec,
): string {
  return vault.agent.runtime.pairingFile ?? "/root/.paseo/pairing.json";
}

function patchVmRunStrategy(
  vault: VaultRuntimeSpec,
  runStrategy: "Always" | "Halted",
  dependencies: RuntimeDriverDependencies,
): void {
  dependencies.runCommand("kubectl", [
    "-n",
    runtimeScope(vault),
    "patch",
    "vm",
    vmName(vault),
    "--type=merge",
    "-p",
    JSON.stringify({ spec: { runStrategy } }),
  ]);
}

function runVmLifecycleAction(
  vault: VaultRuntimeSpec,
  action: "start" | "stop" | "restart",
  dependencies: RuntimeDriverDependencies,
): void {
  if (hasKubectlVirt()) {
    dependencies.runCommand("kubectl", ["virt", action, "-n", runtimeScope(vault), vmName(vault)]);
    return;
  }
  if (action === "start") {
    patchVmRunStrategy(vault, "Always", dependencies);
    return;
  }
  if (action === "stop") {
    patchVmRunStrategy(vault, "Halted", dependencies);
    return;
  }
  patchVmRunStrategy(vault, "Halted", dependencies);
  patchVmRunStrategy(vault, "Always", dependencies);
}

function extractPairingUrl(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { url?: unknown };
    return typeof parsed.url === "string" && parsed.url.trim() ? parsed.url.trim() : undefined;
  } catch {
    return undefined;
  }
}

function kubevirtServiceName(vault: VaultRuntimeSpec): string | null {
  const service = spawnSync(
    "kubectl",
    ["-n", runtimeScope(vault), "get", "svc", runtimeScope(vault), "-o", "jsonpath={.metadata.name}"],
    { encoding: "utf8" },
  );
  const name = (service.stdout || "").trim();
  return service.status === 0 && name ? name : null;
}

async function syncKubevirtGuestState(
  vault: VaultRuntimeSpec,
  mode: "sync-in" | "sync-out",
): Promise<void> {
  const vmi = spawnSync(
    "kubectl",
    ["-n", runtimeScope(vault), "get", "vmi", vmName(vault), "-o", "jsonpath={.status.phase}"],
    { encoding: "utf8" },
  );
  if ((vmi.stdout || "").trim() !== "Running") {
    return;
  }
  const serviceName = kubevirtServiceName(vault);
  if (!serviceName) {
    return;
  }
  const command = `if ! command -v rsync >/dev/null 2>&1; then exit 0; fi
if ! test -x /usr/local/bin/polaris-sync-shared-state; then exit 0; fi
/usr/local/bin/polaris-sync-shared-state ${mode}`;
  const result = await runKubevirtSshCommand(
    vault,
    serviceName,
    command,
  );
  if (!result.ok) {
    throw new Error(`Failed to ${mode} VM shared state for ${vault.identity.projectName}`);
  }
}

export class KubevirtDriver implements BackendDriver {
  readonly kind = "kubevirt-vm" as const;

  private readonly dependencies: RuntimeDriverDependencies;

  constructor(dependencies: RuntimeDriverDependencies = defaultRuntimeDriverDependencies()) {
    this.dependencies = dependencies;
  }

  async create(vault: VaultRuntimeSpec): Promise<void> {
    this.dependencies.writeManifest(vault, renderKubevirtVault(vault));
  }

  async start(vault: VaultRuntimeSpec): Promise<void> {
    const outputPath = this.dependencies.writeManifest(vault, renderKubevirtVault(vault));
    this.dependencies.runCommand("kubectl", ["apply", "-f", outputPath]);
    runVmLifecycleAction(vault, "start", this.dependencies);
    await ensureKubevirtGuestRuntime(vault);
  }

  async stop(vault: VaultRuntimeSpec): Promise<void> {
    await syncKubevirtGuestState(vault, "sync-out");
    runVmLifecycleAction(vault, "stop", this.dependencies);
    scalePrivateSurfaceDeployment(vault, 0, this.dependencies);
  }

  async restart(vault: VaultRuntimeSpec): Promise<void> {
    await syncKubevirtGuestState(vault, "sync-out");
    runVmLifecycleAction(vault, "restart", this.dependencies);
  }

  async rebuild(vault: VaultRuntimeSpec): Promise<void> {
    this.dependencies.writeManifest(vault, renderKubevirtVault(vault));
  }

  async render(vault: VaultRuntimeSpec): Promise<void> {
    this.dependencies.writeManifest(vault, renderKubevirtVault(vault));
  }

  async apply(vault: VaultRuntimeSpec): Promise<void> {
    const outputPath = this.dependencies.writeManifest(vault, renderKubevirtVault(vault));
    this.dependencies.runCommand("kubectl", ["apply", "-f", outputPath]);
  }

  async logs(vault: VaultRuntimeSpec): Promise<void> {
    const launcher = spawnSync(
      "kubectl",
      ["-n", runtimeScope(vault), "get", "pod", "-l", `vm.kubevirt.io/name=${vmName(vault)}`, "-o", "jsonpath={.items[0].metadata.name}"],
      { encoding: "utf8" },
    );
    const podName = (launcher.stdout || "").trim();
    if (!podName) {
      throw new Error(`No KubeVirt launcher pod found for ${vault.identity.projectName}`);
    }
    this.dependencies.runCommand("kubectl", ["-n", runtimeScope(vault), "logs", podName, "--tail=200"]);
  }

  async inspect(vault: VaultRuntimeSpec): Promise<BackendObservation> {
    const vm = spawnSync(
      "kubectl",
      ["-n", runtimeScope(vault), "get", "vm", vmName(vault), "-o", "jsonpath={.metadata.name}"],
      { encoding: "utf8" },
    );
    const exists = vm.status === 0 && Boolean((vm.stdout || "").trim());
    const vmi = exists
      ? spawnSync("kubectl", ["-n", runtimeScope(vault), "get", "vmi", vmName(vault), "-o", "jsonpath={.status.phase}"], { encoding: "utf8" })
      : { status: 1, stdout: "", stderr: "" };
    const phase = (vmi.stdout || "").trim();
    const vmRunning = phase === "Running";
    const surfaceReadiness = exists && vmRunning && privateSurfaceEnabled(vault)
      ? spawnSync(
          "kubectl",
          [
            "-n",
            runtimeScope(vault),
            "get",
            "deployment",
            privateSurfaceDeploymentName(vault),
            "-o",
            "jsonpath={.status.readyReplicas}",
          ],
          { encoding: "utf8" },
        )
      : null;
    const surfaceReady = !privateSurfaceEnabled(vault)
      || (surfaceReadiness?.status === 0 && String(surfaceReadiness.stdout || "").trim() === "1");
    const running = vmRunning && surfaceReady;
    const service = vault.connectivity.servicePorts.length
      ? spawnSync("kubectl", ["-n", runtimeScope(vault), "get", "svc", runtimeScope(vault), "-o", "jsonpath={.metadata.name}"], { encoding: "utf8" })
      : { status: 0, stdout: "", stderr: "" };
    const serviceName = (service.stdout || "").trim();
    const serviceCount = serviceName ? 1 : 0;
    const cloudInit = spawnSync(
      "kubectl",
      ["-n", runtimeScope(vault), "get", "secret", cloudInitSecretName(vault), "-o", "jsonpath={.metadata.name}"],
      { encoding: "utf8" },
    );
    const cloudInitPresent = cloudInit.status === 0 && Boolean((cloudInit.stdout || "").trim());
    const vaultDataVolume = vaultDataClaimName(vault);
    const vaultRuntimeStateVolume =
      vault.attachments.vaultRuntimeState.source.volumeRef ??
      vault.storage.claimName;
    const userIdentityStateVolume =
      vault.attachments.userIdentityState.source.volumeRef ?? "missing";
    const runtimeSnapshot =
      exists && running && serviceName.length > 0
        ? await collectKubevirtRuntimeSnapshot(vault, serviceName)
        : null;
    const guestReachable = runtimeSnapshot?.guestReachable ?? false;
    const persistedServerId =
      vault.agent.enabled && guestReachable
        ? runtimeSnapshot?.persistedServerId ?? null
        : null;
    const pairingUrl =
      vault.agent.enabled && guestReachable
        ? extractPairingUrl(runtimeSnapshot?.pairingRaw ?? "")
        : undefined;
    return {
      backend: {
        kind: vault.backend.kind,
        exists,
        running,
        detail: exists
          ? (running
            ? `vmi phase ${phase}`
            : privateSurfaceEnabled(vault) && vmRunning
              ? "vm is running but the private surface deployment is not ready"
              : `vm exists, vmi phase ${phase || "missing"}`)
          : "vm object missing",
      },
      attachments: {
        vaultData: exists
          ? { observed: runtimeSnapshot?.vaultDataObserved ?? false, detail: `pvc/${vaultDataVolume} -> ${vault.attachments.vaultData.mountRoot}` }
          : undefined,
        vaultRuntimeState: exists
          ? { observed: runtimeSnapshot?.vaultRuntimeObserved ?? false, detail: `pvc/${vaultRuntimeStateVolume} -> ${vault.attachments.vaultRuntimeState.mountRoot}` }
          : undefined,
        userIdentityState: exists
          ? { observed: runtimeSnapshot?.userIdentityObserved ?? false, detail: `pvc/${userIdentityStateVolume} -> ${vault.attachments.userIdentityState.mountRoot}` }
          : undefined,
      },
      vaultAssembly: exists && running
        ? {
            home: { observed: runtimeSnapshot?.homeObserved ?? false, detail: vault.runtime.home },
            projectRoot: { observed: runtimeSnapshot?.projectRootObserved ?? false, detail: `${vault.runtime.home}/vault` },
            managerState: { observed: runtimeSnapshot?.managerStateObserved ?? false, detail: vault.agent.runtime.stateRoot },
            evolutionState: { observed: runtimeSnapshot?.evolutionStateObserved ?? false, detail: vault.agent.runtime.evolutionRoot },
            codex: { observed: runtimeSnapshot?.codexObserved ?? false, detail: `${vault.runtime.home}/.codex` },
            claude: { observed: runtimeSnapshot?.claudeObserved ?? false, detail: `${vault.runtime.home}/.claude` },
            ssh: { observed: runtimeSnapshot?.sshObserved ?? false, detail: `${vault.runtime.home}/.ssh` },
          }
        : {},
      daemon: {},
      services: {
        declared: vault.connectivity.servicePorts.length ? 1 : 0,
        observed: serviceCount,
        detail: serviceCount ? "service object present" : "service object missing",
      },
    };
  }

  async executeReconcilePlan(vault: VaultRuntimeSpec, plan: ReconcilePlan): Promise<void> {
    for (const action of plan.actions) {
      if (action.kind === "render") {
        this.dependencies.writeManifest(vault, renderKubevirtVault(vault));
        continue;
      }
      if (action.kind === "apply") {
        const outputPath = this.dependencies.writeManifest(vault, renderKubevirtVault(vault));
        this.dependencies.runCommand("kubectl", ["apply", "-f", outputPath]);
        continue;
      }
      if (action.kind === "restart-runtime") {
        await syncKubevirtGuestState(vault, "sync-out");
        runVmLifecycleAction(vault, "restart", this.dependencies);
        continue;
      }
      if (action.kind === "repair-runtime-assembly" || action.kind === "clean-ephemeral-runtime") {
        await syncKubevirtGuestState(vault, "sync-out");
        runVmLifecycleAction(vault, "restart", this.dependencies);
        continue;
      }
      if (action.kind === "report-unrecoverable-drift") {
        throw new Error(action.reason || "kubevirt backend cannot repair vault drift");
      }
    }
  }
}
