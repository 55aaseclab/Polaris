import { createPortalServer } from "../../portal/server.js";

export async function portalCommand(portArg?: string, hostArg?: string): Promise<void> {
  const port = portArg ? Number(portArg) : 8787;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid portal port '${portArg ?? ""}'`);
  }
  const host = hostArg?.trim() || "127.0.0.1";
  createPortalServer(port, host);
  process.stdout.write(`Polaris server listening on http://${host}:${port}\n`);
}
