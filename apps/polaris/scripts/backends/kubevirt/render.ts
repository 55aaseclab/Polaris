import type { VaultSpec } from "../../core/vault.js";
import { renderKubevirtVault } from "../vault-runtime-adapter.js";
import { writeGeneratedManifest } from "../../output/write-generated.js";

export { renderKubevirtVault } from "../vault-runtime-adapter.js";

export function renderAndWriteKubevirtVault(vault: VaultSpec): string {
  return writeGeneratedManifest(vault, renderKubevirtVault(vault));
}
