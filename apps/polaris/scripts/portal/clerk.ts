const CLERK_API_BASE = "https://api.clerk.com/v1";

function readClerkSecretKey(): string {
  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) {
    return "";
  }
  return secretKey;
}

async function clerkApi(
  pathname: string,
  init: RequestInit = {},
): Promise<{
  skipped: false;
  payload: unknown;
}> {
  const secretKey = readClerkSecretKey();
  if (!secretKey) {
    throw new Error("Clerk API was requested without CLERK_SECRET_KEY");
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
    return { skipped: false, payload: null };
  }
  return { skipped: false, payload: await response.json() };
}

async function findClerkUserIdsByUsername(
  usernames: string[],
): Promise<string[]> {
  const normalized = [
    ...new Set(
      usernames
        .map((value) => String(value).trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (normalized.length === 0) {
    return [];
  }
  const params = new URLSearchParams();
  for (const username of normalized) {
    params.append("username", username);
  }
  const result = await clerkApi(`/users?${params.toString()}`);
  return Array.isArray(result.payload)
    ? result.payload
      .filter((user): user is { id: string; username: string } => {
        if (typeof user !== "object" || !user) {
          return false;
        }
        const candidate = user as Record<string, unknown>;
        return typeof candidate.id === "string" && typeof candidate.username === "string";
      })
      .filter((user) => normalized.includes(user.username.trim().toLowerCase()))
      .map((user) => user.id)
    : [];
}

export async function deleteClerkUsersByUsername(usernames: string[]): Promise<{
  removedUserIds: string[];
}> {
  if (!readClerkSecretKey()) {
    return { removedUserIds: [] };
  }
  const userIds = await findClerkUserIdsByUsername(usernames);
  await Promise.all(
    userIds.map((userId) =>
      clerkApi(`/users/${encodeURIComponent(userId)}`, { method: "DELETE" })),
  );
  return { removedUserIds: userIds };
}
