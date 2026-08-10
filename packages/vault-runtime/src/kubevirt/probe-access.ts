import crypto from "node:crypto";
import type { VaultRuntimeSpec } from "../types.js";

export function kubevirtProbePassword(vault: VaultRuntimeSpec): string {
  const digest = crypto
    .createHash("sha256")
    .update(`polaris:kubevirt-probe:${vault.userProfile.id}:${vault.identity.projectName}`)
    .digest("hex");
  return `probe-${digest.slice(0, 24)}`;
}
