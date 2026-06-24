import crypto from "node:crypto";
import type { WorkspaceSpec } from "../../core/workspace.js";

export function kubevirtProbePassword(workspace: WorkspaceSpec): string {
  const digest = crypto
    .createHash("sha256")
    .update(`polaris:kubevirt-probe:${workspace.userProfile.id}:${workspace.identity.projectName}`)
    .digest("hex");
  return `probe-${digest.slice(0, 24)}`;
}

