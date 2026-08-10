import { DockerDriver } from "./docker/driver.js";
import { KubevirtDriver } from "./kubevirt/driver.js";
import { PodDriver } from "./pod/driver.js";
import { defaultRuntimeDriverDependencies } from "./runtime-deps.js";
import type {
  BackendDriver,
  BackendKind,
  RuntimeDriverDependencies,
} from "./types.js";

export * from "./types.js";
export * from "./core/harness-catalog.js";
export * from "./core/data-layout.js";
export * from "./core/netfs.js";
export * from "./core/vault-name.js";
export { DockerDriver } from "./docker/driver.js";
export { renderDockerVault } from "./docker/render.js";
export { KubevirtDriver, readKubevirtPersistedPaseoState } from "./kubevirt/driver.js";
export { kubevirtProbePassword } from "./kubevirt/probe-access.js";
export { renderKubevirtVault } from "./kubevirt/render.js";
export { PodDriver } from "./pod/driver.js";
export { renderPodVault } from "./pod/render.js";
export { defaultRuntimeDriverDependencies } from "./runtime-deps.js";

export function createBackendDriver(
  kind: BackendKind,
  dependencies: RuntimeDriverDependencies = defaultRuntimeDriverDependencies(),
): BackendDriver {
  switch (kind) {
    case "docker":
      return new DockerDriver(dependencies);
    case "pod":
      return new PodDriver(dependencies);
    case "kubevirt-vm":
      return new KubevirtDriver(dependencies);
  }
}
