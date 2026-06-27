import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import type { Credential } from "../core/workspace.js";
import { resolveRepoRoot } from "../utils/repo-root.js";

const REPO_ROOT = resolveRepoRoot(import.meta.url);
const USER_ROOT = path.join(REPO_ROOT, "config", "users");
const USER_PROFILES_ROOT = path.join(USER_ROOT, "profiles");

type ManagedHarness = "codex" | "ssh";

export interface ManagedCredentialSummary {
  id: string;
  userId: string;
  kind: Credential["kind"];
  label: string;
  purposes: string[];
  status: string;
  registryPath: string;
  paths: string[];
  harness: ManagedHarness;
  active: boolean;
}

export interface DeletedCredentialSummary {
  id: string;
  userId: string;
  removed: boolean;
  registryPath: string;
  removedPaths: string[];
}

interface UserProfileRecord {
  id: string;
  email: string;
  ssh?: {
    mode?: string;
    comment?: string;
  };
}

function profilePathFor(userProfileId: string): string {
  return path.join(USER_PROFILES_ROOT, `${userProfileId}.yaml`);
}

function userRootFor(userProfileId: string): string {
  return path.join(USER_ROOT, userProfileId);
}

function credentialRegistryPathFor(userProfileId: string, credentialId: string): string {
  return path.join(credentialsRootFor(userProfileId), `${credentialId}.yaml`);
}

function readYamlRecord(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return (yaml.load(fs.readFileSync(filePath, "utf8")) ?? {}) as Record<string, unknown>;
}

function writeYamlRecord(filePath: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    yaml.dump(value, { lineWidth: 120, noRefs: true }),
    "utf8",
  );
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

function readUserProfileRecord(userProfileId: string): UserProfileRecord {
  const filePath = profilePathFor(userProfileId);
  const record = readYamlRecord(filePath);
  if (!record) {
    throw new Error(`User profile '${userProfileId}' was not found`);
  }
  return {
    id: String(record.id ?? userProfileId),
    email: String(record.email ?? `${userProfileId}@polaris.local`),
    ssh: typeof record.ssh === "object" && record.ssh
      ? {
          mode: String((record.ssh as Record<string, unknown>).mode ?? ""),
          comment: String((record.ssh as Record<string, unknown>).comment ?? ""),
        }
      : undefined,
  };
}

function credentialHarnessFor(kind: Credential["kind"], metadata?: Record<string, unknown>): ManagedHarness {
  const configured = String(metadata?.harness ?? "").trim().toLowerCase();
  if (configured === "codex") {
    return "codex";
  }
  if (kind === "ssh-key") {
    return "ssh";
  }
  return "codex";
}

function credentialPathsFromMaterial(materialRef: Record<string, unknown> | undefined): string[] {
  const files = Array.isArray(materialRef?.files)
    ? materialRef.files as Array<Record<string, unknown>>
    : [];
  return files.map((entry) => String(entry.source_path ?? entry.sourcePath ?? "").trim()).filter(Boolean);
}

function summarizeCredentialDocument(
  userProfileId: string,
  document: Record<string, unknown>,
  fallbackId: string,
): ManagedCredentialSummary {
  const metadata = typeof document.metadata === "object" && document.metadata
    ? document.metadata as Record<string, unknown>
    : {};
  const kind = String(document.kind ?? "codex-auth") as Credential["kind"];
  const id = String(document.id ?? fallbackId).trim() || fallbackId;
  const harness = credentialHarnessFor(kind, metadata);
  return {
    id,
    userId: userProfileId,
    kind,
    label: String(document.label ?? id),
    purposes: Array.isArray(document.purposes)
      ? document.purposes.map((value) => String(value)).filter(Boolean)
      : [],
    status: String(document.status ?? "unknown"),
    registryPath: path.join("config", "users", userProfileId, "credentials", `${id}.yaml`),
    paths: credentialPathsFromMaterial(
      typeof document.materialRef === "object" && document.materialRef
        ? document.materialRef as Record<string, unknown>
        : undefined,
    ),
    harness,
    active: metadata.active === true,
  };
}

function writeCredentialRegistry(
  userProfileId: string,
  credentialId: string,
  document: Record<string, unknown>,
): ManagedCredentialSummary {
  const registryPath = credentialRegistryPathFor(userProfileId, credentialId);
  writeYamlRecord(registryPath, document);
  return summarizeCredentialDocument(userProfileId, document, credentialId);
}

function ensureUserSecretsLayout(userProfileId: string): void {
  const userRoot = userRootFor(userProfileId);
  fs.mkdirSync(path.join(userRoot, "credentials", "ssh"), { recursive: true });
  const gitignorePath = path.join(userRoot, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, "*\n!.gitignore\n", "utf8");
  }
}

function defaultSshCredentialComment(userProfile: UserProfileRecord): string {
  const explicit = userProfile.ssh?.comment?.trim();
  return explicit || userProfile.email || `${userProfile.id}@polaris.local`;
}

function generateManagedSshKeypair(userProfileId: string, comment: string): string[] {
  const secretsRoot = userRootFor(userProfileId);
  const sshPrivateKeyPath = path.join(secretsRoot, "credentials", "ssh", "id_ed25519");
  const sshPublicKeyPath = path.join(secretsRoot, "credentials", "ssh", "id_ed25519.pub");

  fs.mkdirSync(path.dirname(sshPrivateKeyPath), { recursive: true });
  if (!fs.existsSync(sshPrivateKeyPath) || !fs.existsSync(sshPublicKeyPath)) {
    fs.rmSync(sshPrivateKeyPath, { force: true });
    fs.rmSync(sshPublicKeyPath, { force: true });
    const generated = spawnSync(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", sshPrivateKeyPath],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
      },
    );
    if (generated.status !== 0) {
      const stderr = typeof generated.stderr === "string" ? generated.stderr.trim() : "";
      const stdout = typeof generated.stdout === "string" ? generated.stdout.trim() : "";
      const spawnError = generated.error instanceof Error ? generated.error.message : "";
      throw new Error(stderr || stdout || spawnError || "ssh-keygen failed");
    }
  }

  return [
    "credentials/ssh/id_ed25519",
    "credentials/ssh/id_ed25519.pub",
  ];
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

export function listManagedCredentials(userProfileId: string): ManagedCredentialSummary[] {
  const registryRoot = credentialsRootFor(userProfileId);
  if (!fs.existsSync(registryRoot)) {
    return [];
  }
  return fs
    .readdirSync(registryRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => {
      const fallbackId = entry.name.replace(/\.ya?ml$/, "");
      const document = readYamlRecord(path.join(registryRoot, entry.name)) ?? {};
      return summarizeCredentialDocument(userProfileId, document, fallbackId);
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function createManagedSshCredential(args: {
  userProfileId: string;
  credentialId?: string;
  label?: string;
  ensureIfMissing?: boolean;
}): ManagedCredentialSummary & { created: boolean } {
  const userProfile = readUserProfileRecord(args.userProfileId);
  ensureUserSecretsLayout(args.userProfileId);

  const credentialId = sanitizeCredentialId(args.credentialId ?? "github-ssh") || "github-ssh";
  const registryPath = credentialRegistryPathFor(args.userProfileId, credentialId);
  const comment = defaultSshCredentialComment(userProfile);

  if (args.ensureIfMissing && fs.existsSync(registryPath)) {
    generateManagedSshKeypair(args.userProfileId, comment);
    return {
      ...summarizeCredentialDocument(
        args.userProfileId,
        readYamlRecord(registryPath) ?? {},
        credentialId,
      ),
      created: false,
    };
  }

  generateManagedSshKeypair(args.userProfileId, comment);
  const summary = writeCredentialRegistry(args.userProfileId, credentialId, {
    id: credentialId,
    userId: args.userProfileId,
    kind: "ssh-key",
    label: args.label?.trim() || "Default SSH key",
    purposes: ["git-auth", "ssh-auth"],
    materialRef: {
      type: "file",
      key: "user-ssh-state/default",
      files: [
        {
          key: "id_ed25519",
          source_path: "credentials/ssh/id_ed25519",
        },
        {
          key: "id_ed25519.pub",
          source_path: "credentials/ssh/id_ed25519.pub",
        },
      ],
    },
    metadata: {
      provider: "local",
      harness: "ssh",
    },
    status: "ready",
  });
  return {
    ...summary,
    created: true,
  };
}

export function createManagedCodexCredential(args: {
  userProfileId: string;
  credentialId?: string;
  label: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  ensureIfMissing?: boolean;
  activate?: boolean;
}): ManagedCredentialSummary & { created: boolean } {
  ensureUserProfileExists(args.userProfileId);
  ensureUserSecretsLayout(args.userProfileId);

  const registryRoot = credentialsRootFor(args.userProfileId);
  fs.mkdirSync(registryRoot, { recursive: true });
  const seedId = sanitizeCredentialId(args.credentialId ?? `codex-${args.providerName}`) || "codex";
  const finalCredentialId = args.credentialId
    ? seedId
    : ensureUniqueCredentialId(args.userProfileId, seedId);
  const registryPath = path.join(registryRoot, `${finalCredentialId}.yaml`);

  if (args.ensureIfMissing && fs.existsSync(registryPath)) {
    const summary = summarizeCredentialDocument(
      args.userProfileId,
      readYamlRecord(registryPath) ?? {},
      finalCredentialId,
    );
    return {
      ...summary,
      created: false,
    };
  }

  const materialDir = path.join(registryRoot, "codex", finalCredentialId);
  fs.mkdirSync(materialDir, { recursive: true });
  fs.writeFileSync(
    path.join(materialDir, "auth.json"),
    `${JSON.stringify({ OPENAI_API_KEY: args.apiKey }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(materialDir, "config.toml"),
    createCodexConfigToml({
      providerName: args.providerName,
      baseUrl: args.baseUrl,
    }),
    "utf8",
  );

  const summary = writeCredentialRegistry(args.userProfileId, finalCredentialId, {
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
      active: false,
    },
    status: "ready",
  });

  if (args.activate) {
    const activated = activateManagedCredential({
      userProfileId: args.userProfileId,
      credentialId: finalCredentialId,
    });
    return {
      ...activated,
      created: true,
    };
  }

  return {
    ...summary,
    created: true,
  };
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
  const created = createManagedCodexCredential(args);
  return {
    credentialId: created.id,
    created: created.created,
    registryPath: created.registryPath,
    paths: created.paths,
  };
}

export function deleteManagedCredential(args: {
  userProfileId: string;
  credentialId: string;
}): DeletedCredentialSummary {
  const registryPath = credentialRegistryPathFor(args.userProfileId, args.credentialId);
  const document = readYamlRecord(registryPath);
  const removedPaths: string[] = [];
  const userRoot = userRootFor(args.userProfileId);
  for (const relativePath of credentialPathsFromMaterial(document?.materialRef as Record<string, unknown> | undefined)) {
    const absolute = path.resolve(userRoot, relativePath);
    if (absolute !== userRoot && !absolute.startsWith(`${userRoot}${path.sep}`)) {
      continue;
    }
    fs.rmSync(absolute, { force: true });
    removeEmptyParentDirs(absolute, userRoot);
    removedPaths.push(relativePath);
  }

  const removed = fs.existsSync(registryPath) || removedPaths.length > 0;
  fs.rmSync(registryPath, { force: true });
  return {
    id: args.credentialId,
    userId: args.userProfileId,
    removed,
    registryPath: path.join("config", "users", args.userProfileId, "credentials", `${args.credentialId}.yaml`),
    removedPaths,
  };
}

export function deleteAllManagedCredentialsForUser(userProfileId: string): DeletedCredentialSummary[] {
  return listManagedCredentials(userProfileId).map((credential) =>
    deleteManagedCredential({
      userProfileId,
      credentialId: credential.id,
    }),
  );
}

export function activateManagedCredential(args: {
  userProfileId: string;
  credentialId: string;
}): ManagedCredentialSummary {
  const credentials = listManagedCredentials(args.userProfileId);
  const target = credentials.find((credential) => credential.id === args.credentialId);
  if (!target) {
    throw new Error(`Credential '${args.credentialId}' was not found for user '${args.userProfileId}'`);
  }
  if (target.harness !== "codex") {
    throw new Error(`Credential '${args.credentialId}' does not support activation`);
  }

  const registryRoot = credentialsRootFor(args.userProfileId);
  for (const credential of credentials.filter((entry) => entry.harness === target.harness)) {
    const registryPath = path.join(registryRoot, `${credential.id}.yaml`);
    const document = readYamlRecord(registryPath) ?? {};
    const metadata = typeof document.metadata === "object" && document.metadata
      ? { ...(document.metadata as Record<string, unknown>) }
      : {};
    metadata.active = credential.id === target.id;
    document.metadata = metadata;
    writeYamlRecord(registryPath, document);
  }

  const activated = listManagedCredentials(args.userProfileId).find((credential) => credential.id === target.id);
  if (!activated) {
    throw new Error(`Credential '${target.id}' could not be reloaded after activation`);
  }
  return activated;
}

export function resolveActiveManagedCredential(args: {
  userProfileId: string;
  harness: ManagedHarness;
}): ManagedCredentialSummary | null {
  return listManagedCredentials(args.userProfileId).find((credential) =>
    credential.harness === args.harness && credential.active
  ) ?? null;
}

export function ensureRequiredProfileCredentials(userProfileId: string): ManagedCredentialSummary[] {
  const profile = readUserProfileRecord(userProfileId);
  const created: ManagedCredentialSummary[] = [];
  if (profile.ssh?.mode) {
    created.push(
      createManagedSshCredential({
        userProfileId,
        credentialId: "github-ssh",
        ensureIfMissing: true,
      }),
    );
  }
  return created;
}
