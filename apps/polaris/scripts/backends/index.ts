import type { BackendDriver } from "./types.js";
import { PodDriver } from "./pod/driver.js";
import { KubevirtDriver } from "./kubevirt/driver.js";
import { DockerDriver } from "./docker/driver.js";

const registry = new Map<string, BackendDriver>([
  ["pod", new PodDriver()],
  ["kubevirt-vm", new KubevirtDriver()],
  ["docker", new DockerDriver()]
]);

export function getBackendDriver(kind: string): BackendDriver {
  const driver = registry.get(kind);
  if (!driver) {
    throw new Error(`Workspace backend '${kind}' is not supported`);
  }
  return driver;
}
