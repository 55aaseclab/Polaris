import { createExecutorServer } from "../../executor/server.js";

export async function executorCommand(
  portArg?: string,
  hostArg?: string,
): Promise<void> {
  const port = portArg ? Number(portArg) : 8788;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid executor port '${portArg ?? ""}'`);
  }
  const host = hostArg?.trim() || "127.0.0.1";
  createExecutorServer(port, host);
  process.stdout.write(`Polaris executor listening on http://${host}:${port}\n`);
}
