import { createExecutorServer } from "../../executor/server.js";
import { captureTelemetryError, trackTelemetryEvent } from "../../telemetry/client.js";
const EXECUTOR_LOOPBACK_HOST = "127.0.0.1";

export async function executorCommand(
  portArg?: string,
  hostArg?: string,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const port = portArg ? Number(portArg) : 8788;
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`Invalid executor port '${portArg ?? ""}'`);
    }
    const host = hostArg?.trim() || EXECUTOR_LOOPBACK_HOST;
    if (host !== EXECUTOR_LOOPBACK_HOST) {
      throw new Error(
        `Polaris executor must bind to ${EXECUTOR_LOOPBACK_HOST}, received '${host}'`,
      );
    }
    createExecutorServer(port, host);
    await trackTelemetryEvent(import.meta.url, {
      event: "app_launch_completed",
      category: "runtime",
      properties: {
        service_name: "executor",
        host,
        port,
        duration_ms: Date.now() - startedAt,
      },
    });
    process.stdout.write(`Polaris executor listening on http://${host}:${port}\n`);
  } catch (error) {
    await captureTelemetryError(import.meta.url, error, {
      event: "app_launch_failed",
      properties: {
        service_name: "executor",
        error_stage: "startup",
      },
    });
    throw error;
  }
}
