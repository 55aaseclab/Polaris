const workspaceId = process.env.POLARIS_PROJECT || "workspace";
const userProfileId = process.env.POLARIS_USER_PROFILE_ID || "default";
const driverBackend = process.env.POLARIS_DRIVER_BACKEND?.trim() || "";
const driverProfile = process.env.POLARIS_DRIVER_PROFILE?.trim() || "";
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

function executorDisconnectMessage(error) {
  if (!error) {
    return "";
  }
  if (error instanceof Error) {
    const causeMessage =
      error.cause instanceof Error
        ? error.cause.message
        : error.cause
          ? String(error.cause)
          : "";
    return [error.message, causeMessage].filter(Boolean).join(" ");
  }
  return String(error);
}

function transientExecutorDisconnectDetails(error) {
  return {
    workspaceId,
    userProfileId,
    statusReportUrl,
    error: executorDisconnectMessage(error),
  };
}

export function isTransientExecutorDisconnect(error) {
  const message = executorDisconnectMessage(error).toLowerCase();
  return (
    message.includes("other side closed")
    || message.includes("econnreset")
    || message.includes("econnrefused")
    || message.includes("fetch failed")
    || message.includes("und_err_socket")
  );
}

export function buildRuntimeStatusPatch() {
  return {
    driver: {
      ...(driverBackend
        ? {
            selected: {
              backend: driverBackend,
              ...(driverProfile ? { profile: driverProfile } : {}),
            },
          }
        : {}),
      status: "running",
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
  try {
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
  } catch (error) {
    if (isTransientExecutorDisconnect(error)) {
      log(
        "status report skipped after transient executor disconnect",
        transientExecutorDisconnectDetails(error),
      );
      return;
    }
    throw error;
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
    if (isTransientExecutorDisconnect(error)) {
      log(
        "observer exiting after transient executor disconnect",
        transientExecutorDisconnectDetails(error),
      );
      process.exitCode = 0;
      return;
    }
    log("observer crashed", error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
