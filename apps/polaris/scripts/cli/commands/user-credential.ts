import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  credentialsRootFor,
  ensureUniqueCredentialId,
  ensureUserProfileExists,
  sanitizeCredentialId,
  writeCodexCredential,
} from "../../config/credentials.js";
import { logInfo } from "../../utils/log.js";
import { resolveRepoRoot } from "../../utils/repo-root.js";

const REPO_ROOT = resolveRepoRoot(import.meta.url);

function userRootFor(userProfileId: string): string {
  return path.join(REPO_ROOT, "config", "users", userProfileId);
}

function parseFlag(argv: string[], flag: string): string | undefined {
  const index = argv.findIndex((value) => value === flag);
  const value = index >= 0 ? argv[index + 1]?.trim() : "";
  return value ? value : undefined;
}

function removeEmptyParentDirs(start: string, stopAt: string): void {
  let current = path.dirname(start);
  while (current.startsWith(stopAt) && current !== stopAt) {
    if (!fs.existsSync(current)) {
      current = path.dirname(current);
      continue;
    }
    if (fs.readdirSync(current).length > 0) {
      return;
    }
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function parseCreateCredentialArgs(argv: string[]): {
  userProfileId: string;
  harness: "codex";
  credentialId?: string;
  label: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
} {
  const userProfileId = argv[0]?.trim();
  const harness = parseFlag(argv, "--harness") ?? "codex";
  const providerName = parseFlag(argv, "--provider-name") ?? "rightcode";
  const baseUrl = parseFlag(argv, "--base-url") ?? "https://right.codes/codex/v1";
  const label = parseFlag(argv, "--label") ?? `Codex ${providerName}`;
  const apiKey = parseFlag(argv, "--api-key") ?? "";
  const credentialId = parseFlag(argv, "--credential-id");
  if (!userProfileId) {
    throw new Error(
      "Usage: pnpm --dir apps/polaris run polaris -- user credential create <userProfileId> --harness codex [--credential-id <id>] [--label <label>] [--provider-name <name>] [--base-url <url>] [--api-key <key>]",
    );
  }
  if (harness !== "codex") {
    throw new Error(`Unsupported harness '${harness}'. Only 'codex' is supported`);
  }
  return {
    userProfileId,
    harness: "codex",
    ...(credentialId ? { credentialId } : {}),
    label,
    providerName,
    baseUrl,
    apiKey,
  };
}

function parseDeleteCredentialArgs(argv: string[]): {
  userProfileId: string;
  credentialId: string;
} {
  const userProfileId = argv[0]?.trim();
  const credentialId = argv[1]?.trim();
  if (!userProfileId || !credentialId) {
    throw new Error(
      "Usage: pnpm --dir apps/polaris run polaris -- user credential delete <userProfileId> <credentialId>",
    );
  }
  return { userProfileId, credentialId };
}

export async function createUserCredentialCommand(argv: string[]): Promise<void> {
  const {
    userProfileId,
    credentialId,
    label,
    providerName,
    baseUrl,
    apiKey,
  } = parseCreateCredentialArgs(argv);
  ensureUserProfileExists(userProfileId);
  const seedId = sanitizeCredentialId(credentialId ?? `codex-${providerName}`) || "codex";
  const finalCredentialId = credentialId
    ? seedId
    : ensureUniqueCredentialId(userProfileId, seedId);
  const created = writeCodexCredential({
    userProfileId,
    credentialId: finalCredentialId,
    label,
    providerName,
    baseUrl,
    apiKey,
  });

  logInfo("cli", "user-credential-created", {
    userProfileId,
    credentialId: finalCredentialId,
    harness: "codex",
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        credential: {
          id: finalCredentialId,
          userId: userProfileId,
          kind: "codex-auth",
          label,
          purposes: ["agent-auth"],
          status: "ready",
          registryPath: `config/users/${userProfileId}/credentials/${created.credentialId}.yaml`,
          paths: created.paths,
        },
      },
      null,
      2,
    )}\n`,
  );
}

export async function deleteUserCredentialCommand(argv: string[]): Promise<void> {
  const { userProfileId, credentialId } = parseDeleteCredentialArgs(argv);
  ensureUserProfileExists(userProfileId);
  const registryPath = path.join(credentialsRootFor(userProfileId), `${credentialId}.yaml`);
  const document = fs.existsSync(registryPath)
    ? (yaml.load(fs.readFileSync(registryPath, "utf8")) ?? {}) as Record<string, unknown>
    : null;
  const materialRef = document?.materialRef as Record<string, unknown> | undefined;
  const files = Array.isArray(materialRef?.files)
    ? materialRef.files as Array<Record<string, unknown>>
    : [];
  const userRoot = userRootFor(userProfileId);
  const removedPaths: string[] = [];

  for (const entry of files) {
    const sourcePath = String(entry.source_path ?? "").trim();
    if (!sourcePath) {
      continue;
    }
    const absolute = path.resolve(userRoot, sourcePath);
    if (absolute !== userRoot && !absolute.startsWith(`${userRoot}${path.sep}`)) {
      continue;
    }
    fs.rmSync(absolute, { force: true });
    removeEmptyParentDirs(absolute, userRoot);
    removedPaths.push(sourcePath);
  }

  const removed = fs.existsSync(registryPath) || removedPaths.length > 0;
  fs.rmSync(registryPath, { force: true });

  logInfo("cli", "user-credential-deleted", {
    userProfileId,
    credentialId,
    removed,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        credential: {
          id: credentialId,
          userId: userProfileId,
          removed,
          registryPath: `config/users/${userProfileId}/credentials/${credentialId}.yaml`,
          removedPaths,
        },
      },
      null,
      2,
    )}\n`,
  );
}
