import type { VaultSpec } from "../../core/vault.js";
import {
  PolarisBackendDriver,
  readKubevirtPersistedPaseoState as readRuntimeKubevirtPersistedPaseoState,
} from "../vault-runtime-adapter.js";

export class KubevirtDriver extends PolarisBackendDriver {
  constructor() {
    super("kubevirt-vm");
  }
}

export async function readKubevirtPersistedPaseoState(vault: VaultSpec): Promise<{
  serverId: string;
  pairing: Record<string, unknown> & { url: string };
} | null> {
  return readRuntimeKubevirtPersistedPaseoState(vault);
}
