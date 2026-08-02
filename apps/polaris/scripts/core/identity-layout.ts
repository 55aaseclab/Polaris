import path from "node:path";
import type { CredentialKind } from "./vault.js";

const AGENT_IDENTITY_HARNESSES = [
  "codex",
  "claude",
  "copilot",
  "opencode",
  "pi",
] as const;

type AgentIdentityHarness = typeof AGENT_IDENTITY_HARNESSES[number];

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function credentialHarnessFromKey(
  key: string,
): AgentIdentityHarness | null {
  const match = /^([a-z0-9-]+)-credential\.json$/i.exec(key.trim());
  if (!match) {
    return null;
  }
  const harness = match[1]?.toLowerCase();
  if (!harness) {
    return null;
  }
  return (AGENT_IDENTITY_HARNESSES as readonly string[]).includes(harness)
    ? (harness as AgentIdentityHarness)
    : null;
}

export function userIdentityDurablePaths(identityRoot: string): string[] {
  const root = trimTrailingSlash(identityRoot);
  return [
    `${root}/codex`,
    `${root}/claude`,
    `${root}/copilot`,
    `${root}/opencode/config`,
    `${root}/opencode/data`,
    `${root}/pi/agent`,
    `${root}/ssh`,
    `${root}/polaris/credentials`,
    `${root}/codex-xdg/config`,
    `${root}/codex-xdg/data`,
    `${root}/codex-xdg/state`,
  ];
}

export function userIdentityBootstrapDirs(identityRoot: string): string[] {
  return userIdentityDurablePaths(identityRoot);
}

export function defaultMountPathForCredentialFile(
  kind: CredentialKind,
  runtimeHome: string,
  key: string,
): string {
  const home = trimTrailingSlash(runtimeHome);
  const baseName = path.posix.basename(key);

  if (kind === "ssh-key") {
    return `${home}/.ssh/${baseName}`;
  }
  if (key === "codex-auth.json") {
    return `${home}/.codex/auth.json`;
  }
  if (key === "codex-config.toml") {
    return `${home}/.codex/config.toml`;
  }
  if (key === "claude-settings.json") {
    return `${home}/.claude/settings.json`;
  }

  const harness = credentialHarnessFromKey(key);
  if (harness === "claude") {
    return `${home}/.claude/credential.json`;
  }
  if (harness === "copilot") {
    return `${home}/.copilot/credential.json`;
  }
  if (harness === "opencode") {
    return `${home}/.local/share/opencode/auth.json`;
  }
  if (harness === "pi") {
    return `${home}/.pi/agent/auth.json`;
  }

  return `${home}/.local/share/polaris/credentials/${baseName}`;
}

export function stateStoragePathForMountPath(args: {
  mountPath: string;
  runtimeHome: string;
  identityRoot: string;
}): string | null {
  const mountPath = args.mountPath.trim();
  const home = trimTrailingSlash(args.runtimeHome);
  const identityRoot = trimTrailingSlash(args.identityRoot);

  if (!mountPath) {
    return null;
  }
  if (mountPath.startsWith(`${home}/.codex/`)) {
    return `${identityRoot}/codex/${mountPath.slice(`${home}/.codex/`.length)}`;
  }
  if (mountPath.startsWith(`${home}/.claude/`)) {
    return `${identityRoot}/claude/${mountPath.slice(`${home}/.claude/`.length)}`;
  }
  if (mountPath.startsWith(`${home}/.copilot/`)) {
    return `${identityRoot}/copilot/${mountPath.slice(`${home}/.copilot/`.length)}`;
  }
  if (mountPath.startsWith(`${home}/.pi/`)) {
    return `${identityRoot}/pi/${mountPath.slice(`${home}/.pi/`.length)}`;
  }
  if (mountPath.startsWith(`${home}/.config/opencode/`)) {
    return `${identityRoot}/opencode/config/${mountPath.slice(`${home}/.config/opencode/`.length)}`;
  }
  if (mountPath.startsWith(`${home}/.local/share/opencode/`)) {
    return `${identityRoot}/opencode/data/${mountPath.slice(`${home}/.local/share/opencode/`.length)}`;
  }
  if (mountPath.startsWith(`${home}/.local/share/polaris/credentials/`)) {
    return `${identityRoot}/polaris/credentials/${mountPath.slice(`${home}/.local/share/polaris/credentials/`.length)}`;
  }
  if (mountPath.startsWith(`${home}/.ssh/`)) {
    return `${identityRoot}/ssh/${mountPath.slice(`${home}/.ssh/`.length)}`;
  }
  return null;
}
