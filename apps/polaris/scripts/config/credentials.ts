import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { resolveRepoRoot } from "../utils/repo-root.js";

const REPO_ROOT = resolveRepoRoot(import.meta.url);
const USER_ROOT = path.join(REPO_ROOT, "config", "users");
const USER_PROFILES_ROOT = path.join(USER_ROOT, "profiles");

function profilePathFor(userProfileId: string): string {
  return path.join(USER_PROFILES_ROOT, `${userProfileId}.yaml`);
}

function userRootFor(userProfileId: string): string {
  return path.join(USER_ROOT, userProfileId);
}

export function credentialsRootFor(userProfileId: string): string {
  return path.join(userRootFor(userProfileId), "credentials");
}

export function sanitizeCredentialId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function ensureUserProfileExists(userProfileId: string): void {
  if (!fs.existsSync(profilePathFor(userProfileId))) {
    throw new Error(`User profile '${userProfileId}' was not found`);
  }
}

export function ensureUniqueCredentialId(userProfileId: string, baseId: string): string {
  const registryRoot = credentialsRootFor(userProfileId);
  let candidate = baseId;
  let suffix = 2;
  while (fs.existsSync(path.join(registryRoot, `${candidate}.yaml`))) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function createCodexConfigToml(args: {
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

export function writeCodexCredential(args: {
  userProfileId: string;
  credentialId?: string;
  label: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  ensureIfMissing?: boolean;
}): {
  credentialId: string;
  created: boolean;
  registryPath: string;
  paths: string[];
} {
  ensureUserProfileExists(args.userProfileId);
  const registryRoot = credentialsRootFor(args.userProfileId);
  fs.mkdirSync(registryRoot, { recursive: true });

  const seedId = sanitizeCredentialId(args.credentialId ?? `codex-${args.providerName}`) || "codex";
  const finalCredentialId = args.credentialId
    ? seedId
    : ensureUniqueCredentialId(args.userProfileId, seedId);
  const registryPath = path.join(registryRoot, `${finalCredentialId}.yaml`);
  if (args.ensureIfMissing && fs.existsSync(registryPath)) {
    return {
      credentialId: finalCredentialId,
      created: false,
      registryPath,
      paths: [
        `credentials/codex/${finalCredentialId}/auth.json`,
        `credentials/codex/${finalCredentialId}/config.toml`,
      ],
    };
  }

  const materialDir = path.join(registryRoot, "codex", finalCredentialId);
  const authPath = path.join(materialDir, "auth.json");
  const configPath = path.join(materialDir, "config.toml");
  fs.mkdirSync(materialDir, { recursive: true });
  fs.writeFileSync(
    authPath,
    `${JSON.stringify({ OPENAI_API_KEY: args.apiKey }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    configPath,
    createCodexConfigToml({
      providerName: args.providerName,
      baseUrl: args.baseUrl,
    }),
    "utf8",
  );

  const registryDocument = {
    id: finalCredentialId,
    userId: args.userProfileId,
    kind: "codex-auth",
    label: args.label,
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
      providerName: args.providerName,
      baseUrl: args.baseUrl,
      source: "portal",
    },
    status: "ready",
  };
  fs.writeFileSync(
    registryPath,
    yaml.dump(registryDocument, { lineWidth: 120, noRefs: true }),
    "utf8",
  );

  return {
    credentialId: finalCredentialId,
    created: true,
    registryPath,
    paths: [
      `credentials/codex/${finalCredentialId}/auth.json`,
      `credentials/codex/${finalCredentialId}/config.toml`,
    ],
  };
}

export function ensureDefaultCodexCredential(userProfileId: string): {
  credentialId: string;
  created: boolean;
  registryPath: string;
  paths: string[];
} {
  return writeCodexCredential({
    userProfileId,
    credentialId: "codex-rightcode",
    label: "Codex rightcode",
    providerName: "rightcode",
    baseUrl: "https://right.codes/codex/v1",
    apiKey: "",
    ensureIfMissing: true,
  });
}
