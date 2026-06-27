import {
  activateManagedCredential,
  createManagedCodexCredential,
  createManagedSshCredential,
  deleteManagedCredential,
  ensureUniqueCredentialId,
  ensureUserProfileExists,
  listManagedCredentials,
  sanitizeCredentialId,
} from "../../config/credentials.js";
import { logInfo } from "../../utils/log.js";

function parseFlag(argv: string[], flag: string): string | undefined {
  const index = argv.findIndex((value) => value === flag);
  const value = index >= 0 ? argv[index + 1]?.trim() : "";
  return value ? value : undefined;
}

function parseAddCredentialArgs(argv: string[]): {
  userProfileId: string;
  harness: "codex" | "ssh";
  credentialId?: string;
  label?: string;
  providerName?: string;
  baseUrl?: string;
  apiKey?: string;
  activate: boolean;
} {
  const userProfileId = argv[0]?.trim();
  const harness = (parseFlag(argv, "--harness") ?? "codex").trim().toLowerCase();
  const credentialId = parseFlag(argv, "--credential-id");
  const label = parseFlag(argv, "--label");
  const providerName = parseFlag(argv, "--provider-name");
  const baseUrl = parseFlag(argv, "--base-url");
  const apiKey = parseFlag(argv, "--api-key");
  const activate = argv.includes("--activate");
  if (!userProfileId) {
    throw new Error(
      "Usage: pnpm --dir apps/polaris run polaris -- user credential add <userProfileId> --harness <codex|ssh> [--credential-id <id>] [--label <label>] [--provider-name <name>] [--base-url <url>] [--api-key <key>] [--activate]",
    );
  }
  if (harness !== "codex" && harness !== "ssh") {
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

export async function addUserCredentialCommand(argv: string[]): Promise<void> {
  const {
    userProfileId,
    harness,
    credentialId,
    label,
    providerName,
    baseUrl,
    apiKey,
    activate,
  } = parseAddCredentialArgs(argv);
  ensureUserProfileExists(userProfileId);

  const credential = harness === "ssh"
    ? createManagedSshCredential({
        userProfileId,
        ...(credentialId ? { credentialId } : {}),
        ...(label ? { label } : {}),
      })
    : createManagedCodexCredential({
        userProfileId,
        credentialId: credentialId
          ? sanitizeCredentialId(credentialId)
          : ensureUniqueCredentialId(
              userProfileId,
              sanitizeCredentialId(`codex-${providerName ?? "rightcode"}`) || "codex",
            ),
        label: label ?? "RightCode Codex",
        providerName: providerName ?? "rightcode",
        baseUrl: baseUrl ?? "https://right.codes/codex/v1",
        apiKey: apiKey ?? "",
        activate,
      });

  logInfo("cli", "user-credential-created", {
    userProfileId,
    credentialId: credential.id,
    harness,
  });
  process.stdout.write(`${JSON.stringify({ credential }, null, 2)}\n`);
}

export async function createUserCredentialCommand(argv: string[]): Promise<void> {
  await addUserCredentialCommand(argv);
}

export async function deleteUserCredentialCommand(argv: string[]): Promise<void> {
  const { userProfileId, credentialId } = parseDeleteCredentialArgs(argv);
  const credential = deleteManagedCredential({ userProfileId, credentialId });
  logInfo("cli", "user-credential-deleted", {
    userProfileId,
    credentialId,
    removed: credential.removed,
  });
  process.stdout.write(`${JSON.stringify({ credential }, null, 2)}\n`);
}

export async function listUserCredentialCommand(argv: string[]): Promise<void> {
  const { userProfileId } = parseListCredentialArgs(argv);
  ensureUserProfileExists(userProfileId);
  const credentials = listManagedCredentials(userProfileId);
  process.stdout.write(`${JSON.stringify({ credentials }, null, 2)}\n`);
}

export async function activateUserCredentialCommand(argv: string[]): Promise<void> {
  const { userProfileId, credentialId } = parseActivateCredentialArgs(argv);
  const credential = activateManagedCredential({ userProfileId, credentialId });
  logInfo("cli", "user-credential-activated", {
    userProfileId,
    credentialId,
  });
  process.stdout.write(`${JSON.stringify({ credential }, null, 2)}\n`);
}
