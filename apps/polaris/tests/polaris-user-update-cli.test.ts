import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import { runCli } from "../scripts/cli/main.js";
import { polarisUsersRoot } from "../scripts/utils/paths.js";

const USER_ROOT = polarisUsersRoot(import.meta.url);
const STDOUT_CAPTURE_QUEUE_KEY = "__polaris_user_update_stdout_capture_queue__";

function uniqueUserId(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

function getStdoutCaptureQueue(): Promise<void> {
  const existing = (globalThis as Record<string, unknown>)[
    STDOUT_CAPTURE_QUEUE_KEY
  ];
  return existing instanceof Promise
    ? (existing as Promise<void>)
    : Promise.resolve();
}

function setStdoutCaptureQueue(queue: Promise<void>): void {
  (globalThis as Record<string, unknown>)[STDOUT_CAPTURE_QUEUE_KEY] = queue;
}

async function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const previous = getStdoutCaptureQueue();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  setStdoutCaptureQueue(next);
  await previous;
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    chunks.push(
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString("utf8"),
    );
    const callback = args.find(
      (arg) => typeof arg === "function",
    ) as (() => void) | undefined;
    callback?.();
    return true;
  }) as typeof process.stdout.write;

  try {
    await fn();
    return chunks.join("");
  } finally {
    process.stdout.write = originalWrite;
    release();
  }
}

function parseJsonOutput<T>(stdout: string): T {
  const trimmed = stdout.trim();
  const end = trimmed.lastIndexOf("}");
  if (end === -1) {
    throw new Error(`No JSON object found in stdout: ${JSON.stringify(trimmed)}`);
  }
  for (
    let start = trimmed.lastIndexOf("{", end);
    start !== -1;
    start = trimmed.lastIndexOf("{", start - 1)
  ) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    } catch {
      continue;
    }
  }
  throw new Error(`No JSON object found in stdout: ${JSON.stringify(trimmed)}`);
}

async function cleanupUser(input: {
  userId: string;
  profilePath: string;
  userRoot: string;
  userMapPath: string;
  originalUserMap: string | null;
}): Promise<void> {
  try {
    await runCli(["user", "delete", input.userId]);
  } catch {
    // Best-effort cleanup. Direct file cleanup follows.
  } finally {
    fs.rmSync(input.profilePath, { force: true });
    fs.rmSync(input.userRoot, { recursive: true, force: true });
    if (input.originalUserMap === null) {
      fs.rmSync(input.userMapPath, { force: true });
    } else {
      fs.writeFileSync(input.userMapPath, input.originalUserMap, "utf8");
    }
  }
}

test("runCli user update mutates profile and access fields together", async () => {
  const userId = uniqueUserId("cli-user-update");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);
  const userMapPath = path.join(USER_ROOT, "user-map.json");
  const originalUserMap = fs.existsSync(userMapPath)
    ? fs.readFileSync(userMapPath, "utf8")
    : null;

  try {
    await runCli([
      "user",
      "create",
      userId,
      "--name",
      "Original User",
      "--email",
      `${userId}@polaris.local`,
      "--authing",
      `${userId}@example.test`,
      "--authing-user-id",
      `${userId}-authing`,
      "--role",
      "user",
      "--plan",
      "free",
      "--line",
      "coding",
    ]);

    const stdout = await captureStdout(async () => {
      await runCli([
        "user",
        "update",
        userId,
        "--name",
        "Updated User",
        "--email",
        `updated-${userId}@polaris.local`,
        "--github-account",
        "updated-github",
        "--ssh-comment",
        "updated ssh comment",
        "--role",
        "admin",
        "--plan",
        "pro",
        "--line",
        "both",
      ]);
    });

    const parsed = parseJsonOutput<{
      userProfile: {
        id: string;
        name: string;
        email: string;
        githubAccount?: string;
        sshComment?: string;
      };
      access: {
        polarisUserId: string;
        role: string;
        plan: string;
        line: string;
        authingUsernames: string[];
        authingUserIds: string[];
      } | null;
    }>(stdout);

    assert.equal(parsed.userProfile.id, userId);
    assert.equal(parsed.userProfile.name, "Updated User");
    assert.equal(parsed.userProfile.email, `updated-${userId}@polaris.local`);
    assert.equal(parsed.userProfile.githubAccount, "updated-github");
    assert.equal(parsed.userProfile.sshComment, "updated ssh comment");
    assert.equal(parsed.access?.polarisUserId, userId);
    assert.equal(parsed.access?.role, "admin");
    assert.equal(parsed.access?.plan, "pro");
    assert.equal(parsed.access?.line, "both");
    assert.deepEqual(parsed.access?.authingUsernames, [`${userId}@example.test`]);
    assert.deepEqual(parsed.access?.authingUserIds, [`${userId}-authing`]);

    const profile = (yaml.load(fs.readFileSync(profilePath, "utf8")) ?? {}) as {
      name?: string;
      email?: string;
      github?: { account?: string };
      ssh?: { comment?: string };
    };
    assert.equal(profile.name, "Updated User");
    assert.equal(profile.email, `updated-${userId}@polaris.local`);
    assert.equal(profile.github?.account, "updated-github");
    assert.equal(profile.ssh?.comment, "updated ssh comment");

    const userMap = JSON.parse(fs.readFileSync(userMapPath, "utf8")) as {
      users?: Record<string, { role: string; plan: string; line: string }>;
      userIds?: Record<string, { role: string; plan: string; line: string }>;
    };
    assert.deepEqual(userMap.users?.[`${userId}@example.test`], {
      polarisUserId: userId,
      role: "admin",
      plan: "pro",
      line: "both",
    });
    assert.deepEqual(userMap.userIds?.[`${userId}-authing`], {
      polarisUserId: userId,
      role: "admin",
      plan: "pro",
      line: "both",
    });
  } finally {
    await cleanupUser({
      userId,
      profilePath,
      userRoot,
      userMapPath,
      originalUserMap,
    });
  }
});

test("runCli user update rejects an empty patch", async () => {
  const userId = uniqueUserId("cli-user-update-empty");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);
  const userMapPath = path.join(USER_ROOT, "user-map.json");
  const originalUserMap = fs.existsSync(userMapPath)
    ? fs.readFileSync(userMapPath, "utf8")
    : null;

  try {
    await runCli([
      "user",
      "create",
      userId,
      "--name",
      "Empty Patch User",
      "--email",
      `${userId}@polaris.local`,
    ]);

    await assert.rejects(
      () => runCli(["user", "update", userId]),
      /At least one profile or access field is required/,
    );
  } finally {
    await cleanupUser({
      userId,
      profilePath,
      userRoot,
      userMapPath,
      originalUserMap,
    });
  }
});
