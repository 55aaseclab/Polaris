import { getBackendDriver } from "../../backends/index.js";
import { isManagedHarness, type ManagedHarness } from "../../config/credential-catalog.js";
import { switchWorkspaceLiveCredentialMaterial } from "../../executor/operations.js";
import { logInfo } from "../../utils/log.js";
import { loadWorkspaceForCommand } from "./shared.js";
import { statusCommand } from "./status.js";

function parseFlag(argv: string[], flag: string): string | undefined {
  const index = argv.findIndex((value) => value === flag);
  const value = index >= 0 ? argv[index + 1]?.trim() : "";
  return value ? value : undefined;
}

function parseLiveSwitchArgs(argv: string[]): {
  workspaceRef: string;
  credentialId: string;
  harness?: ManagedHarness;
} {
  const workspaceRef = argv[0]?.trim();
  const credentialId = argv[1]?.trim();
  const harnessValue = parseFlag(argv, "--harness")?.trim().toLowerCase();
  if (!workspaceRef || !credentialId) {
    throw new Error(
      "Usage: pnpm --dir apps/polaris run polaris -- live-switch <workspaceRef> <credentialId> [--harness <ssh|codex|claude|copilot|opencode|pi>]",
    );
  }
  if (harnessValue && !isManagedHarness(harnessValue)) {
    throw new Error(`Unsupported harness '${harnessValue}'`);
  }
  return {
    workspaceRef,
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
  const { workspaceRef, credentialId, harness } = parseLiveSwitchArgs(argv);
  const { workspace } = loadWorkspaceForCommand("status", workspaceRef);
  if (workspace.backend.kind !== "docker" && workspace.backend.kind !== "pod") {
    throw new Error(
      `Live credential switching is not supported for backend '${workspace.backend.kind}'`,
    );
  }
  const observation = await getBackendDriver(workspace.backend.kind).inspect(workspace);
  if (!observation.backend.exists || !observation.backend.running) {
    throw new Error(
      `Workspace '${workspace.identity.projectName}' is not running on ${workspace.backend.kind}`,
    );
  }
  const switched = switchWorkspaceLiveCredentialMaterial({
    workspace,
    userId: workspace.userProfile.id,
    credentialId,
    harness,
    requireSupported: true,
  });
  await captureStdout(() => statusCommand(workspaceRef));
  logInfo("cli", "workspace-live-credential-switched", {
    userProfileId: workspace.userProfile.id,
    workspace: workspace.identity.projectName,
    harness: switched.harness,
    credentialId,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        switched: true,
        workspace: workspace.identity.projectName,
        harness: switched.harness,
        credentialId,
      },
      null,
      2,
    )}\n`,
  );
}
