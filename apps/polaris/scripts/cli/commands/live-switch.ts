import { getBackendDriver } from "../../backends/index.js";
import { isManagedHarness, type ManagedHarness } from "../../config/credential-catalog.js";
import { switchVaultLiveCredentialMaterial } from "../../control-plane/operations.js";
import { logInfo } from "../../utils/log.js";
import { loadVaultForCommand } from "./shared.js";
import { statusCommand } from "./status.js";

function parseFlag(argv: string[], flag: string): string | undefined {
  const index = argv.findIndex((value) => value === flag);
  const value = index >= 0 ? argv[index + 1]?.trim() : "";
  return value ? value : undefined;
}

function parseLiveSwitchArgs(argv: string[]): {
  vaultRef: string;
  credentialId: string;
  harness?: ManagedHarness;
} {
  const vaultRef = argv[0]?.trim();
  const credentialId = argv[1]?.trim();
  const harnessValue = parseFlag(argv, "--harness")?.trim().toLowerCase();
  if (!vaultRef || !credentialId) {
    throw new Error(
      "Usage: pnpm --dir apps/polaris run polaris -- vault live-switch <vaultRef> <credentialId> [--harness <ssh|codex|claude|copilot|opencode|pi>]",
    );
  }
  if (harnessValue && !isManagedHarness(harnessValue)) {
    throw new Error(`Unsupported harness '${harnessValue}'`);
  }
  return {
    vaultRef,
    credentialId,
    ...(harnessValue ? { harness: harnessValue as ManagedHarness } : {}),
  };
}

async function captureStdout<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string }> {
  const stdoutChunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    stdoutChunks.push(
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString("utf8"),
    );
    const callback = args.find(
      (arg) => typeof arg === "function",
    ) as (() => void) | undefined;
    callback?.();
    return true;
  }) as typeof process.stdout.write;

  try {
    const result = await fn();
    return { result, stdout: stdoutChunks.join("").trim() };
  } finally {
    process.stdout.write = originalWrite;
  }
}

export async function liveSwitchCommand(argv: string[]): Promise<void> {
  const { vaultRef, credentialId, harness } = parseLiveSwitchArgs(argv);
  const { vault } = loadVaultForCommand("status", vaultRef);
  if (vault.backend.kind !== "docker" && vault.backend.kind !== "pod") {
    throw new Error(
      `Live credential switching is not supported for backend '${vault.backend.kind}'`,
    );
  }
  const observation = await getBackendDriver(vault.backend.kind).inspect(vault);
  if (!observation.backend.exists || !observation.backend.running) {
    throw new Error(
      `Vault '${vault.identity.projectName}' is not running on ${vault.backend.kind}`,
    );
  }
  const switched = switchVaultLiveCredentialMaterial({
    vault,
    userId: vault.userProfile.id,
    credentialId,
    harness,
    requireSupported: true,
  });
  await captureStdout(() => statusCommand(vaultRef));
  logInfo("cli", "vault-live-credential-switched", {
    userProfileId: vault.userProfile.id,
    vault: vault.identity.projectName,
    harness: switched.harness,
    credentialId,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        switched: true,
        vault: vault.identity.projectName,
        harness: switched.harness,
        credentialId,
      },
      null,
      2,
    )}\n`,
  );
}
