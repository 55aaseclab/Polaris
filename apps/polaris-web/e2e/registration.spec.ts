import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIRNAME, "../../..");
const USER_MAP_PATH = path.join(REPO_ROOT, "config", "users", "user-map.json");
const CLERK_API_BASE = "https://api.clerk.com/v1";

interface ClerkApiUser {
  id: string;
  username: string | null;
}

interface PolarisUserResponse {
  id: string;
  name: string;
  email: string;
}

const USER001_CLERK_USERNAME = "user001";
const USER001_PASSWORD = "user001";
const USER001_POLARIS_ID = "100000000000000001";

function publishableKey(): string {
  const value = process.env.VITE_CLERK_PUBLISHABLE_KEY?.trim();
  if (!value) {
    throw new Error("VITE_CLERK_PUBLISHABLE_KEY is required for Clerk E2E tests");
  }
  return value;
}

function frontendApiUrl(): string {
  const override = process.env.CLERK_FRONTEND_API_URL?.trim();
  if (override) {
    return override.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }
  const encoded = publishableKey().split("_").slice(2).join("_");
  return Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "");
}

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
    return;
  }
  delete current.users[clerkUsername];
  fs.writeFileSync(USER_MAP_PATH, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

function ensureUser001GitAuthFixture(): () => void {
  const credentialRoot = path.join(REPO_ROOT, "config", "users", USER001_POLARIS_ID, "credentials");
  const sshRoot = path.join(credentialRoot, "ssh");
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
      "  key: user-ssh-state/default",
      "  files:",
      "    - key: id_ed25519",
      "      source_path: credentials/ssh/id_ed25519",
      "    - key: id_ed25519.pub",
      "      source_path: credentials/ssh/id_ed25519.pub",
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

async function createMappedPolarisUser(
  request: import("@playwright/test").APIRequestContext,
  userProfileId: string,
  clerkUsername: string,
): Promise<PolarisUserResponse> {
  const response = await request.post("http://127.0.0.1:8787/api/users", {
    data: {
      userProfileId,
      clerkUsername,
      name: "E2E User",
      email: `${userProfileId}@polaris.local`,
      role: "user",
      plan: "free",
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<PolarisUserResponse>;
}

async function expectPolarisMapping(
  request: import("@playwright/test").APIRequestContext,
  clerkUsername: string,
  expectedUserId: string | null,
): Promise<void> {
  await expect
    .poll(async () => {
      const response = await request.get(
        `http://127.0.0.1:8787/api/user-mapping?clerkUsername=${encodeURIComponent(clerkUsername)}`,
      );
      expect(response.ok()).toBeTruthy();
      const payload = await response.json() as {
        mapping: { polarisUserId: string } | null;
      };
      return payload.mapping?.polarisUserId ?? null;
    })
    .toBe(expectedUserId);
}

async function deletePolarisUser(
  request: import("@playwright/test").APIRequestContext,
  userProfileId: string,
): Promise<void> {
  const response = await request.delete(
    `http://127.0.0.1:8787/api/users/${encodeURIComponent(userProfileId)}`,
  );
  if (response.status() === 404) {
    return;
  }
  expect(response.ok()).toBeTruthy();
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
    `http://127.0.0.1:8788/api/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspaceName)}`,
  );
  if (response.status() === 404 || options?.bestEffort) {
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

async function signInAsUsername(
  page: import("@playwright/test").Page,
  username: string,
  password: string,
): Promise<void> {
  await page.goto("/sign-in");
  await setupClerkTestingToken({
    page,
    options: { frontendApiUrl: frontendApiUrl() },
  });
  await clerk.signIn({
    page,
    signInParams: {
      strategy: "password",
      identifier: username,
      password,
    },
    setupClerkTestingTokenOptions: {
      frontendApiUrl: frontendApiUrl(),
    },
  });
}

test("registered username-only Clerk user is auto-created in Polaris on return", async ({ page }) => {
  const username = uniqueUsername();
  const password = uniquePassword();
  let clerkUserId: string | null = null;

  cleanupPolarisRegistration(username, username);

  try {
    const created = await createClerkUser(username, password);
    clerkUserId = created.id;

    await signInAsUsername(page, username, password);

    await page.goto("/?registered=1");
    await expect(page).toHaveURL(new RegExp(`/users/${username}/workspaces$`));
    await expect(
      page.getByRole("link", { name: /Add workspace|新增工作空间/ }),
    ).toHaveAttribute("href", new RegExp(`/users/${username}/workspaces#create-workspace$`));
    await expect(
      page.getByText(/No workspaces yet\.|暂无工作空间。/),
    ).toBeVisible();
    await expectPolarisMapping(page.request, username, username);
  } finally {
    cleanupPolarisRegistration(username, username);
    await deleteClerkUser(clerkUserId);
  }
});

test("existing mapped Clerk user lands in the mapped Polaris workspace route on sign in", async ({ page }) => {
  const username = uniqueUsername();
  const password = uniquePassword();
  let clerkUserId: string | null = null;

  cleanupPolarisRegistration(username, username);

  try {
    const created = await createClerkUser(username, password);
    clerkUserId = created.id;
    await createMappedPolarisUser(page.request, username, username);

    await signInAsUsername(page, username, password);
    await page.goto("/");

    await expect(page).toHaveURL(new RegExp(`/users/${username}/workspaces$`));
    await expect(
      page.getByRole("link", { name: /Add workspace|新增工作空间/ }),
    ).toHaveAttribute("href", new RegExp(`/users/${username}/workspaces#create-workspace$`));
    await expectPolarisMapping(page.request, username, username);
  } finally {
    cleanupPolarisRegistration(username, username);
    await deleteClerkUser(clerkUserId);
  }
});

test("deleting a Polaris user through the API removes the profile, secrets root, and Clerk mapping", async ({ page }) => {
  const username = uniqueUsername();
  const password = uniquePassword();
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${username}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", username);
  let clerkUserId: string | null = null;

  cleanupPolarisRegistration(username, username);

  try {
    const created = await createClerkUser(username, password);
    clerkUserId = created.id;
    await createMappedPolarisUser(page.request, username, username);

    expect(fs.existsSync(profilePath)).toBeTruthy();
    expect(fs.existsSync(userRoot)).toBeTruthy();
    await expectPolarisMapping(page.request, username, username);

    await deletePolarisUser(page.request, username);

    expect(fs.existsSync(profilePath)).toBeFalsy();
    expect(fs.existsSync(userRoot)).toBeFalsy();
    await expectPolarisMapping(page.request, username, null);
    await expect.poll(async () => (await findClerkUserByUsername(username))?.id ?? null).toBe(null);
  } finally {
    cleanupPolarisRegistration(username, username);
    await deleteClerkUser(clerkUserId);
  }
});

test("deleting a Polaris user from settings removes the profile, secrets root, and Clerk mapping", async ({ page }) => {
  const username = uniqueUsername();
  const password = uniquePassword();
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${username}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", username);
  let clerkUserId: string | null = null;

  cleanupPolarisRegistration(username, username);

  try {
    const created = await createClerkUser(username, password);
    clerkUserId = created.id;
    await createMappedPolarisUser(page.request, username, username);

    expect(fs.existsSync(profilePath)).toBeTruthy();
    expect(fs.existsSync(userRoot)).toBeTruthy();
    await expectPolarisMapping(page.request, username, username);

    await signInAsUsername(page, username, password);
    await page.goto(`/users/${encodeURIComponent(username)}/settings`);
    await page.getByRole("button", { name: /Delete user|删除用户/ }).click();
    await page.getByRole("button", { name: /Delete user|删除用户/ }).last().click();
    await expect(page).toHaveURL(/\/sign-in/);

    expect(fs.existsSync(profilePath)).toBeFalsy();
    expect(fs.existsSync(userRoot)).toBeFalsy();
    await expectPolarisMapping(page.request, username, null);
    await expect.poll(async () => (await findClerkUserByUsername(username))?.id ?? null).toBe(null);
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
    "projects",
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

  try {
    await signInAsUsername(page, USER001_CLERK_USERNAME, USER001_PASSWORD);
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

    await page.getByRole("button", { name: /Delete workspace|删除工作空间/ }).click();
    await page.getByRole("button", { name: /Delete workspace|删除工作空间/ }).last().click();
    await expect(page).toHaveURL(new RegExp(`/users/${USER001_POLARIS_ID}/workspaces$`));
    await expect
      .poll(() => fs.existsSync(workspaceRoot), { timeout: 30_000 })
      .toBe(false);
  } finally {
    await deleteWorkspaceByApi(page.request, USER001_POLARIS_ID, workspaceName, {
      bestEffort: true,
    });
    cleanupGitAuthFixture();
  }
});
