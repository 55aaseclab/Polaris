import type { VaultSpec } from "../../core/vault.js";
import { kubevirtProbePassword as resolveKubevirtProbePassword } from "../vault-runtime-adapter.js";

export function kubevirtProbePassword(vault: VaultSpec): string {
  return resolveKubevirtProbePassword(vault);
}
