import type { BackendObservation, ReconcilePlan, VaultSpec } from "../core/vault.js";

export interface BackendDriver {
  readonly kind: VaultSpec["backend"]["kind"];
  create(vault: VaultSpec): Promise<void>;
  start(vault: VaultSpec): Promise<void>;
  stop(vault: VaultSpec): Promise<void>;
  restart(vault: VaultSpec): Promise<void>;
  rebuild(vault: VaultSpec): Promise<void>;
  render(vault: VaultSpec): Promise<void>;
  apply(vault: VaultSpec): Promise<void>;
  logs(vault: VaultSpec): Promise<void>;
  inspect(vault: VaultSpec): Promise<BackendObservation>;
  executeReconcilePlan(vault: VaultSpec, plan: ReconcilePlan): Promise<void>;
}
