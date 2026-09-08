import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readWorkspaceVersion,
  withWorkspaceVersion,
  WorkspaceVersionConflictError,
} from "../src/workspace-version.js";

function temporaryWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-workspace-version-"));
}

test("workspace mutations advance an expected local version atomically", async () => {
  const workspace = temporaryWorkspace();
  try {
    assert.equal(readWorkspaceVersion(workspace), 0);
    const first = await withWorkspaceVersion({
      expectedVersion: 0,
      mutate: () => {
        fs.writeFileSync(path.join(workspace, "result.txt"), "created\n", "utf8");
        return "created";
      },
      workspaceRoot: workspace,
    });
    assert.deepEqual(first, { result: "created", workspaceVersion: 1 });
    assert.equal(readWorkspaceVersion(workspace), 1);
    assert.equal(fs.readFileSync(path.join(workspace, "result.txt"), "utf8"), "created\n");

    await assert.rejects(
      withWorkspaceVersion({
        expectedVersion: 0,
        mutate: () => "must not run",
        workspaceRoot: workspace,
      }),
      (error: unknown) => error instanceof WorkspaceVersionConflictError
        && error.statusCode === 409
        && error.currentVersion === 1,
    );
  } finally {
    fs.rmSync(workspace, { force: true, recursive: true });
  }
});

test("workspace mutations reject a concurrent local writer", async () => {
  const workspace = temporaryWorkspace();
  let startMutation: (() => void) | undefined;
  let finishMutation: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startMutation = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finishMutation = resolve;
  });

  try {
    const first = withWorkspaceVersion({
      expectedVersion: 0,
      mutate: async () => {
        startMutation?.();
        await finished;
        return "first";
      },
      workspaceRoot: workspace,
    });
    await started;

    await assert.rejects(
      withWorkspaceVersion({
        expectedVersion: 0,
        mutate: () => "second",
        workspaceRoot: workspace,
      }),
      (error: unknown) => error instanceof WorkspaceVersionConflictError
        && error.statusCode === 409,
    );

    finishMutation?.();
    assert.deepEqual(await first, { result: "first", workspaceVersion: 1 });
  } finally {
    fs.rmSync(workspace, { force: true, recursive: true });
  }
});

test("a normal failed workspace mutation leaves its version unchanged", async () => {
  const workspace = temporaryWorkspace();
  try {
    await assert.rejects(
      withWorkspaceVersion({
        expectedVersion: 0,
        mutate: () => {
          throw new Error("synthetic failure");
        },
        workspaceRoot: workspace,
      }),
      /synthetic failure/u,
    );
    assert.equal(readWorkspaceVersion(workspace), 0);
  } finally {
    fs.rmSync(workspace, { force: true, recursive: true });
  }
});

test("workspace mutation recovery consumes an uncertain interrupted version", async () => {
  const workspace = temporaryWorkspace();
  try {
    const lockDirectory = path.join(workspace, ".wanghai-workspace-mutation-lock");
    fs.mkdirSync(lockDirectory);
    fs.writeFileSync(
      path.join(lockDirectory, "owner.json"),
      JSON.stringify({
        schema: "wanghai.workspace-mutation-lock.v1",
        instance_id: "synthetic-dead-instance",
        pid: 999_999,
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(workspace, ".wanghai-workspace-mutation-intent.json"),
      JSON.stringify({
        schema: "wanghai.workspace-mutation.v1",
        base_version: 0,
        next_version: 1,
      }),
      "utf8",
    );

    const recovered = await withWorkspaceVersion({
      expectedVersion: 1,
      mutate: () => "after-recovery",
      workspaceRoot: workspace,
    });
    assert.deepEqual(recovered, { result: "after-recovery", workspaceVersion: 2 });
    assert.equal(readWorkspaceVersion(workspace), 2);
  } finally {
    fs.rmSync(workspace, { force: true, recursive: true });
  }
});
