import type { VaultSpec } from "../../core/vault.js";
import { renderPodVault } from "../vault-runtime-adapter.js";
import { writeGeneratedManifest } from "../../output/write-generated.js";

export { renderPodVault } from "../vault-runtime-adapter.js";

export function renderAndWritePodVault(vault: VaultSpec): string {
  return writeGeneratedManifest(vault, renderPodVault(vault));
}
