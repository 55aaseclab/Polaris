import {
  activateManagedCredential,
  createManagedHarnessCredential,
  deleteManagedCredential,
  ensureUniqueCredentialId,
  ensureUserProfileExists,
  listManagedCredentials,
  readManagedCredentialRecord,
  sanitizeCredentialId,
  writeManagedCredentialMaterialFile,
} from "../../config/credentials.js";
import { isManagedHarness, type ManagedHarness } from "../../config/credential-catalog.js";
import { logInfo } from "../../utils/log.js";
import { withUserMutationLock } from "../../utils/user-mutation-lock.js";

function parseFlag(argv: string[], flag: string): string | undefined {
  const index = argv.findIndex((value) => value === flag);
  const value = index >= 0 ? argv[index + 1]?.trim() : "";
  return value ? value : undefined;
}

function parseAddCredentialArgs(argv: string[]): {
  userProfileId: string;
  harness: ManagedHarness;
  credentialId?: string;
  label?: string;
  providerName?: string;
  baseUrl?: string;
  apiKey?: string;
  presetId?: string;
  model?: string;
  activate: boolean;
} {
  const userProfileId = argv[0]?.trim();
  const harness = (parseFlag(argv, "--harness") ?? "codex").trim().toLowerCase();
  const credentialId = parseFlag(argv, "--credential-id");
  const label = parseFlag(argv, "--label");
  const providerName = parseFlag(argv, "--provider-name");
  const baseUrl = parseFlag(argv, "--base-url");
  const apiKey = parseFlag(argv, "--api-key");
  const presetId = parseFlag(argv, "--preset-id");
  const model = parseFlag(argv, "--model");
  const activate = argv.includes("--activate");
  if (!userProfileId) {
    throw new Error(
      "Usage: pnpm --dir apps/polaris run polaris -- user credential add <userProfileId> --harness <ssh|codex|claude|copilot|opencode|pi> [--credential-id <id>] [--label <label>] [--provider-name <name>] [--base-url <url>] [--api-key <key>] [--preset-id <id>] [--model <name>] [--activate]",
    );
  }
  if (!isManagedHarness(harness)) {
    throw new Error(`Unsupported harness '${harness}'`);
  }
  return {
    userProfileId,
    harness,
    ...(credentialId ? { credentialId } : {}),
    ...(label ? { label } : {}),
    ...(providerName ? { providerName } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(presetId ? { presetId } : {}),
    ...(model ? { model } : {}),
    activate,
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

function parseListCredentialArgs(argv: string[]): { userProfileId: string } {
  const userProfileId = argv[0]?.trim();
  if (!userProfileId) {
    throw new Error(
      "Usage: pnpm --dir apps/polaris run polaris -- user credential list <userProfileId>",
    );
  }
  return { userProfileId };
}

function parseActivateCredentialArgs(argv: string[]): {
  userProfileId: string;
  credentialId: string;
} {
  const userProfileId = argv[0]?.trim();
  const credentialId = argv[1]?.trim();
  if (!userProfileId || !credentialId) {
    throw new Error(
      "Usage: pnpm --dir apps/polaris run polaris -- user credential activate <userProfileId> <credentialId>",
    );
  }
  return { userProfileId, credentialId };
}

function parseReadCredentialArgs(argv: string[]): {
  userProfileId: string;
  credentialId: string;
} {
  const userProfileId = argv[0]?.trim();
  const credentialId = argv[1]?.trim();
  if (!userProfileId || !credentialId) {
    throw new Error(
      "Usage: pnpm --dir apps/polaris run polaris -- user credential read <userProfileId> <credentialId>",
    );
  }
  return { userProfileId, credentialId };
}

function parseWriteCredentialArgs(argv: string[]): {
  userProfileId: string;
  credentialId: string;
  fileKey: string;
  content: string;
} {
  const userProfileId = argv[0]?.trim();
  const credentialId = argv[1]?.trim();
  const fileKey = argv[2]?.trim();
  const content = parseFlag(argv, "--content");
  if (!userProfileId || !credentialId || !fileKey || content === undefined) {
    throw new Error(
      "Usage: pnpm --dir apps/polaris run polaris -- user credential write <userProfileId> <credentialId> <fileKey> --content <value>",
    );
  }
  return { userProfileId, credentialId, fileKey, content };
}

export async function addUserCredentialCommand(argv: string[]): Promise<void> {
  const {
    userProfileId,
    harness,
    credentialId,
    label,
    providerName,
    baseUrl,
    apiKey,
    presetId,
    model,
    activate,
  } = parseAddCredentialArgs(argv);
  await withUserMutationLock(import.meta.url, userProfileId, async () => {
    ensureUserProfileExists(userProfileId);

    const defaultBaseId = harness === "ssh"
      ? "github-ssh"
      : harness === "codex"
        ? sanitizeCredentialId(`codex-${providerName ?? presetId ?? "rightcode"}`) || "codex"
        : sanitizeCredentialId(`${harness}-${providerName ?? presetId ?? harness}`) || harness;
    const credential = createManagedHarnessCredential({
      userProfileId,
      harness,
      credentialId: credentialId
        ? sanitizeCredentialId(credentialId)
        : ensureUniqueCredentialId(userProfileId, defaultBaseId),
      ...(label ? { label } : {}),
      ...(providerName ? { providerName } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(presetId ? { presetId } : {}),
      ...(model ? { model } : {}),
      activate,
    });

    logInfo("cli", "user-credential-created", {
      userProfileId,
      credentialId: credential.id,
      harness,
    });
    process.stdout.write(`${JSON.stringify({ credential }, null, 2)}\n`);
  });
}

export async function createUserCredentialCommand(argv: string[]): Promise<void> {
  await addUserCredentialCommand(argv);
}

export async function deleteUserCredentialCommand(argv: string[]): Promise<void> {
  const { userProfileId, credentialId } = parseDeleteCredentialArgs(argv);
  await withUserMutationLock(import.meta.url, userProfileId, async () => {
    const credential = deleteManagedCredential({ userProfileId, credentialId });
    logInfo("cli", "user-credential-deleted", {
      userProfileId,
      credentialId,
      removed: credential.removed,
    });
    process.stdout.write(`${JSON.stringify({ credential }, null, 2)}\n`);
  });
}

export async function listUserCredentialCommand(argv: string[]): Promise<void> {
  const { userProfileId } = parseListCredentialArgs(argv);
  ensureUserProfileExists(userProfileId);
  const credentials = listManagedCredentials(userProfileId);
  process.stdout.write(`${JSON.stringify({ credentials }, null, 2)}\n`);
}

export async function activateUserCredentialCommand(argv: string[]): Promise<void> {
  const { userProfileId, credentialId } = parseActivateCredentialArgs(argv);
  await withUserMutationLock(import.meta.url, userProfileId, async () => {
    const credential = activateManagedCredential({ userProfileId, credentialId });
    logInfo("cli", "user-credential-activated", {
      userProfileId,
      credentialId,
    });
    process.stdout.write(`${JSON.stringify({ credential }, null, 2)}\n`);
  });
}

export async function readUserCredentialCommand(argv: string[]): Promise<void> {
  const { userProfileId, credentialId } = parseReadCredentialArgs(argv);
  ensureUserProfileExists(userProfileId);
  const credential = readManagedCredentialRecord({
    userProfileId,
    credentialId,
  });
  process.stdout.write(`${JSON.stringify({ credential }, null, 2)}\n`);
}

export async function writeUserCredentialCommand(argv: string[]): Promise<void> {
  const { userProfileId, credentialId, fileKey, content } = parseWriteCredentialArgs(argv);
  await withUserMutationLock(import.meta.url, userProfileId, async () => {
    const credential = writeManagedCredentialMaterialFile({
      userProfileId,
      credentialId,
      fileKey,
      content,
    });
    logInfo("cli", "user-credential-file-written", {
      userProfileId,
      credentialId,
      fileKey,
    });
    process.stdout.write(`${JSON.stringify({ credential }, null, 2)}\n`);
  });
}
