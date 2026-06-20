import type {
  BackendObservation,
  CheckStatus,
  DriftItem,
  ReconcilePlan,
  WorkspaceDrift,
  WorkspaceSpec,
  WorkspaceStatus,
} from "./workspace.js";

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
  return observed.observed ? { state: "ok", detail: observed.detail } : { state: "missing", detail: observed.detail };
}

export function computeWorkspaceDrift(workspace: WorkspaceSpec, observation: BackendObservation): WorkspaceDrift {
  const items: DriftItem[] = [];

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
    { key: "paseo", message: "workspace paseo assembly missing" },
    { key: "codex", message: "user identity codex assembly missing" },
    { key: "claude", message: "user identity claude assembly missing" },
    { key: "ssh", message: "user SSH assembly missing" },
  ] as const;
  for (const target of runtimeTargets) {
    const observed = observation.runtimeAssembly[target.key];
    if (!observed || !observed.observed) {
      items.push({
        kind: "runtime-assembly",
        target: target.key,
        severity: "warning",
        message: observed?.detail || target.message,
      });
    }
  }

  if (workspace.health.requiresDaemon) {
    const paseo = observation.daemon.paseo;
    if (!paseo || !paseo.observed) {
      items.push({
        kind: "daemon",
        target: "paseo",
        severity: "warning",
        message: paseo?.detail || "paseo daemon is not ready",
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
  const backendState = !observation.backend.exists
    ? "missing"
    : observation.backend.running
      ? "running"
      : workspace.backend.kind === "docker"
        ? "unsupported"
        : "degraded";
  const state: WorkspaceStatus["state"] = !observation.backend.exists
    ? "not-applied"
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
      backendLiveness: observation.backend.exists ? (observation.backend.running ? "running" : "degraded") : "missing",
      workspaceReadiness: state === "ready" ? "ready" : "not-ready",
      daemonReadiness: workspace.health.requiresDaemon
        ? (observation.daemon.paseo?.observed ? "ready" : "degraded")
        : "not-applicable",
      reason: drift.items[0]?.message,
    },
    details: {
      backendDetail: observation.backend.detail,
      serviceDetail: observation.services.detail,
    },
    attachments: {
      workspaceData: attachmentCheck(observation.attachments.workspaceData),
      workspaceRuntimeState: attachmentCheck(observation.attachments.workspaceRuntimeState),
      userIdentityState: attachmentCheck(observation.attachments.userIdentityState),
      userSshState: attachmentCheck(observation.attachments.userSshState),
    },
    runtimeAssembly: {
      home: runtimeCheck(observation.runtimeAssembly.home),
      projectRoot: runtimeCheck(observation.runtimeAssembly.projectRoot),
      paseo: runtimeCheck(observation.runtimeAssembly.paseo),
      codex: runtimeCheck(observation.runtimeAssembly.codex),
      claude: runtimeCheck(observation.runtimeAssembly.claude),
      ssh: runtimeCheck(observation.runtimeAssembly.ssh),
    },
    daemon: {
      paseo: daemonCheck(observation.daemon.paseo),
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
