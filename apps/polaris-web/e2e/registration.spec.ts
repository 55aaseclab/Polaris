import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test, expect } from "@playwright/test";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIRNAME, "../../..");
const USER_MAP_PATH = path.join(REPO_ROOT, "config", "users", "user-map.json");
const CLERK_API_BASE = "https://api.clerk.com/v1";
const PLAYWRIGHT_WEB_BASE_URL = "http://127.0.0.1:14174";
const PLAYWRIGHT_API_BASE_URL = "http://127.0.0.1:18798";

interface ClerkApiUser {
  id: string;
  username: string | null;
}

interface UserMapEntry {
  polarisUserId: string;
  role?: string;
  plan?: string;
}

interface UserMapFile {
  users?: Record<string, UserMapEntry>;
  userIds?: Record<string, UserMapEntry>;
}

interface ClerkSession {
  id: string;
}

interface ClerkSessionToken {
  jwt: string;
}

interface PolarisUserResponse {
  id: string;
  name: string;
  email: string;
}

const USER001_CLERK_USERNAME = "user001";
const USER001_PASSWORD = "user001-pass";
const USER001_POLARIS_ID = "100000000000000001";

function clerkSecretKey(): string {
  const value = process.env.CLERK_SECRET_KEY?.trim();
  if (!value) {
    throw new Error("CLERK_SECRET_KEY is required for Clerk E2E tests");
  }
  return value;
}

function uniqueUsername(): string {
  return `e2e-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function uniquePassword(): string {
  return `PolarisE2E!${Date.now()}aa`;
}

async function clerkApi<T>(
  pathname: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${CLERK_API_BASE}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${clerkSecretKey()}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(
      `Clerk API ${pathname} failed (${response.status}): ${await response.text()}`,
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

async function createClerkUser(username: string, password: string): Promise<ClerkApiUser> {
  return clerkApi<ClerkApiUser>("/users", {
    method: "POST",
    body: JSON.stringify({
      username,
      password,
      first_name: "E2E",
      last_name: "User",
    }),
  });
}

async function ensureClerkUser(
  username: string,
  password: string,
): Promise<{ user: ClerkApiUser; created: boolean }> {
  const existing = await findClerkUserByUsername(username);
  if (existing) {
    return { user: existing, created: false };
  }
  const created = await createClerkUser(username, password);
  return { user: created, created: true };
}

async function deleteClerkUser(userId: string | null): Promise<void> {
  if (!userId) {
    return;
  }
  try {
    await clerkApi<void>(`/users/${encodeURIComponent(userId)}`, {
      method: "DELETE",
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("(404)")) {
      return;
    }
    throw error;
  }
}

async function findClerkUserByUsername(username: string): Promise<ClerkApiUser | null> {
  const params = new URLSearchParams();
  params.append("username", username);
  const users = await clerkApi<ClerkApiUser[]>(`/users?${params.toString()}`);
  return users.find((user) => user.username?.trim().toLowerCase() === username.trim().toLowerCase()) ?? null;
}

async function createClerkSessionToken(userId: string): Promise<string> {
  const session = await clerkApi<ClerkSession>("/sessions", {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
  const token = await clerkApi<ClerkSessionToken>(
    `/sessions/${encodeURIComponent(session.id)}/tokens`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
  return token.jwt;
}

function cleanupPolarisRegistration(clerkUsername: string, userId: string): void {
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userId);
  fs.rmSync(profilePath, { force: true });
  fs.rmSync(userRoot, { recursive: true, force: true });
  if (!fs.existsSync(USER_MAP_PATH)) {
    return;
  }
  const current = JSON.parse(fs.readFileSync(USER_MAP_PATH, "utf8")) as {
    users?: Record<string, { polarisUserId: string }>;
  };
  if (!current.users?.[clerkUsername]) {
    if (current.userIds) {
      for (const [clerkUserId, entry] of Object.entries(current.userIds)) {
        if (entry?.polarisUserId === userId) {
          delete current.userIds[clerkUserId];
        }
      }
      fs.writeFileSync(USER_MAP_PATH, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    }
    return;
  }
  delete current.users[clerkUsername];
  if (current.userIds) {
    for (const [clerkUserId, entry] of Object.entries(current.userIds)) {
      if (entry?.polarisUserId === userId) {
        delete current.userIds[clerkUserId];
      }
    }
  }
  fs.writeFileSync(USER_MAP_PATH, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

function ensureUser001PolarisMapping(clerkUserId: string): () => void {
  const original = fs.existsSync(USER_MAP_PATH)
    ? fs.readFileSync(USER_MAP_PATH, "utf8")
    : null;
  const current = original
    ? (JSON.parse(original) as UserMapFile)
    : { users: {}, userIds: {} } satisfies UserMapFile;
  current.users ??= {};
  current.userIds ??= {};
  current.users[USER001_CLERK_USERNAME] = {
    polarisUserId: USER001_POLARIS_ID,
    role: "user",
    plan: "free",
  };
  current.userIds[clerkUserId] = {
    polarisUserId: USER001_POLARIS_ID,
    role: "user",
    plan: "free",
  };
  fs.writeFileSync(USER_MAP_PATH, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  return () => {
    if (original === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
      return;
    }
    fs.writeFileSync(USER_MAP_PATH, original, "utf8");
  };
}

async function createPortalUserByApi(
  input: {
    clerkUsername: string;
    clerkUserId: string;
    polarisUserId: string;
    role: "admin" | "user";
    plan?: "free" | "pro";
  },
): Promise<void> {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "polaris",
      "run",
      "polaris",
      "--",
      "user",
      "create",
      input.polarisUserId,
      "--name",
      input.polarisUserId,
      "--email",
      `${input.polarisUserId}@example.test`,
      "--clerk",
      input.clerkUsername,
      "--clerk-user-id",
      input.clerkUserId,
      "--role",
      input.role,
      "--plan",
      input.plan ?? "free",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        POLARIS_DATA_ROOT: process.env.POLARIS_DATA_ROOT ?? "./config",
      },
    },
  );
  expect(
    {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    },
  ).toMatchObject({
    status: 0,
  });
}

function ensureUser001GitAuthFixture(): () => void {
  const credentialRoot = path.join(REPO_ROOT, "config", "users", USER001_POLARIS_ID, "credentials");
  const sshRoot = path.join(credentialRoot, "ssh", "github-ssh");
  const credentialPath = path.join(credentialRoot, "github-ssh.yaml");
  const privateKeyPath = path.join(sshRoot, "id_ed25519");
  const publicKeyPath = path.join(sshRoot, "id_ed25519.pub");
  const originalCredential = fs.existsSync(credentialPath) ? fs.readFileSync(credentialPath, "utf8") : null;
  const created: string[] = [];

  fs.mkdirSync(sshRoot, { recursive: true });

  if (!fs.existsSync(privateKeyPath)) {
    fs.writeFileSync(
      privateKeyPath,
      [
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "placeholder-user001-test-key",
        "-----END OPENSSH PRIVATE KEY-----",
        "",
      ].join("\n"),
      "utf8",
    );
    created.push(privateKeyPath);
  }
  if (!fs.existsSync(publicKeyPath)) {
    fs.writeFileSync(
      publicKeyPath,
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestUser001 user001@polaris.local\n",
      "utf8",
    );
    created.push(publicKeyPath);
  }
  fs.writeFileSync(
    credentialPath,
    [
      "id: github-ssh",
      `userId: \"${USER001_POLARIS_ID}\"`,
      "kind: ssh-key",
      "label: Demo SSH key",
      "purposes:",
      "  - git-auth",
      "  - ssh-auth",
      "materialRef:",
      "  type: file",
      "  key: github-ssh",
      "  files:",
      "    - key: id_ed25519",
      "      source_path: credentials/ssh/github-ssh/id_ed25519",
      "    - key: id_ed25519.pub",
      "      source_path: credentials/ssh/github-ssh/id_ed25519.pub",
      "status: ready",
      "",
    ].join("\n"),
    "utf8",
  );
  if (originalCredential === null) {
    created.push(credentialPath);
  }

  return () => {
    if (originalCredential !== null) {
      fs.writeFileSync(credentialPath, originalCredential, "utf8");
    }
    for (const filePath of created) {
      fs.rmSync(filePath, { force: true });
    }
  };
}

function readPolarisMapping(clerkUsername: string): string | null {
  if (!fs.existsSync(USER_MAP_PATH)) {
    return null;
  }
  const current = JSON.parse(fs.readFileSync(USER_MAP_PATH, "utf8")) as {
    users?: Record<string, { polarisUserId: string }>;
  };
  return current.users?.[clerkUsername]?.polarisUserId ?? null;
}

async function expectPolarisMapping(
  clerkUsername: string,
  expectedUserId: string | null,
): Promise<void> {
  await expect
    .poll(async () => {
      return readPolarisMapping(clerkUsername);
    })
    .toBe(expectedUserId);
}

async function deleteWorkspaceByApi(
  request: import("@playwright/test").APIRequestContext,
  userId: string,
  workspaceName: string,
  options?: {
    bestEffort?: boolean;
  },
): Promise<void> {
  const response = await request.delete(
    `${PLAYWRIGHT_API_BASE_URL}/api/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspaceName)}`,
  );
  if (response.status() === 404 || options?.bestEffort) {
    return;
  }
  expect(response.ok()).toBeTruthy();
}

async function stopWorkspaceByApi(
  request: import("@playwright/test").APIRequestContext,
  userId: string,
  workspaceName: string,
): Promise<void> {
  const response = await request.post(
    `${PLAYWRIGHT_API_BASE_URL}/api/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspaceName)}/stop`,
  );
  if (response.status() === 404) {
    return;
  }
  expect(response.ok()).toBeTruthy();
}

function dockerContainerState(containerName: string): "running" | "stopped" | "missing" {
  const inspect = spawnSync("docker", ["inspect", containerName], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (inspect.status !== 0) {
    return "missing";
  }
  try {
    const parsed = JSON.parse(inspect.stdout) as Array<{ State?: { Running?: boolean } }>;
    return parsed[0]?.State?.Running ? "running" : "stopped";
  } catch {
    return "stopped";
  }
}

async function signInAsClerkUser(
  page: import("@playwright/test").Page,
  clerkUserId: string,
): Promise<void> {
  const jwt = await createClerkSessionToken(clerkUserId);
  await page.context().addCookies([
    {
      name: "__session",
      value: jwt,
      url: `${PLAYWRIGHT_WEB_BASE_URL}/`,
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/");
}

test("registered username-only Clerk user is auto-created in Polaris on return", async ({ page }) => {
  const username = uniqueUsername();
  const password = uniquePassword();
  let clerkUserId: string | null = null;

  cleanupPolarisRegistration(username, username);

  try {
    const created = await createClerkUser(username, password);
    clerkUserId = created.id;

    await signInAsClerkUser(page, created.id);
    await page.goto("/");
    await expectPolarisMapping(username, username);
    await page.goto(`/users/${encodeURIComponent(username)}/workspaces`);
    await expect(
      page
        .getByRole("main")
        .getByRole("button", { name: /Create now|立即创建/ }),
    ).toBeVisible();
    await expect(
      page.getByText(/No workspaces yet\.|暂无工作空间。/),
    ).toBeVisible();
    await expectPolarisMapping(username, username);
  } finally {
    cleanupPolarisRegistration(username, username);
    await deleteClerkUser(clerkUserId);
  }
});

test("user001 can create a default-docker workspace, inspect docker assets, and delete it", async ({ page }) => {
  test.setTimeout(900_000);
  const cleanupGitAuthFixture = ensureUser001GitAuthFixture();
  const workspaceName = `e2e-ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const containerName = `${workspaceName}-docker`;
  const workspaceRoot = path.join(
    REPO_ROOT,
    "config",
    "users",
    USER001_POLARIS_ID,
    "workspaces",
    workspaceName,
  );
  const userDockerfilePath = path.join(
    REPO_ROOT,
    "config",
    "users",
    USER001_POLARIS_ID,
    "docker",
    "workspace-prebuilt.Dockerfile",
  );
  let createdUser001 = false;
  let restoreUser001Mapping: (() => void) | null = null;

  try {
    const ensured = await ensureClerkUser(USER001_CLERK_USERNAME, USER001_PASSWORD);
    createdUser001 = ensured.created;
    restoreUser001Mapping = ensureUser001PolarisMapping(ensured.user.id);
    await signInAsClerkUser(page, ensured.user.id);
    await page.goto(`/users/${USER001_POLARIS_ID}/workspaces`);

    await page.getByRole("button", { name: /Add workspace|新增工作空间/ }).click();
    await page.getByLabel(/Workspace name|工作空间名称/).fill(workspaceName);
    await expect(page.getByLabel(/Create and start|创建并启动/)).toBeChecked();
    await page.getByRole("button", { name: /Create workspace|创建工作空间/ }).click();
    await expect(page).toHaveURL(
      new RegExp(`/users/${USER001_POLARIS_ID}/workspaces/${encodeURIComponent(workspaceName)}$`),
      { timeout: 900_000 },
    );

    await expect
      .poll(
        async () => fs.existsSync(path.join(workspaceRoot, "generated", "docker.yaml")),
        { timeout: 900_000 },
      )
      .toBe(true);

    await expect
      .poll(() => dockerContainerState(containerName), { timeout: 900_000 })
      .toBe("running");

    expect(fs.existsSync(userDockerfilePath)).toBe(true);
    expect(fs.existsSync(path.join(workspaceRoot, "docker.agent.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(workspaceRoot, "generated", "docker.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(workspaceRoot, "pod.agent.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(workspaceRoot, "kubevirt.agent.yaml"))).toBe(false);

    await page.goto(`/users/${USER001_POLARIS_ID}/workspaces/${encodeURIComponent(workspaceName)}/controls`);
    await page.getByRole("button", { name: /Stop workspace|停止工作空间/ }).click();

    await expect
      .poll(() => dockerContainerState(containerName), { timeout: 60_000 })
      .toBe("stopped");

    await page.goto(`/users/${USER001_POLARIS_ID}/workspaces/${encodeURIComponent(workspaceName)}/controls`);
    await page.getByRole("button", { name: /Archive workspace|归档工作空间/ }).click();
    await page.getByRole("button", { name: /Archive workspace|归档工作空间/ }).last().click();
    await expect(page).toHaveURL(new RegExp(`/users/${USER001_POLARIS_ID}/workspaces$`));
    await expect
      .poll(() => fs.existsSync(workspaceRoot), { timeout: 30_000 })
      .toBe(false);
  } finally {
    await deleteWorkspaceByApi(page.request, USER001_POLARIS_ID, workspaceName, {
      bestEffort: true,
    });
    if (createdUser001) {
      const user = await findClerkUserByUsername(USER001_CLERK_USERNAME);
      await deleteClerkUser(user?.id ?? null);
    }
    restoreUser001Mapping?.();
    cleanupGitAuthFixture();
  }
});

test("user001 lands in their own Polaris workspace route after sign in", async ({ page }) => {
  const ensured = await ensureClerkUser(USER001_CLERK_USERNAME, USER001_PASSWORD);
  const restoreUser001Mapping = ensureUser001PolarisMapping(ensured.user.id);
  try {
    await signInAsClerkUser(page, ensured.user.id);
    await page.goto("/");

    await expect(page).toHaveURL(
      new RegExp(`/users/${USER001_POLARIS_ID}/workspaces$`),
    );
    await expect(
      page.getByRole("button", { name: /Add workspace|新增工作空间|立即创建/ }),
    ).toBeVisible();
  } finally {
    restoreUser001Mapping();
  }
});

test("creating a workspace from the user workspace route switches sidebar selection to the new workspace", async ({ page }) => {
  test.setTimeout(180_000);
  const username = uniqueUsername();
  const password = uniquePassword();
  const workspaceName = `e2e-switch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let clerkUserId: string | null = null;
  try {
    const created = await createClerkUser(username, password);
    clerkUserId = created.id;
    await createPortalUserByApi({
      clerkUsername: username,
      clerkUserId: created.id,
      polarisUserId: username,
      role: "user",
    });
    try {
      await signInAsClerkUser(page, created.id);
      await page.goto(`/users/${encodeURIComponent(username)}/workspaces`);

      await page
        .getByRole("main")
        .getByRole("button", { name: /Create now|立即创建/ })
        .click();
      await page.getByLabel(/Workspace name|工作空间名称/).fill(workspaceName);
      await page.getByRole("button", { name: /Create workspace|创建工作空间/ }).click();

      await expect(page).toHaveURL(
        new RegExp(`/users/${encodeURIComponent(username)}/workspaces/${encodeURIComponent(workspaceName)}$`),
        { timeout: 120_000 },
      );
      await expect(
        page.getByRole("link", { name: new RegExp(workspaceName, "i") }),
      ).toHaveAttribute("data-active", "true");
      await expect(
        page.locator(`iframe[title="${username}:${workspaceName} paseo"]`),
      ).toBeVisible({ timeout: 60_000 });
    } finally {
      await deleteWorkspaceByApi(page.request, username, workspaceName, {
        bestEffort: true,
      });
    }
  } finally {
    cleanupPolarisRegistration(username, username);
    await deleteClerkUser(clerkUserId);
  }
});

test("creating a workspace from the admin pane stays in the admin pane", async ({ page }) => {
  test.setTimeout(180_000);
  const adminUsername = uniqueUsername();
  const adminPassword = uniquePassword();
  const targetUsername = uniqueUsername();
  const targetPassword = uniquePassword();
  const workspaceName = `e2e-admin-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let adminClerkUserId: string | null = null;
  let targetClerkUserId: string | null = null;
  try {
    const admin = await createClerkUser(adminUsername, adminPassword);
    adminClerkUserId = admin.id;
    const target = await createClerkUser(targetUsername, targetPassword);
    targetClerkUserId = target.id;
    await createPortalUserByApi({
      clerkUsername: adminUsername,
      clerkUserId: admin.id,
      polarisUserId: adminUsername,
      role: "admin",
    });
    await createPortalUserByApi({
      clerkUsername: targetUsername,
      clerkUserId: target.id,
      polarisUserId: targetUsername,
      role: "user",
    });
    try {
      await signInAsClerkUser(page, admin.id);
      await expect(page).toHaveURL(
        new RegExp(`/users/${encodeURIComponent(adminUsername)}/workspaces$`),
      );
      await page.goto(`/users/${encodeURIComponent(adminUsername)}/admin`);

      await page.getByRole("button", { name: new RegExp(targetUsername, "i") }).click();
      await page.getByRole("tab", { name: /Workspaces|工作空间/ }).click();
      await page.getByPlaceholder(/Workspace name|工作空间名称/).fill(workspaceName);
      await page.getByRole("button", { name: /Create workspace|创建工作空间/ }).click();

      await expect(page).toHaveURL(
        new RegExp(`/users/${encodeURIComponent(adminUsername)}/admin$`),
        { timeout: 120_000 },
      );
      await expect(page.getByText(workspaceName)).toBeVisible({ timeout: 120_000 });
    } finally {
      await deleteWorkspaceByApi(page.request, targetUsername, workspaceName, {
        bestEffort: true,
      });
    }
  } finally {
    cleanupPolarisRegistration(targetUsername, targetUsername);
    cleanupPolarisRegistration(adminUsername, adminUsername);
    await deleteClerkUser(targetClerkUserId);
    await deleteClerkUser(adminClerkUserId);
  }
});

test("entering a workspace from the admin pane lets the sidebar runtime status converge without another click", async ({ page }) => {
  test.setTimeout(180_000);
  const adminUsername = uniqueUsername();
  const adminPassword = uniquePassword();
  const targetUsername = uniqueUsername();
  const targetPassword = uniquePassword();
  const workspaceName = `e2e-admin-open-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let adminClerkUserId: string | null = null;
  let targetClerkUserId: string | null = null;
  try {
    const admin = await createClerkUser(adminUsername, adminPassword);
    adminClerkUserId = admin.id;
    const target = await createClerkUser(targetUsername, targetPassword);
    targetClerkUserId = target.id;
    await createPortalUserByApi({
      clerkUsername: adminUsername,
      clerkUserId: admin.id,
      polarisUserId: adminUsername,
      role: "admin",
    });
    await createPortalUserByApi({
      clerkUsername: targetUsername,
      clerkUserId: target.id,
      polarisUserId: targetUsername,
      role: "user",
    });
    try {
      await signInAsClerkUser(page, admin.id);
      await expect(page).toHaveURL(
        new RegExp(`/users/${encodeURIComponent(adminUsername)}/workspaces$`),
      );
      await page.goto(`/users/${encodeURIComponent(adminUsername)}/admin`);

      await page.getByRole("button", { name: new RegExp(targetUsername, "i") }).click();
      await page.getByRole("tab", { name: /Workspaces|工作空间/ }).click();
      await page.getByPlaceholder(/Workspace name|工作空间名称/).fill(workspaceName);
      await page.getByRole("button", { name: /Create workspace|创建工作空间/ }).click();

      await expect(page.getByText(workspaceName)).toBeVisible({ timeout: 120_000 });

      await page.getByRole("link", { name: /Open workspace|进入工作空间/ }).click();

      await expect(page).toHaveURL(
        new RegExp(
          `/users/${encodeURIComponent(adminUsername)}/admin/users/${encodeURIComponent(targetUsername)}/workspaces/${encodeURIComponent(workspaceName)}$`,
        ),
        { timeout: 15_000 },
      );

      const sidebarWorkspaceButton = page
        .locator('[data-sidebar="menu-button"]')
        .filter({ hasText: workspaceName })
        .first();

      await expect(sidebarWorkspaceButton).toHaveAttribute("data-active", "true", {
        timeout: 15_000,
      });
      await expect(sidebarWorkspaceButton.locator("svg.animate-spin")).toHaveCount(0, {
        timeout: 180_000,
      });
    } finally {
      await stopWorkspaceByApi(page.request, targetUsername, workspaceName);
      await deleteWorkspaceByApi(page.request, targetUsername, workspaceName, {
        bestEffort: true,
      });
    }
  } finally {
    cleanupPolarisRegistration(targetUsername, targetUsername);
    cleanupPolarisRegistration(adminUsername, adminUsername);
    await deleteClerkUser(targetClerkUserId);
    await deleteClerkUser(adminClerkUserId);
  }
});

test("user001 cannot access the admin page", async ({ page }) => {
  const ensured = await ensureClerkUser(USER001_CLERK_USERNAME, USER001_PASSWORD);
  const restoreUser001Mapping = ensureUser001PolarisMapping(ensured.user.id);
  try {
    await signInAsClerkUser(page, ensured.user.id);
    await page.goto(`/users/${USER001_POLARIS_ID}/admin`);

    await expect(page).toHaveURL(
      new RegExp(`/users/${USER001_POLARIS_ID}/workspaces$`),
    );
    await expect(
      page.getByRole("button", { name: /Add workspace|新增工作空间|立即创建/ }),
    ).toBeVisible();
  } finally {
    restoreUser001Mapping();
  }
});
