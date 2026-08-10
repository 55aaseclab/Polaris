import type { BackendDriver } from "./types.js";
import {
  getPolarisBackendDriver,
  vaultHarnessIds,
  vaultNonPaseoToolPackageSpecs,
  vaultPaseoPackageSpec,
  vaultToolCatalog,
  vaultToolPackageSpecs,
} from "./vault-runtime-adapter.js";
export type { HarnessToolDefinition } from "./vault-runtime-adapter.js";

export {
  vaultHarnessIds,
  vaultNonPaseoToolPackageSpecs,
  vaultPaseoPackageSpec,
  vaultToolCatalog,
  vaultToolPackageSpecs,
};

export function getBackendDriver(kind: string): BackendDriver {
  return getPolarisBackendDriver(kind);
}
