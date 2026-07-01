import type {
  BackendObservation,
  CheckStatus,
  DriftItem,
  ResolvedWorkspaceCredentialBinding,
  ReconcilePlan,
  WorkspaceDrift,
  WorkspaceSpec,
  WorkspaceStatus,
} from "./workspace.js";
import { supportsLiveCredentialSwitch } from "../config/credential-catalog.js";
import { readWorkspaceLiveCredentialSelections } from "../output/state-store.js";
import {
  workspaceRuntimeResourceName,
  workspaceRuntimeScopeName,
} from "./workspace-name.js";

function hasProvidedSshPrivateKey(workspace: WorkspaceSpec): boolean {
  return workspace.runtime.authFiles.some((entry) => {
    return entry.mountPath.startsWith(`${workspace.runtime.home}/.ssh/`) && !entry.mountPath.endsWith(".pub");
  });
}

function buildSshSelfCheck(
  workspace: WorkspaceSpec,
  observation: BackendObservation,
): NonNullable<WorkspaceStatus["ssh"]> {
  const githubAccount = workspace.userProfile.github.account;
  if (!githubAccount) {
    return {
      mode: workspace.userProfile.ssh.mode,
      selfCheck: {
        state: "not-configured",
        message: "No github.account is configured in the user profile.",
      },
    };
  }
  const githubAuthObserved = observation.runtimeAssembly.githubAuth?.observed === true;
  if (githubAuthObserved) {
    return {
      mode: workspace.userProfile.ssh.mode,
      githubAccount,
      selfCheck: {
        state: "ready",
        message: `GitHub SSH authentication is working for account ${githubAccount}.`,
      },
    };
  }
  if (workspace.userProfile.ssh.mode === "managed-key") {
    return {
      mode: "managed-key",
      githubAccount,
      selfCheck: {
        state: "warning",
        message: `Managed SSH keys are generated automatically, but access to GitHub account ${githubAccount} is not proven until the generated public key is registered with that account.`,
      },
    };
  }
  if (hasProvidedSshPrivateKey(workspace)) {
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

function runtimeCheck(observed: BackendObservation["runtimeAssembly"][keyof BackendObservation["runtimeAssembly"]]): CheckStatus {
  if (!observed) {
    return { state: "unknown" };
  }
  return observed.observed ? { state: "ok", detail: observed.detail } : { state: "missing", detail: observed.detail };
}

function expectsHarnessCredentialAssembly(
  workspace: WorkspaceSpec,
  harnessDir: ".codex" | ".claude",
): boolean {
  return workspace.runtime.authFiles.some((entry) =>
    entry.mountPath.startsWith(`${workspace.runtime.home}/${harnessDir}/`),
  );
}

function activeCodexBinding(
  workspace: WorkspaceSpec,
): ResolvedWorkspaceCredentialBinding | null {
  return workspace.resolvedCredentialBindings.find((binding) =>
    binding.purpose === "agent-auth" && binding.credential.kind === "codex-auth"
  ) ?? null;
}

function codexCredentialSource(
  workspace: WorkspaceSpec,
  binding: ResolvedWorkspaceCredentialBinding,
): "workspace-binding" | "user-active" | "compatibility" {
  if (
    workspace.credentialBindings.some((configured) =>
      configured.purpose === "agent-auth" && configured.credentialId === binding.credentialId,
    )
  ) {
    return "workspace-binding";
  }
  if (binding.source === "compatibility") {
    return "compatibility";
  }
  return "user-active";
}

function credentialBindingSource(
  workspace: WorkspaceSpec,
  binding: ResolvedWorkspaceCredentialBinding,
): "workspace-binding" | "user-active" | "compatibility" {
  if (
    workspace.credentialBindings.some((configured) =>
      configured.purpose === binding.purpose
      && configured.credentialId === binding.credentialId,
    )
  ) {
    return "workspace-binding";
  }
  if (binding.source === "compatibility") {
    return "compatibility";
  }
  return "user-active";
}

function activeSshBinding(
  workspace: WorkspaceSpec,
): ResolvedWorkspaceCredentialBinding | null {
  return workspace.resolvedCredentialBindings.find((binding) =>
    binding.purpose === "git-auth" && binding.credential.kind === "ssh-key"
  ) ?? null;
}

function codexCredentialStatus(
  workspace: WorkspaceSpec,
): NonNullable<WorkspaceStatus["credentials"]>["codex"] {
  const binding = activeCodexBinding(workspace);
  if (!binding) {
    return {
      state: "not-selected",
    };
  }
  return {
    state: "selected",
    credentialId: binding.credentialId,
    label: binding.credential.label,
    source: codexCredentialSource(workspace, binding),
  };
}

function liveCredentialSelectionStatus(
  workspace: WorkspaceSpec,
): NonNullable<WorkspaceStatus["credentials"]>["live"] {
  const persistedSelections = readWorkspaceLiveCredentialSelections(
    workspace.identity.projectName,
    workspace.userProfile.id,
  );
  const selectedByHarness: NonNullable<
    NonNullable<WorkspaceStatus["credentials"]>["live"]
  >["selectedByHarness"] = {};

  for (const [harness, persisted] of Object.entries(persistedSelections)) {
    if (!supportsLiveCredentialSwitch(harness) || !persisted?.credentialId) {
      continue;
    }
    const selected = workspace.credentials.find((credential) =>
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

  const codex = codexCredentialStatus(workspace);
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

  const sshBinding = activeSshBinding(workspace);
  if (sshBinding && !selectedByHarness.ssh) {
    selectedByHarness.ssh = {
      credentialId: sshBinding.credentialId,
      label: sshBinding.credential.label,
      source: credentialBindingSource(workspace, sshBinding),
    };
  }

  const switchableHarnesses = Array.from(
    new Set(
      [
        ...workspace.credentials
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
    supportedHarnesses: workspace.agent.harnesses,
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

function driverTarget(workspace: WorkspaceSpec): string {
  return workspace.backend.kind === "pod" && workspace.backend.profile
    ? `pod:${workspace.backend.profile}`
    : workspace.backend.kind;
}

function driverRuntimeKind(
  workspace: WorkspaceSpec,
): NonNullable<WorkspaceStatus["driver"]>["runtimeKind"] {
  if (workspace.backend.kind === "docker") {
    return "docker-container";
  }
  if (workspace.backend.kind === "pod") {
    return "kubernetes-pod";
  }
  return "kubevirt-vm";
}

function driverRuntimeRef(
  workspace: WorkspaceSpec,
  observation: BackendObservation,
): string {
  const runtimeScope = workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName);
  if (workspace.backend.kind === "docker") {
    return `container/${runtimeScope}-docker`;
  }
  if (workspace.backend.kind === "pod") {
    return observation.backend.detail?.startsWith("pod/")
      ? observation.backend.detail
      : `deployment/${runtimeScope}`;
  }
  return `vm/${workspaceRuntimeResourceName(workspace.userProfile.id, workspace.identity.projectName, "vm")}`;
}

function runtimeAssemblyCheck(
  expected: boolean,
  observed: BackendObservation["runtimeAssembly"][keyof BackendObservation["runtimeAssembly"]],
): CheckStatus {
  if (!expected) {
    return { state: "unknown" };
  }
  return runtimeCheck(observed);
}

export function computeWorkspaceDrift(workspace: WorkspaceSpec, observation: BackendObservation): WorkspaceDrift {
  const items: DriftItem[] = [];
  const backendRunning = observation.backend.exists && observation.backend.running;
  const expectsCodexAssembly = expectsHarnessCredentialAssembly(workspace, ".codex");
  const expectsClaudeAssembly = expectsHarnessCredentialAssembly(workspace, ".claude");

  if (!observation.backend.exists) {
    items.push({
      kind: "backend",
      target: workspace.backend.kind,
      severity: "error",
      message: "backend resource does not exist",
    });
  } else if (!observation.backend.running) {
    items.push({
      kind: "backend",
      target: workspace.backend.kind,
      severity: "warning",
      message: observation.backend.detail || "backend exists but is not running",
    });
  }

  if (backendRunning) {
    const attachmentTargets = {
      workspaceData: workspace.attachments.workspaceData,
      workspaceRuntimeState: workspace.attachments.workspaceRuntimeState,
      userIdentityState: workspace.attachments.userIdentityState,
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

    const runtimeTargets = [
      { key: "projectRoot", message: "workspace project root assembly missing" },
      { key: "managerState", message: "workspace manager assembly missing" },
      { key: "evolutionState", message: "workspace evolution assembly missing" },
      { key: "ssh", message: "user SSH assembly missing" },
    ] as const;
    for (const target of runtimeTargets) {
      const observed = observation.runtimeAssembly[target.key];
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
      const observed = observation.runtimeAssembly.codex;
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
      const observed = observation.runtimeAssembly.claude;
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

export function synthesizeWorkspaceStatus(
  workspace: WorkspaceSpec,
  observation: BackendObservation,
  drift: WorkspaceDrift,
  lifecycleAction: WorkspaceStatus["lifecycleAction"],
): WorkspaceStatus {
  const expectsCodexAssembly = expectsHarnessCredentialAssembly(workspace, ".codex");
  const expectsClaudeAssembly = expectsHarnessCredentialAssembly(workspace, ".claude");
  const state: WorkspaceStatus["state"] = !observation.backend.exists
    ? "not-applied"
    : !observation.backend.running && !drift.hasErrors
      ? "saved"
      : drift.hasErrors
        ? "degraded"
        : drift.hasWarnings
          ? "degraded"
          : "ready";

  return {
    project: workspace.identity.projectName,
    backend: {
      kind: workspace.backend.kind,
      profile: workspace.backend.profile,
    },
    driver: {
      target: driverTarget(workspace),
      baseImage: workspace.runtime.baseImage,
      runtimeKind: driverRuntimeKind(workspace),
      runtimeRef: driverRuntimeRef(workspace, observation),
      ...(workspace.runtime.rootdiskImage
        ? { rootdiskImage: workspace.runtime.rootdiskImage }
        : {}),
    },
    lifecycleAction,
    state,
    health: {
      backendLiveness: observation.backend.exists ? (observation.backend.running ? "running" : "stopped") : "missing",
      workspaceReadiness: state === "ready" ? "ready" : "not-ready",
      reason: drift.items[0]?.message,
    },
    credentials: {
      codex: codexCredentialStatus(workspace),
      live: liveCredentialSelectionStatus(workspace),
    },
    details: {
      backendDetail: observation.backend.detail,
      serviceDetail: observation.services.detail,
      agentDetail: workspace.agent.enabled
        ? `${workspace.agent.managerId} + ${workspace.agent.harnesses.join(" + ")}`
        : "agent integration disabled",
      userProfileDetail: `${workspace.userProfile.id} <${workspace.userProfile.email}>`,
    },
    ssh: buildSshSelfCheck(workspace, observation),
    attachments: {
      workspaceData: attachmentCheck(observation.attachments.workspaceData),
      workspaceRuntimeState: attachmentCheck(observation.attachments.workspaceRuntimeState),
      userIdentityState: attachmentCheck(observation.attachments.userIdentityState),
    },
    runtimeAssembly: {
      home: runtimeCheck(observation.runtimeAssembly.home),
      projectRoot: runtimeCheck(observation.runtimeAssembly.projectRoot),
      managerState: runtimeCheck(observation.runtimeAssembly.managerState),
      evolutionState: runtimeCheck(observation.runtimeAssembly.evolutionState),
      codex: runtimeAssemblyCheck(expectsCodexAssembly, observation.runtimeAssembly.codex),
      claude: runtimeAssemblyCheck(expectsClaudeAssembly, observation.runtimeAssembly.claude),
      ssh: runtimeCheck(observation.runtimeAssembly.ssh),
    },
    drift,
  };
}

export function buildReconcilePlan(workspace: WorkspaceSpec, drift: WorkspaceDrift): ReconcilePlan {
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
    project: workspace.identity.projectName,
    backend: workspace.backend.kind,
    safe: !drift.hasErrors || actions.every((item) => item.kind !== "report-unrecoverable-drift"),
    requiresRestart: actions.some((item) => item.kind === "restart-runtime"),
    destructive: false,
    actions,
  };
}
