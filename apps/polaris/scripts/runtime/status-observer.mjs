import { execFile } from "node:child_process";
import { writeFile, rename } from "node:fs/promises";
import { promisify } from "node:util";

const workspaceId = process.env.POLARIS_PROJECT || "workspace";
const userProfileId = process.env.POLARIS_USER_PROFILE_ID || "default";
const statusReportUrl = process.env.POLARIS_RUNTIME_STATUS_REPORT_URL?.trim() || "";
const statusReportSecret = process.env.POLARIS_RUNTIME_STATUS_REPORT_SECRET?.trim() || "";
const paseoHome = process.env.PASEO_HOME?.trim() || "";
const pollIntervalMs = 60000;
const logPrefix = "[polaris-runtime-status-observer]";
const execFileAsync = promisify(execFile);

function log(message, extra) {
  if (extra === undefined) {
    console.error(`${logPrefix} ${message}`);
    return;
  }
  console.error(`${logPrefix} ${message}`, extra);
}

export function buildRuntimeStatusPatch() {
  return {
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

async function readPaseoMetadata() {
  if (!paseoHome) {
    return null;
  }
  const [{ stdout: statusStdout }, { stdout: pairStdout }] = await Promise.all([
    execFileAsync(
      "paseo",
      ["daemon", "status", "--json", "--home", paseoHome],
      { env: process.env },
    ),
    execFileAsync(
      "paseo",
      ["daemon", "pair", "--json", "--home", paseoHome],
      { env: process.env },
    ),
  ]);
  const status = JSON.parse(statusStdout);
  const pairing = JSON.parse(pairStdout);
  const serverId = typeof status?.serverId === "string" ? status.serverId.trim() : "";
  const pairingUrl = typeof pairing?.url === "string" ? pairing.url.trim() : "";
  return {
    serverId,
    pairingUrl,
    pairingJson: pairStdout,
  };
}

async function syncPairingFile(metadata) {
  if (!paseoHome || !metadata?.pairingJson) {
    return;
  }
  const filePath = `${paseoHome}/pairing.json`;
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, metadata.pairingJson, "utf8");
  await rename(tempPath, filePath);
}

export async function reportRuntimeStatus() {
  const paseo = await readPaseoMetadata();
  await syncPairingFile(paseo);
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
      ...(paseo
        ? {
            paseo: {
              ...(paseo.serverId ? { serverId: paseo.serverId } : {}),
              ...(paseo.pairingUrl ? { pairingUrl: paseo.pairingUrl } : {}),
            },
          }
        : {}),
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
