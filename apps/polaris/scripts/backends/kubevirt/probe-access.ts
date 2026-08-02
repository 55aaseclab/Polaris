import crypto from "node:crypto";
import type { VaultSpec } from "../../core/vault.js";

export function kubevirtProbePassword(vault: VaultSpec): string {
  const digest = crypto
    .createHash("sha256")
    .update(`polaris:kubevirt-probe:${vault.userProfile.id}:${vault.identity.projectName}`)
    .digest("hex");
  return `probe-${digest.slice(0, 24)}`;
}

