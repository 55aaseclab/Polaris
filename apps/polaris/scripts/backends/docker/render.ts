import type { VaultSpec } from "../../core/vault.js";
import { renderDockerVault } from "../vault-runtime-adapter.js";
import { writeGeneratedManifest } from "../../output/write-generated.js";

export { renderDockerVault } from "../vault-runtime-adapter.js";

export function renderAndWriteDockerVault(vault: VaultSpec): string {
  return writeGeneratedManifest(vault, renderDockerVault(vault));
}
