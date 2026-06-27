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
import { normalizePairingUrl } from "./pairing-url.js";

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

function daemonCheck(observed: BackendObservation["daemon"][keyof BackendObservation["daemon"]]): CheckStatus {
  if (!observed) {
    return { state: "unknown" };
  }
  const normalizedUrl = normalizePairingUrl(observed.url);
  return observed.observed
    ? { state: "ok", detail: observed.detail, ...(normalizedUrl ? { url: normalizedUrl } : {}) }
    : { state: "missing", detail: observed.detail, ...(normalizedUrl ? { url: normalizedUrl } : {}) };
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
      userSshState: workspace.attachments.userSshState,
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

    if (workspace.health.requiresDaemon) {
      for (const [target, observed] of Object.entries(observation.daemon)) {
        if (observed && !observed.observed) {
          items.push({
            kind: "daemon",
            target,
            severity: "warning",
            message: observed.detail || `${target} daemon check is not ready`,
          });
        }
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
  const liveTarget = normalizePairingUrl(observation.daemon.pairing?.url) ?? null;
  const expectsCodexAssembly = expectsHarnessCredentialAssembly(workspace, ".codex");
  const expectsClaudeAssembly = expectsHarnessCredentialAssembly(workspace, ".claude");
  const backendState = !observation.backend.exists
    ? "missing"
    : observation.backend.running
      ? "running"
      : "stopped";
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
      instanceState: backendState,
    },
    lifecycleAction,
    state,
    health: {
      backendLiveness: observation.backend.exists ? (observation.backend.running ? "running" : "stopped") : "missing",
      workspaceReadiness: state === "ready" ? "ready" : "not-ready",
      daemonReadiness: workspace.health.requiresDaemon
        ? observation.daemon.manager
          ? (observation.daemon.manager.observed ? "ready" : "degraded")
          : "unknown"
        : "not-applicable",
      reason: drift.items[0]?.message,
    },
    paseo: {
      daemonAddress: workspace.agent.runtime.daemonAddress,
      supportedHarnesses: workspace.agent.harnesses,
      liveTarget,
    },
    credentials: {
      codex: codexCredentialStatus(workspace),
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
      userSshState: attachmentCheck(observation.attachments.userSshState),
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
    daemon: {
      manager: daemonCheck(observation.daemon.manager),
      pairing: daemonCheck(observation.daemon.pairing),
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
