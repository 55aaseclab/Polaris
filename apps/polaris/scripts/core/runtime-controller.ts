import fs from "node:fs";
import path from "node:path";
import type {
  BackendObservation,
  CheckStatus,
  DriftItem,
  ResolvedVaultCredentialBinding,
  ReconcilePlan,
  VaultDrift,
  VaultSpec,
  VaultStatus,
} from "./vault.js";
import { VAULT_STATUS_SCHEMA_VERSION } from "./vault.js";
import { supportsLiveCredentialSwitch } from "../config/credential-catalog.js";
import {
  readVaultLiveCredentialSelections,
  vaultPaseoStateDir,
} from "../output/state-store.js";
import {
  extractOfferFragment,
  normalizePairingUrl,
  resolveConfiguredPaseoAppBaseUrl,
} from "./pairing-url.js";
import {
  vaultRuntimeResourceName,
  vaultRuntimeScopeName,
} from "./vault-name.js";

function hasProvidedSshPrivateKey(vault: VaultSpec): boolean {
  return vault.runtime.authFiles.some((entry) => {
    return entry.mountPath.startsWith(`${vault.runtime.home}/.ssh/`) && !entry.mountPath.endsWith(".pub");
  });
}

function readPersistedPaseoServerId(vault: VaultSpec): string | null {
  const filePath = path.join(vaultPaseoStateDir(vault.identity.projectName, vault.userProfile.id), "server-id");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }
  const value = fs.readFileSync(filePath, "utf8").trim();
  return value || null;
}

function vaultPaseoScope(vault: VaultSpec): string {
  return `${vault.userProfile.id.trim()}:${vault.identity.projectName.trim()}`;
}

function readPersistedPaseoPairingUrl(vault: VaultSpec): string | null {
  const filePath = path.join(vaultPaseoStateDir(vault.identity.projectName, vault.userProfile.id), "pairing.json");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { url?: unknown };
    const raw = typeof parsed.url === "string" ? parsed.url.trim() : "";
    return normalizePairingUrl(raw, process.env, vaultPaseoScope(vault)) ?? null;
  } catch {
    return null;
  }
}

function buildReconnectTarget(
  serverId: string | null | undefined,
  pairingTarget: string | null | undefined,
  scope: string,
): string | null {
  const normalizedServerId = String(serverId ?? "").trim();
  if (!normalizedServerId) {
    return null;
  }
  const appBaseUrl = resolveConfiguredPaseoAppBaseUrl(process.env);
  if (!appBaseUrl) {
    return null;
  }
  try {
    const url = new URL(`${appBaseUrl.replace(/\/$/, "")}/h/${encodeURIComponent(normalizedServerId)}`);
    if (scope) {
      url.searchParams.set("scope", scope);
    }
    const offer = extractOfferFragment(String(pairingTarget ?? ""));
    if (offer) {
      url.hash = `offer=${offer}`;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function synthesizeVaultPaseoStatus(
  vault: VaultSpec,
  driver: Pick<NonNullable<VaultStatus["driver"]>, "selected" | "status" | "reason">,
): VaultStatus["paseo"] {
  if (!vault.agent.enabled) {
    return {
      daemon: "absent",
      web: "unavailable",
      reconnectMode: "unknown",
      liveTarget: null,
      reconnectTarget: null,
      reason: driver.reason,
    };
  }
  const liveTarget = readPersistedPaseoPairingUrl(vault);
  const serverId = readPersistedPaseoServerId(vault);
  const reconnectTarget = buildReconnectTarget(serverId, liveTarget, vaultPaseoScope(vault));
  const reconnectMode =
    reconnectTarget && serverId
      ? "reconnectable"
      : liveTarget
        ? "needs-pairing"
        : "unknown";

  if (driver.status !== "running") {
    return {
      daemon: "absent",
      web: "unavailable",
      reconnectMode,
      liveTarget,
      reconnectTarget,
      reason: driver.reason,
    };
  }

  return {
    daemon:
      reconnectMode === "reconnectable"
        ? "ready"
        : liveTarget
          ? "pending"
          : "unknown",
    web:
      reconnectMode === "reconnectable"
        ? "connectable"
        : reconnectMode === "needs-pairing"
          ? "pairing-required"
          : "unavailable",
    reconnectMode,
    liveTarget,
    reconnectTarget,
    reason: driver.reason,
  };
}

function buildSshSelfCheck(
  vault: VaultSpec,
  observation: BackendObservation,
): NonNullable<NonNullable<VaultStatus["credentials"]>["ssh"]> {
  const githubAccount = vault.userProfile.github.account;
  if (!githubAccount) {
    return {
      mode: vault.userProfile.ssh.mode,
      selfCheck: {
        state: "not-configured",
        message: "No github.account is configured in the user profile.",
      },
    };
  }
  const githubAuthObserved = observation.vaultAssembly.githubAuth?.observed === true;
  if (githubAuthObserved) {
    return {
      mode: vault.userProfile.ssh.mode,
      githubAccount,
      selfCheck: {
        state: "ready",
        message: `GitHub SSH authentication is working for account ${githubAccount}.`,
      },
    };
  }
  if (vault.userProfile.ssh.mode === "managed-key") {
    return {
      mode: "managed-key",
      githubAccount,
      selfCheck: {
        state: "warning",
        message: `Managed SSH keys are generated automatically, but access to GitHub account ${githubAccount} is not proven until the generated public key is registered with that account.`,
      },
    };
  }
  if (hasProvidedSshPrivateKey(vault)) {
    return {
      mode: "provided-key",
      githubAccount,
      selfCheck: {
        state: "ready",
        message: `Provided SSH key material is staged for GitHub account ${githubAccount}.`,
      },
    };
  }
  return {
    mode: "provided-key",
    githubAccount,
    selfCheck: {
      state: "error",
      message: `github.account is set to ${githubAccount}, but no provided SSH private key material is staged.`,
    },
  };
}

function attachmentCheck(observed: BackendObservation["attachments"][keyof BackendObservation["attachments"]]): CheckStatus {
  if (!observed) {
    return { state: "unknown" };
  }
  return observed.observed ? { state: "ok", detail: observed.detail } : { state: "missing", detail: observed.detail };
}

function runtimeCheck(observed: BackendObservation["vaultAssembly"][keyof BackendObservation["vaultAssembly"]]): CheckStatus {
  if (!observed) {
    return { state: "unknown" };
  }
  return observed.observed ? { state: "ok", detail: observed.detail } : { state: "missing", detail: observed.detail };
}

function expectsHarnessCredentialAssembly(
  vault: VaultSpec,
  harnessDir: ".codex" | ".claude",
): boolean {
  return vault.runtime.authFiles.some((entry) =>
    entry.mountPath.startsWith(`${vault.runtime.home}/${harnessDir}/`),
  );
}

function activeCodexBinding(
  vault: VaultSpec,
): ResolvedVaultCredentialBinding | null {
  return vault.resolvedCredentialBindings.find((binding) =>
    binding.purpose === "agent-auth" && binding.credential.kind === "codex-auth"
  ) ?? null;
}

function codexCredentialSource(
  vault: VaultSpec,
  binding: ResolvedVaultCredentialBinding,
): "vault-binding" | "user-active" | "compatibility" {
  if (
    vault.credentialBindings.some((configured) =>
      configured.purpose === "agent-auth" && configured.credentialId === binding.credentialId,
    )
  ) {
    return "vault-binding";
  }
  if (binding.source === "compatibility") {
    return "compatibility";
  }
  return "user-active";
}

function credentialBindingSource(
  vault: VaultSpec,
  binding: ResolvedVaultCredentialBinding,
): "vault-binding" | "user-active" | "compatibility" {
  if (
    vault.credentialBindings.some((configured) =>
      configured.purpose === binding.purpose
      && configured.credentialId === binding.credentialId,
    )
  ) {
    return "vault-binding";
  }
  if (binding.source === "compatibility") {
    return "compatibility";
  }
  return "user-active";
}

function activeSshBinding(
  vault: VaultSpec,
): ResolvedVaultCredentialBinding | null {
  return vault.resolvedCredentialBindings.find((binding) =>
    binding.purpose === "git-auth" && binding.credential.kind === "ssh-key"
  ) ?? null;
}

function codexCredentialStatus(
  vault: VaultSpec,
): NonNullable<VaultStatus["credentials"]>["codex"] {
  const binding = activeCodexBinding(vault);
  if (!binding) {
    return {
      state: "not-selected",
    };
  }
  return {
    state: "selected",
    credentialId: binding.credentialId,
    label: binding.credential.label,
    source: codexCredentialSource(vault, binding),
  };
}

function liveCredentialSelectionStatus(
  vault: VaultSpec,
): NonNullable<VaultStatus["credentials"]>["live"] {
  const persistedSelections = readVaultLiveCredentialSelections(
    vault.identity.projectName,
    vault.userProfile.id,
  );
  const selectedByHarness: NonNullable<
    NonNullable<VaultStatus["credentials"]>["live"]
  >["selectedByHarness"] = {};

  for (const [harness, persisted] of Object.entries(persistedSelections)) {
    if (!supportsLiveCredentialSwitch(harness) || !persisted?.credentialId) {
      continue;
    }
    const selected = vault.credentials.find((credential) =>
      credential.id === persisted.credentialId
      && credential.metadata?.harness === harness,
    );
    if (!selected) {
      continue;
    }
    selectedByHarness[harness] = {
      credentialId: selected.id,
      label: selected.label,
      source: "runtime-state",
    };
  }

  const codex = codexCredentialStatus(vault);
  if (
    codex?.state === "selected"
    && codex.credentialId
    && codex.label
    && !selectedByHarness.codex
  ) {
    selectedByHarness.codex = {
      credentialId: codex.credentialId,
      label: codex.label,
      source: codex.source ?? "user-active",
    };
  }

  const sshBinding = activeSshBinding(vault);
  if (sshBinding && !selectedByHarness.ssh) {
    selectedByHarness.ssh = {
      credentialId: sshBinding.credentialId,
      label: sshBinding.credential.label,
      source: credentialBindingSource(vault, sshBinding),
    };
  }

  const switchableHarnesses = Array.from(
    new Set(
      [
        ...vault.credentials
          .map((credential) => String(credential.metadata?.harness ?? "").trim())
          .filter((harness) => supportsLiveCredentialSwitch(harness)),
        ...Object.keys(selectedByHarness).filter((harness) =>
          supportsLiveCredentialSwitch(harness),
        ),
      ],
    ),
  );
  const firstSelection = Object.entries(selectedByHarness)[0];

  return {
    switchableHarnesses,
    supportedHarnesses: vault.agent.harnesses,
    ...(firstSelection
      ? {
          selectedHarness: firstSelection[0],
          selectedCredentialId: firstSelection[1].credentialId,
          selectedCredentialLabel: firstSelection[1].label,
          source: firstSelection[1].source,
          selectedByHarness,
        }
      : {}),
  };
}

function driverRuntimeKind(
  vault: VaultSpec,
): NonNullable<VaultStatus["driver"]>["runtimeKind"] {
  if (vault.backend.kind === "docker") {
    return "docker-container";
  }
  if (vault.backend.kind === "pod") {
    return "kubernetes-pod";
  }
  return "kubevirt-vm";
}

function driverRuntimeRef(
  vault: VaultSpec,
  observation: BackendObservation,
): string {
  const runtimeScope = vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName);
  if (vault.backend.kind === "docker") {
    return `container/${runtimeScope}-docker`;
  }
  if (vault.backend.kind === "pod") {
    return observation.backend.detail?.startsWith("pod/")
      ? observation.backend.detail
      : `deployment/${runtimeScope}`;
  }
  return `vm/${vaultRuntimeResourceName(vault.userProfile.id, vault.identity.projectName, "vm")}`;
}

function runtimeAssemblyCheck(
  expected: boolean,
  observed: BackendObservation["vaultAssembly"][keyof BackendObservation["vaultAssembly"]],
): CheckStatus {
  if (!expected) {
    return { state: "unknown" };
  }
  return runtimeCheck(observed);
}

export function computeVaultDrift(vault: VaultSpec, observation: BackendObservation): VaultDrift {
  const items: DriftItem[] = [];
  const backendRunning = observation.backend.exists && observation.backend.running;
  const expectsCodexAssembly = expectsHarnessCredentialAssembly(vault, ".codex");
  const expectsClaudeAssembly = expectsHarnessCredentialAssembly(vault, ".claude");

  if (!observation.backend.exists) {
    items.push({
      kind: "backend",
      target: vault.backend.kind,
      severity: "error",
      message: "backend resource does not exist",
    });
  } else if (!observation.backend.running) {
    items.push({
      kind: "backend",
      target: vault.backend.kind,
      severity: "warning",
      message: observation.backend.detail || "backend exists but is not running",
    });
  }

  if (backendRunning) {
    if (vault.agent.enabled) {
      const paseoStateRoot = vaultPaseoStateDir(
        vault.identity.projectName,
        vault.userProfile.id,
      );
      const persistedServerIdPath = `${paseoStateRoot}/server-id`;
      const persistedPairingPath = `${paseoStateRoot}/pairing.json`;
      if (!fs.existsSync(persistedServerIdPath)) {
        items.push({
          kind: "daemon",
          target: "persisted-server-id",
          severity: "warning",
          message: "persisted Paseo server-id is missing",
        });
      }
      if (!fs.existsSync(persistedPairingPath)) {
        items.push({
          kind: "daemon",
          target: "persisted-pairing",
          severity: "warning",
          message: "persisted Paseo pairing metadata is missing",
        });
      }
    }

    const attachmentTargets = {
      vaultData: vault.attachments.vaultData,
      vaultRuntimeState: vault.attachments.vaultRuntimeState,
      userIdentityState: vault.attachments.userIdentityState,
    } as const;

    for (const [key, attachment] of Object.entries(attachmentTargets)) {
      const observationKey = key as keyof BackendObservation["attachments"];
      const observed = observation.attachments[observationKey];
      if (!observed || !observed.observed) {
        items.push({
          kind: "attachment",
          target: attachment.kind,
          severity: "error",
          message: observed?.detail || `${attachment.kind} is missing or not attached`,
        });
      }
    }

    const runtimeTargets: Array<{
      key: "projectRoot" | "managerState" | "evolutionState" | "ssh";
      message: string;
    }> = [{ key: "projectRoot", message: "vault project root assembly missing" }];
    if (vault.agent.enabled) {
      runtimeTargets.push(
        { key: "managerState", message: "vault manager assembly missing" },
        { key: "evolutionState", message: "vault evolution assembly missing" },
        { key: "ssh", message: "user SSH assembly missing" },
      );
    }
    for (const target of runtimeTargets) {
      const observed = observation.vaultAssembly[target.key];
      if (observed && !observed.observed) {
        items.push({
          kind: "runtime-assembly",
          target: target.key,
          severity: "warning",
          message: observed?.detail || target.message,
        });
      }
    }

    if (expectsCodexAssembly) {
      const observed = observation.vaultAssembly.codex;
      if (observed && !observed.observed) {
        items.push({
          kind: "runtime-assembly",
          target: "codex",
          severity: "warning",
          message: observed.detail || "user identity codex assembly missing",
        });
      }
    }

    if (expectsClaudeAssembly) {
      const observed = observation.vaultAssembly.claude;
      if (observed && !observed.observed) {
        items.push({
          kind: "runtime-assembly",
          target: "claude",
          severity: "warning",
          message: observed.detail || "user identity claude assembly missing",
        });
      }
    }

    if (
      typeof observation.services.declared === "number" &&
      typeof observation.services.observed === "number" &&
      observation.services.declared !== observation.services.observed
    ) {
      items.push({
        kind: "service",
        target: "service-count",
        severity: "warning",
        message: observation.services.detail || `declared ${observation.services.declared} services but observed ${observation.services.observed}`,
      });
    }
  }

  return {
    items,
    hasErrors: items.some((item) => item.severity === "error"),
    hasWarnings: items.some((item) => item.severity === "warning"),
  };
}

export function synthesizeVaultStatus(
  vault: VaultSpec,
  observation: BackendObservation,
  drift: VaultDrift,
): VaultStatus {
  const expectsCodexAssembly = expectsHarnessCredentialAssembly(vault, ".codex");
  const expectsClaudeAssembly = expectsHarnessCredentialAssembly(vault, ".claude");
  const backendLiveness = !observation.backend.exists
    ? "missing"
    : observation.backend.running
      ? "running"
      : "stopped";
  const driverState: Pick<NonNullable<VaultStatus["driver"]>, "selected" | "status" | "reason"> = {
    selected: {
      backend: vault.backend.kind,
      ...(vault.backend.profile ? { profile: vault.backend.profile } : {}),
    },
    status:
      backendLiveness === "running"
        ? "running"
        : backendLiveness === "stopped" || backendLiveness === "missing"
          ? "stopped"
          : "unknown",
    reason: drift.items[0]?.message,
  };
  const paseo = synthesizeVaultPaseoStatus(vault, driverState);

  return {
    schemaVersion: VAULT_STATUS_SCHEMA_VERSION,
    project: vault.identity.projectName,
    driver: {
      selected: driverState.selected,
      status: driverState.status,
      ...(driverState.reason ? { reason: driverState.reason } : {}),
      baseImage: vault.runtime.baseImage,
      runtimeKind: driverRuntimeKind(vault),
      runtimeRef: driverRuntimeRef(vault, observation),
      ...(vault.runtime.rootdiskImage
        ? { rootdiskImage: vault.runtime.rootdiskImage }
        : {}),
    },
    paseo,
    credentials: {
      ssh: buildSshSelfCheck(vault, observation),
      codex: codexCredentialStatus(vault),
      live: liveCredentialSelectionStatus(vault),
    },
    details: {
      backendDetail: observation.backend.detail,
      serviceDetail: observation.services.detail,
      agentDetail: vault.agent.enabled
        ? `${vault.agent.managerId} + ${vault.agent.harnesses.join(" + ")}`
        : "agent integration disabled",
      userProfileDetail: `${vault.userProfile.id} <${vault.userProfile.email}>`,
    },
    attachments: {
      vaultData: attachmentCheck(observation.attachments.vaultData),
      vaultRuntimeState: attachmentCheck(observation.attachments.vaultRuntimeState),
      userIdentityState: attachmentCheck(observation.attachments.userIdentityState),
    },
    vaultAssembly: {
      home: runtimeCheck(observation.vaultAssembly.home),
      projectRoot: runtimeCheck(observation.vaultAssembly.projectRoot),
      managerState: runtimeAssemblyCheck(vault.agent.enabled, observation.vaultAssembly.managerState),
      evolutionState: runtimeAssemblyCheck(vault.agent.enabled, observation.vaultAssembly.evolutionState),
      codex: runtimeAssemblyCheck(expectsCodexAssembly, observation.vaultAssembly.codex),
      claude: runtimeAssemblyCheck(expectsClaudeAssembly, observation.vaultAssembly.claude),
      ssh: runtimeAssemblyCheck(vault.agent.enabled, observation.vaultAssembly.ssh),
    },
  };
}

export function buildReconcilePlan(vault: VaultSpec, drift: VaultDrift): ReconcilePlan {
  const actions: ReconcilePlan["actions"] = [];

  for (const item of drift.items) {
    if (item.kind === "attachment") {
      actions.push({ kind: "apply" });
      continue;
    }
    if (item.kind === "runtime-assembly") {
      actions.push({ kind: "repair-runtime-assembly", target: item.target });
      continue;
    }
    if (item.kind === "daemon") {
      actions.push({ kind: "restart-runtime" });
      continue;
    }
    if (item.kind === "service") {
      actions.push({ kind: "apply" });
      continue;
    }
    if (item.kind === "backend") {
      actions.push({ kind: "render" });
      actions.push({ kind: "apply" });
    }
  }

  if (drift.hasErrors && actions.length === 0) {
    actions.push({ kind: "report-unrecoverable-drift", reason: "drift detected but no supported actions are available" });
  }

  return {
    project: vault.identity.projectName,
    backend: vault.backend.kind,
    safe: !drift.hasErrors || actions.every((item) => item.kind !== "report-unrecoverable-drift"),
    requiresRestart: actions.some((item) => item.kind === "restart-runtime"),
    destructive: false,
    actions,
  };
}
