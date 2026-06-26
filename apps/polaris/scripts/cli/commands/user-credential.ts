import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { logInfo } from "../../utils/log.js";
import { resolveRepoRoot } from "../../utils/repo-root.js";

const REPO_ROOT = resolveRepoRoot(import.meta.url);

function profilePathFor(userProfileId: string): string {
  return path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
}

function userRootFor(userProfileId: string): string {
  return path.join(REPO_ROOT, "config", "users", userProfileId);
}

function credentialsRootFor(userProfileId: string): string {
  return path.join(userRootFor(userProfileId), "credentials");
}

function sanitizeCredentialId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function parseFlag(argv: string[], flag: string): string | undefined {
  const index = argv.findIndex((value) => value === flag);
  const value = index >= 0 ? argv[index + 1]?.trim() : "";
  return value ? value : undefined;
}

function ensureUserProfileExists(userProfileId: string): void {
  if (!fs.existsSync(profilePathFor(userProfileId))) {
    throw new Error(`User profile '${userProfileId}' was not found`);
  }
}

function ensureUniqueCredentialId(userProfileId: string, baseId: string): string {
  const registryRoot = credentialsRootFor(userProfileId);
  let candidate = baseId;
  let suffix = 2;
  while (fs.existsSync(path.join(registryRoot, `${candidate}.yaml`))) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }
  return candidate;
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

function createCodexConfigToml(args: {
  providerName: string;
  baseUrl: string;
}): string {
  return [
    `model_provider = ${JSON.stringify(args.providerName)}`,
    'model = "gpt-5.4"',
    'model_reasoning_effort = "medium"',
    'network_access = "enabled"',
    "disable_response_storage = true",
    "windows_wsl_setup_acknowledged = true",
    'model_verbosity = "high"',
    "model_context_window = 400000",
    "model_auto_compact_token_limit = 360000",
    "",
    `[model_providers.${args.providerName}]`,
    `name = ${JSON.stringify(args.providerName)}`,
    `base_url = ${JSON.stringify(args.baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "",
  ].join("\n");
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
  const registryRoot = credentialsRootFor(userProfileId);
  fs.mkdirSync(registryRoot, { recursive: true });

  const seedId = sanitizeCredentialId(credentialId ?? `codex-${providerName}`) || "codex";
  const finalCredentialId = credentialId
    ? seedId
    : ensureUniqueCredentialId(userProfileId, seedId);
  const materialDir = path.join(registryRoot, "codex", finalCredentialId);
  const authPath = path.join(materialDir, "auth.json");
  const configPath = path.join(materialDir, "config.toml");
  fs.mkdirSync(materialDir, { recursive: true });
  fs.writeFileSync(
    authPath,
    `${JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    configPath,
    createCodexConfigToml({ providerName, baseUrl }),
    "utf8",
  );

  const registryDocument = {
    id: finalCredentialId,
    userId: userProfileId,
    kind: "codex-auth",
    label,
    purposes: ["agent-auth"],
    materialRef: {
      type: "file",
      key: finalCredentialId,
      files: [
        {
          key: "codex-auth.json",
          source_path: `credentials/codex/${finalCredentialId}/auth.json`,
        },
        {
          key: "codex-config.toml",
          source_path: `credentials/codex/${finalCredentialId}/config.toml`,
        },
      ],
    },
    metadata: {
      harness: "codex",
      providerName,
      baseUrl,
      source: "portal",
    },
    status: "ready",
  };
  const registryPath = path.join(registryRoot, `${finalCredentialId}.yaml`);
  fs.writeFileSync(
    registryPath,
    yaml.dump(registryDocument, { lineWidth: 120, noRefs: true }),
    "utf8",
  );

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
          registryPath: `config/users/${userProfileId}/credentials/${finalCredentialId}.yaml`,
          paths: [
            `credentials/codex/${finalCredentialId}/auth.json`,
            `credentials/codex/${finalCredentialId}/config.toml`,
          ],
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
