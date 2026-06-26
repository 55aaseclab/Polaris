import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIRNAME, "../../..");
const USER_MAP_PATH = path.join(REPO_ROOT, "apps", "polaris-web", "config", "user-map.json");
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
