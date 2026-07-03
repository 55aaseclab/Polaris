import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import type { Credential } from "../core/workspace.js";
import {
  defaultCredentialLabel,
  defaultCredentialProviderName,
  findHarnessProviderPreset,
  isAgentHarness,
  isManagedHarness,
  supportsLiveCredentialSwitch,
  type AgentHarness,
  type ManagedHarness,
} from "./credential-catalog.js";
import { polarisUsersRoot, repoRoot } from "../utils/paths.js";

const REPO_ROOT = repoRoot(import.meta.url);
const USER_ROOT = polarisUsersRoot(import.meta.url);
const USER_PROFILES_ROOT = path.join(USER_ROOT, "profiles");

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
  providerName?: string;
  baseUrl?: string;
  liveSwitchSupported: boolean;
}

export interface DeletedCredentialSummary {
  id: string;
  userId: string;
  removed: boolean;
  registryPath: string;
  removedPaths: string[];
}

export interface ManagedCredentialMaterialFile {
  key: string;
  sourcePath: string;
  mountPath?: string;
  content: string;
}

export interface ManagedCredentialRecord {
  summary: ManagedCredentialSummary;
  document: Record<string, unknown>;
  files: ManagedCredentialMaterialFile[];
}

export interface ManagedCredentialMaterialWriteResult {
  credential: ManagedCredentialSummary;
  file: ManagedCredentialMaterialFile;
}

type DefaultCredentialPolicy =
  | {
      harness: "ssh";
      credentialId: string;
      activate: boolean;
      ensureIfMissing: boolean;
    }
  | {
      harness: "codex";
      credentialId: string;
      presetId: string;
      apiKey: string;
      activate: boolean;
      ensureIfMissing: boolean;
    };

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

function metadataRecord(
  metadata: unknown,
): Record<string, unknown> {
  return typeof metadata === "object" && metadata
    ? { ...(metadata as Record<string, unknown>) }
    : {};
}

function materialRefRecord(
  materialRef: unknown,
): Record<string, unknown> | undefined {
  return typeof materialRef === "object" && materialRef
    ? { ...(materialRef as Record<string, unknown>) }
    : undefined;
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

function credentialHarnessFor(
  kind: Credential["kind"],
  metadata?: Record<string, unknown>,
): ManagedHarness {
  const configured = String(metadata?.harness ?? "").trim().toLowerCase();
  if (isManagedHarness(configured)) {
    return configured;
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

function materialFilesFromDocument(
  userProfileId: string,
  document: Record<string, unknown>,
): ManagedCredentialMaterialFile[] {
  const materialRef = materialRefRecord(document.materialRef);
  const files = Array.isArray(materialRef?.files)
    ? (materialRef.files as Array<Record<string, unknown>>)
    : [];
  const userRoot = userRootFor(userProfileId);
  const output: ManagedCredentialMaterialFile[] = [];
  for (const entry of files) {
      const key = String(entry.key ?? "").trim();
      const relativePath = String(
        entry.source_path ?? entry.sourcePath ?? "",
      ).trim();
      if (!key || !relativePath) {
        continue;
      }
      const absolutePath = path.resolve(userRoot, relativePath);
      if (
        absolutePath !== userRoot &&
        !absolutePath.startsWith(`${userRoot}${path.sep}`)
      ) {
        continue;
      }
      output.push({
        key,
        sourcePath: relativePath,
        mountPath: String(entry.mount_path ?? entry.mountPath ?? "").trim() || undefined,
        content: fs.existsSync(absolutePath)
          ? fs.readFileSync(absolutePath, "utf8")
          : "",
      });
    }
  return output;
}

function summarizeCredentialDocument(
  userProfileId: string,
  document: Record<string, unknown>,
  fallbackId: string,
): ManagedCredentialSummary {
  const metadata = metadataRecord(document.metadata);
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
      materialRefRecord(document.materialRef),
    ),
    harness,
    active: metadata.active === true,
    providerName: typeof metadata.providerName === "string"
      ? metadata.providerName
      : undefined,
    baseUrl: typeof metadata.baseUrl === "string"
      ? metadata.baseUrl
      : undefined,
    liveSwitchSupported: supportsLiveCredentialSwitch(harness),
  };
}

function readCredentialDocument(
  userProfileId: string,
  credentialId: string,
): Record<string, unknown> | null {
  return readYamlRecord(credentialRegistryPathFor(userProfileId, credentialId));
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

function managedSshCredentialMaterialDir(
  userProfileId: string,
  credentialId: string,
): string {
  return path.join(credentialsRootFor(userProfileId), "ssh", credentialId);
}

function generateManagedSshKeypair(
  userProfileId: string,
  credentialId: string,
  comment: string,
): string[] {
  const secretsRoot = userRootFor(userProfileId);
  const materialDir = managedSshCredentialMaterialDir(userProfileId, credentialId);
  const sshPrivateKeyPath = path.join(materialDir, "id_ed25519");
  const sshPublicKeyPath = path.join(materialDir, "id_ed25519.pub");

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
    path.relative(secretsRoot, sshPrivateKeyPath).replace(/\\/g, "/"),
    path.relative(secretsRoot, sshPublicKeyPath).replace(/\\/g, "/"),
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
  model?: string;
}): string {
  return [
    `model_provider = ${JSON.stringify(args.providerName)}`,
    `model = ${JSON.stringify(args.model?.trim() || "gpt-5.5")}`,
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

function managedAgentCredentialMaterialDir(
  userProfileId: string,
  harness: AgentHarness,
  credentialId: string,
): string {
  return path.join(credentialsRootFor(userProfileId), harness, credentialId);
}

function writeManagedCredentialFile(
  filePath: string,
  content: string,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function createManagedGenericAgentCredential(args: {
  userProfileId: string;
  harness: Exclude<AgentHarness, "codex">;
  credentialId?: string;
  label?: string;
  providerName?: string;
  baseUrl?: string;
  apiKey?: string;
  presetId?: string;
  activate?: boolean;
  ensureIfMissing?: boolean;
}): ManagedCredentialSummary & { created: boolean } {
  ensureUserProfileExists(args.userProfileId);
  ensureUserSecretsLayout(args.userProfileId);

  const preset = findHarnessProviderPreset(args.harness, args.presetId);
  const providerName =
    args.providerName?.trim()
    || preset?.providerName
    || defaultCredentialProviderName(args.harness);
  const baseUrl = args.baseUrl?.trim() || preset?.baseUrl || "";
  const label = args.label?.trim() || preset?.label || defaultCredentialLabel(args.harness);
  const seedId = sanitizeCredentialId(
    args.credentialId ?? `${args.harness}-${providerName}`,
  ) || args.harness;
  const finalCredentialId = args.credentialId
    ? seedId
    : ensureUniqueCredentialId(args.userProfileId, seedId);
  const registryPath = credentialRegistryPathFor(args.userProfileId, finalCredentialId);
  if (args.ensureIfMissing && fs.existsSync(registryPath)) {
    return {
      ...summarizeCredentialDocument(
        args.userProfileId,
        readCredentialDocument(args.userProfileId, finalCredentialId) ?? {},
        finalCredentialId,
      ),
      created: false,
    };
  }

  const materialDir = managedAgentCredentialMaterialDir(
    args.userProfileId,
    args.harness,
    finalCredentialId,
  );
  writeManagedCredentialFile(
    path.join(materialDir, "credential.json"),
    `${JSON.stringify({
      harness: args.harness,
      providerName,
      baseUrl,
      apiKey: args.apiKey ?? "",
      presetId: args.presetId?.trim() || preset?.id || "",
    }, null, 2)}\n`,
  );

  const summary = writeCredentialRegistry(args.userProfileId, finalCredentialId, {
    id: finalCredentialId,
    userId: args.userProfileId,
    kind: "api-key",
    label,
    purposes: ["agent-auth"],
    materialRef: {
      type: "file",
      key: finalCredentialId,
      files: [
        {
          key: `${args.harness}-credential.json`,
          source_path: `credentials/${args.harness}/${finalCredentialId}/credential.json`,
        },
      ],
    },
    metadata: {
      harness: args.harness,
      providerName,
      baseUrl,
      presetId: args.presetId?.trim() || preset?.id || undefined,
      source: "portal",
      active: false,
      liveSwitchSupported: supportsLiveCredentialSwitch(args.harness),
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

export function createManagedSshCredential(args: {
  userProfileId: string;
  credentialId?: string;
  label?: string;
  activate?: boolean;
  ensureIfMissing?: boolean;
}): ManagedCredentialSummary & { created: boolean } {
  const userProfile = readUserProfileRecord(args.userProfileId);
  ensureUserSecretsLayout(args.userProfileId);

  const credentialId = sanitizeCredentialId(args.credentialId ?? "github-ssh") || "github-ssh";
  const registryPath = credentialRegistryPathFor(args.userProfileId, credentialId);
  const comment = defaultSshCredentialComment(userProfile);

  if (args.ensureIfMissing && fs.existsSync(registryPath)) {
    generateManagedSshKeypair(args.userProfileId, credentialId, comment);
    return {
      ...summarizeCredentialDocument(
        args.userProfileId,
        readYamlRecord(registryPath) ?? {},
        credentialId,
      ),
      created: false,
    };
  }

  const [privateKeySourcePath, publicKeySourcePath] = generateManagedSshKeypair(
    args.userProfileId,
    credentialId,
    comment,
  );
  const summary = writeCredentialRegistry(args.userProfileId, credentialId, {
    id: credentialId,
    userId: args.userProfileId,
    kind: "ssh-key",
    label: args.label?.trim() || defaultCredentialLabel("ssh"),
    purposes: ["git-auth", "ssh-auth"],
    materialRef: {
      type: "file",
      key: credentialId,
      files: [
        {
          key: "id_ed25519",
          source_path: privateKeySourcePath,
        },
        {
          key: "id_ed25519.pub",
          source_path: publicKeySourcePath,
        },
      ],
    },
    metadata: {
      provider: "local",
      harness: "ssh",
      active: false,
      liveSwitchSupported: true,
    },
    status: "ready",
  });

  const shouldActivate =
    args.activate === true
    || resolveActiveManagedCredential({
      userProfileId: args.userProfileId,
      harness: "ssh",
    }) === null;
  if (shouldActivate) {
    const activated = activateManagedCredential({
      userProfileId: args.userProfileId,
      credentialId,
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

export function createManagedCodexCredential(args: {
  userProfileId: string;
  credentialId?: string;
  label?: string;
  providerName?: string;
  baseUrl?: string;
  apiKey: string;
  ensureIfMissing?: boolean;
  activate?: boolean;
  presetId?: string;
  model?: string;
}): ManagedCredentialSummary & { created: boolean } {
  ensureUserProfileExists(args.userProfileId);
  ensureUserSecretsLayout(args.userProfileId);

  const preset = findHarnessProviderPreset("codex", args.presetId)
    ?? findHarnessProviderPreset("codex", "rightcode");
  const providerName = args.providerName?.trim() || preset?.providerName || "rightcode";
  const baseUrl = args.baseUrl?.trim() || preset?.baseUrl || "https://right.codes/codex/v1";
  const label = args.label?.trim() || preset?.label || defaultCredentialLabel("codex");
  const registryRoot = credentialsRootFor(args.userProfileId);
  fs.mkdirSync(registryRoot, { recursive: true });
  const seedId = sanitizeCredentialId(args.credentialId ?? `codex-${providerName}`) || "codex";
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
      providerName,
      baseUrl,
      model: args.model ?? preset?.model,
    }),
    "utf8",
  );

  const summary = writeCredentialRegistry(args.userProfileId, finalCredentialId, {
    id: finalCredentialId,
    userId: args.userProfileId,
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
      presetId: args.presetId?.trim() || preset?.id || "rightcode",
      source: "portal",
      active: false,
      liveSwitchSupported: true,
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
  label?: string;
  providerName?: string;
  baseUrl?: string;
  apiKey: string;
  ensureIfMissing?: boolean;
  presetId?: string;
  model?: string;
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

export function createManagedHarnessCredential(args: {
  userProfileId: string;
  harness: ManagedHarness;
  credentialId?: string;
  label?: string;
  providerName?: string;
  baseUrl?: string;
  apiKey?: string;
  ensureIfMissing?: boolean;
  activate?: boolean;
  presetId?: string;
  model?: string;
}): ManagedCredentialSummary & { created: boolean } {
  if (args.harness === "ssh") {
    return createManagedSshCredential({
      userProfileId: args.userProfileId,
      credentialId: args.credentialId,
      label: args.label,
      activate: args.activate,
      ensureIfMissing: args.ensureIfMissing,
    });
  }
  if (args.harness === "codex") {
    return createManagedCodexCredential({
      userProfileId: args.userProfileId,
      credentialId: args.credentialId,
      label: args.label,
      providerName: args.providerName,
      baseUrl: args.baseUrl,
      apiKey: args.apiKey ?? "",
      ensureIfMissing: args.ensureIfMissing,
      activate: args.activate,
      presetId: args.presetId,
      model: args.model,
    });
  }
  if (!isAgentHarness(args.harness)) {
    throw new Error(`Unsupported harness '${args.harness}'`);
  }
  return createManagedGenericAgentCredential({
    userProfileId: args.userProfileId,
    harness: args.harness,
    credentialId: args.credentialId,
    label: args.label,
    providerName: args.providerName,
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    presetId: args.presetId,
    activate: args.activate,
    ensureIfMissing: args.ensureIfMissing,
  });
}

export function readManagedCredentialRecord(args: {
  userProfileId: string;
  credentialId: string;
}): ManagedCredentialRecord {
  const document = readCredentialDocument(args.userProfileId, args.credentialId);
  if (!document) {
    throw new Error(
      `Credential '${args.credentialId}' was not found for user '${args.userProfileId}'`,
    );
  }
  return {
    summary: summarizeCredentialDocument(
      args.userProfileId,
      document,
      args.credentialId,
    ),
    document,
    files: materialFilesFromDocument(args.userProfileId, document),
  };
}

export function writeManagedCredentialMaterialFile(args: {
  userProfileId: string;
  credentialId: string;
  fileKey: string;
  content: string;
}): ManagedCredentialMaterialWriteResult {
  const record = readManagedCredentialRecord({
    userProfileId: args.userProfileId,
    credentialId: args.credentialId,
  });
  const file = record.files.find((entry) => entry.key === args.fileKey);
  if (!file) {
    throw new Error(
      `Credential '${args.credentialId}' does not contain file key '${args.fileKey}' for user '${args.userProfileId}'`,
    );
  }
  const userRoot = userRootFor(args.userProfileId);
  const absolutePath = path.resolve(userRoot, file.sourcePath);
  if (
    absolutePath !== userRoot &&
    !absolutePath.startsWith(`${userRoot}${path.sep}`)
  ) {
    throw new Error(
      `Credential file '${file.sourcePath}' escapes user root for '${args.userProfileId}'`,
    );
  }
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, args.content, "utf8");
  return {
    credential: record.summary,
    file: {
      ...file,
      content: args.content,
    },
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

function resolveDefaultCredentialPolicies(): DefaultCredentialPolicy[] {
  const policies: DefaultCredentialPolicy[] = [
    {
      harness: "ssh",
      credentialId: "github-ssh",
      activate: true,
      ensureIfMissing: true,
    },
  ];

  const codexRightCodeApiKey = String(
    process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY ?? "",
  ).trim();
  if (codexRightCodeApiKey) {
    policies.push({
      harness: "codex",
      credentialId: "codex-rightcode",
      presetId: "rightcode",
      apiKey: codexRightCodeApiKey,
      activate: true,
      ensureIfMissing: true,
    });
  }

  return policies;
}

export function ensureRequiredProfileCredentials(userProfileId: string): ManagedCredentialSummary[] {
  const profile = readUserProfileRecord(userProfileId);
  const created: ManagedCredentialSummary[] = [];
  const policies = resolveDefaultCredentialPolicies();
  for (const policy of policies) {
    if (policy.harness === "ssh") {
      if (!profile.ssh?.mode) {
        continue;
      }
      created.push(
        createManagedSshCredential({
          userProfileId,
          credentialId: policy.credentialId,
          activate: policy.activate,
          ensureIfMissing: policy.ensureIfMissing,
        }),
      );
      continue;
    }
    created.push(
      createManagedCodexCredential({
        userProfileId,
        credentialId: policy.credentialId,
        presetId: policy.presetId,
        apiKey: policy.apiKey,
        activate: policy.activate,
        ensureIfMissing: policy.ensureIfMissing,
      }),
    );
  }
  return created;
}
