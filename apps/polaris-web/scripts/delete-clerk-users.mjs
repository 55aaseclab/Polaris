import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIRNAME, "../../..");
const ENV_FILE = process.env.POLARIS_ENV_FILE?.trim() || path.join(REPO_ROOT, ".env.dev");

loadEnv({ path: ENV_FILE, quiet: true });

const CLERK_API_BASE = "https://api.clerk.com/v1";

async function clerkApi(pathname, init = {}) {
  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new Error(
      "CLERK_SECRET_KEY is required for Clerk deletion. Set it in the current environment or repo root .env.deploy/.env.dev.",
    );
  }
  const response = await fetch(`${CLERK_API_BASE}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(
      `Clerk API ${pathname} failed (${response.status}): ${await response.text()}`,
    );
  }
  if (response.status === 204) {
    return { skipped: false, payload: undefined };
  }
  return { skipped: false, payload: await response.json() };
}

async function findClerkUserIdsByUsername(usernames) {
  const normalized = [...new Set(usernames.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  if (normalized.length === 0) {
    return { skipped: false, userIds: [] };
  }
  const params = new URLSearchParams();
  for (const username of normalized) {
    params.append("username", username);
  }
  const result = await clerkApi(`/users?${params.toString()}`);
  const userIds = (result.payload ?? [])
    .filter((user) => user.username && normalized.includes(user.username.trim().toLowerCase()))
    .map((user) => user.id);
  return { skipped: false, userIds };
}

async function main() {
  const usernames = process.argv.slice(2);
  const lookup = await findClerkUserIdsByUsername(usernames);
  if (!lookup.skipped) {
    await Promise.all(
      lookup.userIds.map((userId) =>
        clerkApi(`/users/${encodeURIComponent(userId)}`, { method: "DELETE" })),
    );
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        removedUserIds: lookup.userIds,
        skipped: lookup.skipped,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
