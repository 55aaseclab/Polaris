import test from "node:test";
import assert from "node:assert/strict";
import { createUserCommand } from "../scripts/cli/commands/create-user.js";
import { deletePortalUser, getPortalAiAccess, listUserPortalCredentials, performPortalAiAccessAction } from "../scripts/portal/service.js";
import {
  clearPortalAiAccessStateForTest,
  writePortalAiAccessStateForTest,
} from "../scripts/portal/ai-access.js";

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

test("AI access starts as not provisioned and moves to funding needed after provisioning", async () => {
  const userId = uniqueName("ai-access-provision");
  await createUserCommand([userId, "--name", "AI Access User", "--email", `${userId}@polaris.local`]);
  try {
    const initial = await getPortalAiAccess(userId);
    assert.equal(initial.state, "not_provisioned");
    assert.equal(initial.mainAction.primaryAction.kind, "provision_access");

    const provisioned = await performPortalAiAccessAction({
      userId,
      action: "provision_access",
    });
    assert.equal(provisioned.state, "funding_needed");
    assert.equal(provisioned.mainAction.primaryAction.kind, "top_up");
  } finally {
    clearPortalAiAccessStateForTest(userId);
    await deletePortalUser(userId);
  }
});

test("AI access top-up makes funded users ready and auto-creates runtime credentials", async () => {
  const userId = uniqueName("ai-access-ready");
  await createUserCommand([userId, "--name", "AI Access Ready User", "--email", `${userId}@polaris.local`]);
  try {
    await performPortalAiAccessAction({
      userId,
      action: "provision_access",
    });
    const funded = await performPortalAiAccessAction({
      userId,
      action: "top_up",
    });

    assert.equal(funded.state, "ready");
    assert.equal(funded.advanced.credentialSyncStatus, "ready");
    assert.equal(funded.mainAction.primaryAction.kind, "top_up");

    const credentials = listUserPortalCredentials(userId);
    assert.ok(
      credentials.some((credential) =>
        credential.harness === "codex" && credential.active,
      ),
    );
  } finally {
    clearPortalAiAccessStateForTest(userId);
    await deletePortalUser(userId);
  }
});

test("AI access surfaces automatic setup failures as error state", async () => {
  const userId = uniqueName("ai-access-error");
  await createUserCommand([userId, "--name", "AI Access Error User", "--email", `${userId}@polaris.local`]);
  try {
    await performPortalAiAccessAction({
      userId,
      action: "provision_access",
    });
    writePortalAiAccessStateForTest(userId, {
      simulateSetupFailure: true,
    });

    const errored = await performPortalAiAccessAction({
      userId,
      action: "top_up",
    });
    assert.equal(errored.state, "error");
    assert.equal(errored.mainAction.primaryAction.kind, "retry");
    assert.match(
      errored.advanced.lastErrorMessage ?? "",
      /runtime setup failure/i,
    );
  } finally {
    clearPortalAiAccessStateForTest(userId);
    await deletePortalUser(userId);
  }
});
