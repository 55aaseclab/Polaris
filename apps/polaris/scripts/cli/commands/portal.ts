import { createPortalServer } from "../../portal/server.js";
import {
  resumeDurableVaultJobs,
  startDurableJobRecoveryLoop,
} from "../../control-plane/operations.js";
import { captureTelemetryError, trackTelemetryEvent } from "../../telemetry/client.js";

export async function portalCommand(portArg?: string, hostArg?: string): Promise<void> {
  const startedAt = Date.now();
  try {
    const port = portArg ? Number(portArg) : 8787;
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`Invalid portal port '${portArg ?? ""}'`);
    }
    const host = hostArg?.trim() || "127.0.0.1";
    createPortalServer(port, host);
    void resumeDurableVaultJobs();
    startDurableJobRecoveryLoop();
    await trackTelemetryEvent(import.meta.url, {
      event: "app_launch_completed",
      category: "runtime",
      properties: {
        service_name: "portal",
        host,
        port,
        duration_ms: Date.now() - startedAt,
      },
    });
    process.stdout.write(`Polaris server listening on http://${host}:${port}\n`);
  } catch (error) {
    await captureTelemetryError(import.meta.url, error, {
      event: "app_launch_failed",
      properties: {
        service_name: "portal",
        error_stage: "startup",
      },
    });
    throw error;
  }
}
