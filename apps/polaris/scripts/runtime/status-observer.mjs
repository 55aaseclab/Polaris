import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const paseoHome = process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
const workspaceId = process.env.POLARIS_PROJECT || "workspace";
const userProfileId = process.env.POLARIS_USER_PROFILE_ID || "default";
const statusReportUrl = process.env.POLARIS_RUNTIME_STATUS_REPORT_URL?.trim() || "";
const statusReportSecret = process.env.POLARIS_RUNTIME_STATUS_REPORT_SECRET?.trim() || "";
const pollIntervalMs = 60000;
const logPrefix = "[polaris-runtime-status-observer]";

function daemonManagerReady(parsed) {
  return parsed.localDaemon === "running" || parsed.localDaemon === "stale_pid";
}

function log(message, extra) {
  if (extra === undefined) {
    console.error(`${logPrefix} ${message}`);
    return;
  }
  console.error(`${logPrefix} ${message}`, extra);
}

function daemonStatusSnapshot() {
  try {
    const stdout = execFileSync(
      "paseo",
      ["daemon", "status", "--json"],
      {
        env: {
          ...process.env,
          PASEO_HOME: paseoHome,
        },
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const parsed = JSON.parse(stdout);
    return {
      ok: true,
      parsed,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildRuntimeStatusPatch(daemon) {
  return daemon.ok
    ? {
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
          daemonReadiness: daemonManagerReady(daemon.parsed) ? "ready" : "degraded",
          reason:
            daemonManagerReady(daemon.parsed)
            && daemon.parsed.connectedDaemon === "reachable"
              ? "runtime status observer reported healthy daemon"
              : `runtime status observer saw daemon ${daemon.parsed.localDaemon}/${daemon.parsed.connectedDaemon}`,
        },
        paseo: {
          daemonAddress: daemon.parsed.listen || "0.0.0.0:6767",
          serverId: daemon.parsed.serverId,
          supportedHarnesses: Array.isArray(daemon.parsed.providers)
            ? daemon.parsed.providers
              .map((provider) => String(provider.label || "").trim().toLowerCase())
              .filter(Boolean)
            : [],
          liveTarget: null,
        },
        daemon: {
          manager: {
            state: daemonManagerReady(daemon.parsed) ? "ok" : "missing",
            detail: daemon.parsed.listen || "/tmp/.ready",
          },
          pairing: {
            state: daemon.parsed.connectedDaemon === "reachable" ? "ok" : "missing",
            detail: daemon.parsed.relay || "paseo daemon pair",
          },
        },
        details: {
          backendDetail: "runtime status observer heartbeat",
        },
      }
    : {
        backend: {
          instanceState: "running",
        },
        driver: {
          runtimeState: "running",
        },
        health: {
          backendLiveness: "running",
          workspaceReadiness: "not-ready",
          daemonReadiness: "degraded",
          reason: daemon.error || "runtime status observer could not read daemon status",
        },
        daemon: {
          manager: {
            state: "missing",
            detail: daemon.error || "/tmp/.ready",
          },
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
  const daemon = daemonStatusSnapshot();
  const response = await fetch(statusReportUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(statusReportSecret ? { "x-polaris-executor-secret": statusReportSecret } : {}),
    },
    body: JSON.stringify({
      userId: userProfileId,
      workspace: workspaceId,
      status: buildRuntimeStatusPatch(daemon),
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
    paseoHome,
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
