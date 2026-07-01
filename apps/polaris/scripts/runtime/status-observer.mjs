const workspaceId = process.env.POLARIS_PROJECT || "workspace";
const userProfileId = process.env.POLARIS_USER_PROFILE_ID || "default";
const statusReportUrl = process.env.POLARIS_RUNTIME_STATUS_REPORT_URL?.trim() || "";
const statusReportSecret = process.env.POLARIS_RUNTIME_STATUS_REPORT_SECRET?.trim() || "";
const pollIntervalMs = 60000;
const logPrefix = "[polaris-runtime-status-observer]";

function log(message, extra) {
  if (extra === undefined) {
    console.error(`${logPrefix} ${message}`);
    return;
  }
  console.error(`${logPrefix} ${message}`, extra);
}

export function buildRuntimeStatusPatch() {
  return {
    state: "ready",
    backend: {
      instanceState: "running",
    },
    driver: {
      runtimeState: "running",
    },
    health: {
      backendLiveness: "running",
      workspaceReadiness: "ready",
      reason: "runtime status observer heartbeat",
    },
    details: {
      backendDetail: "runtime status observer heartbeat",
    },
  };
}

export async function reportRuntimeStatus() {
  if (!statusReportUrl) {
    return;
  }
  const response = await fetch(statusReportUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(statusReportSecret ? { "x-polaris-executor-secret": statusReportSecret } : {}),
    },
    body: JSON.stringify({
      userId: userProfileId,
      workspace: workspaceId,
      status: buildRuntimeStatusPatch(),
    }),
  });
  if (!response.ok) {
    throw new Error(`status report failed: ${response.status} ${response.statusText}`);
  }
}

async function poll() {
  await reportRuntimeStatus();
}

export async function main() {
  log("starting status observer", {
    workspaceId,
    userProfileId,
    pollIntervalMs,
    statusReportEnabled: Boolean(statusReportUrl),
  });
  await poll();
  setInterval(() => {
    void poll().catch((error) => {
      log("poll failed", error instanceof Error ? error.message : String(error));
    });
  }, pollIntervalMs);
}

const isMainModule =
  typeof process.argv[1] === "string" && process.argv[1].endsWith("status-observer.mjs");

if (isMainModule) {
  void main().catch((error) => {
    log("observer crashed", error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
