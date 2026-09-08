import {
  withWorkspaceVersion,
  type WorkspaceMutationResult,
} from "@polaris/business-core/workspace-version";
import {
  verifyWanghaiGatewayRequest,
  WanghaiGatewayAuthError,
  type VerifiedWanghaiGatewayClaims,
} from "@/lib/gateway-auth";
import { assertWanghaiMutationAdmission } from "@/lib/mutation-admission";

/**
 * Wanghai verifies the signed adapter precondition, then serializes only the
 * local filesystem mutation. It does not make an authorization or quota
 * decision of its own.
 */
export async function mutateAdmittedWorkspace<T>(input: {
  mutate: (claims: VerifiedWanghaiGatewayClaims) => Promise<T> | T;
  request: Request;
  workspace: string;
  workspaceRoot: string;
}): Promise<WorkspaceMutationResult<T>> {
  const claims = await verifyWanghaiGatewayRequest(input.request);
  const admission = assertWanghaiMutationAdmission(input.request, claims);
  if (!admission || admission.workspace_id !== input.workspace) {
    throw new WanghaiGatewayAuthError("The Polaris mutation workspace scope is invalid", 403);
  }
  if (admission.expected_version === undefined) {
    throw new WanghaiGatewayAuthError("The Polaris mutation expected version is required", 403);
  }
  return withWorkspaceVersion({
    expectedVersion: admission.expected_version,
    mutate: () => input.mutate(claims),
    workspaceRoot: input.workspaceRoot,
  });
}
