import {
  VAULT_DATA_PRIMARY_RUNTIME_ROOT,
  VAULT_DATA_RUNTIME_ROOTS,
} from "../backends/vault-runtime-adapter.js";
import type { VaultSpec } from "./vault.js";
import { assertValidVaultProjectName } from "./vault-name.js";

const POD_PROFILES = new Set(["gvisor", "kata-qemu", "kata-clh", "kata-qemu-tdx"]);

function terminalPathToken(filePath: string | undefined): string {
  if (!filePath) return "";
  const parts = filePath.split("/").filter(Boolean);
  return (parts[parts.length - 1] || "").replace(/^\.+/, "");
}

function parsePublicKeyComment(raw: string | undefined): string {
  const text = String(raw || "").trim();
  const parts = text.split(/\s+/);
  return parts.length >= 3 ? parts.slice(2).join(" ") : "";
}

export function validateVault(vault: VaultSpec): void {
  if (!vault.identity.projectName) {
    throw new Error("Vault project name is required");
  }
  assertValidVaultProjectName(vault.identity.projectName);
  if (!vault.userProfile.id) {
    throw new Error("Vault user profile id is required");
  }
  if (!vault.userProfile.name) {
    throw new Error("Vault user profile name is required");
  }
  if (!vault.userProfile.email) {
    throw new Error("Vault user profile email is required");
  }
  for (const binding of vault.credentialBindings) {
    const resolvedBinding = vault.resolvedCredentialBindings.find((entry) => {
      return entry.purpose === binding.purpose && entry.credentialId === binding.credentialId;
    });
    if (!resolvedBinding && binding.required) {
      throw new Error(`Required credential binding '${binding.purpose}' could not be resolved`);
    }
  }
  for (const binding of vault.resolvedCredentialBindings) {
    if (binding.credential.userId !== vault.userProfile.id) {
      throw new Error(
        `Credential '${binding.credential.id}' must belong to vault user '${vault.userProfile.id}'`,
      );
    }
    if (binding.authFiles.length === 0 && binding.required) {
      throw new Error(
        `Credential '${binding.credential.id}' must resolve at least one auth file`,
      );
    }
  }

  if (!vault.attachments.vaultData.mountRoot) {
    throw new Error("vault-data must declare a mount root");
  }
  if (vault.attachments.vaultData.mountRoot !== VAULT_DATA_PRIMARY_RUNTIME_ROOT) {
    throw new Error(
      `vault-data must use the direct primary mount root ${VAULT_DATA_PRIMARY_RUNTIME_ROOT}`,
    );
  }
  for (const mountRoot of VAULT_DATA_RUNTIME_ROOTS) {
    if (!vault.attachments.vaultData.durablePaths.includes(mountRoot)) {
      throw new Error(`vault-data must declare direct mount root ${mountRoot}`);
    }
  }
  if (!vault.attachments.vaultRuntimeState.mountRoot) {
    throw new Error("vault-runtime-state must declare a mount root");
  }
  if (!vault.attachments.userIdentityState.mountRoot) {
    throw new Error("user-identity-state must declare a mount root");
  }
  if (!vault.attachments.ephemeralRuntime.mountRoot) {
    throw new Error("ephemeral-runtime must declare a mount root");
  }

  if (vault.attachments.vaultData.scope !== "vault" || vault.attachments.vaultData.sharing !== "exclusive") {
    throw new Error("vault-data must remain vault-scoped and non-shared");
  }
  if (vault.attachments.vaultRuntimeState.scope !== "vault" || vault.attachments.vaultRuntimeState.sharing !== "exclusive") {
    throw new Error("vault-runtime-state must remain vault-scoped and non-shared");
  }
  if (vault.attachments.userIdentityState.scope !== "user" || vault.attachments.userIdentityState.sharing !== "cross-vault") {
    throw new Error("user-identity-state must remain user-scoped and cross-vault");
  }
  if (vault.attachments.vaultRuntimeState.source.kind === "netfs") {
    throw new Error("vault-runtime-state must not use a netfs source");
  }
  if (vault.attachments.userIdentityState.source.kind === "netfs") {
    throw new Error("user-identity-state must not use a netfs source");
  }
  if (vault.attachments.vaultData.source.kind === "netfs") {
    if (!vault.attachments.vaultData.source.server?.trim()) {
      throw new Error("vault-data netfs source requires a server");
    }
    if (!vault.attachments.vaultData.source.exportPath?.trim()) {
      throw new Error("vault-data netfs source requires an export path");
    }
  }
  const managerStateToken = terminalPathToken(vault.agent.runtime.stateRoot);
  const evolutionStateToken = terminalPathToken(vault.agent.runtime.evolutionRoot);
  if (
    vault.agent.enabled &&
    vault.attachments.vaultRuntimeState.durablePaths.some((entry) => entry.includes(managerStateToken)) === false
  ) {
    throw new Error("vault-runtime-state must contain the durable manager state path");
  }
  if (
    vault.agent.enabled &&
    vault.attachments.vaultRuntimeState.durablePaths.some((entry) => entry.includes(evolutionStateToken)) === false
  ) {
    throw new Error("vault-runtime-state must contain the durable evolution state path");
  }
  if (vault.attachments.userIdentityState.durablePaths.some((entry) => entry.includes("/identity/")) === false) {
    throw new Error("user-identity-state must expose identity attachment roots");
  }
  if (vault.attachments.userIdentityState.durablePaths.some((entry) => entry.includes("/identity/ssh")) === false) {
    throw new Error("user-identity-state must expose the shared SSH attachment root");
  }
  if (vault.attachments.ephemeralRuntime.staleArtifacts.length === 0) {
    throw new Error("ephemeral-runtime must define stale artifact cleanup targets");
  }
  for (const authFile of vault.runtime.authFiles) {
    if (!authFile.content && !authFile.sourcePath) {
      throw new Error(`Auth file '${authFile.key}' must define inline content or a source path`);
    }
    if (authFile.sourcePath && !authFile.content) {
      throw new Error(`Auth file '${authFile.key}' source path is missing or unreadable: ${authFile.sourcePath}`);
    }
  }

  if (vault.agent.enabled) {
    if (vault.agent.managerId === "none") {
      throw new Error("Agent-enabled vaults require a manager id");
    }
    if (!vault.agent.capabilities.supportsEventStream) {
      throw new Error("Agent-enabled vaults require manager event stream support");
    }
    if (!vault.agent.capabilities.supportsTranscriptReplay) {
      throw new Error("Agent-enabled vaults require transcript replay support");
    }
  } else {
    if (vault.agent.managerId !== "none") {
      throw new Error("Agent-disabled vaults must not declare a manager");
    }
    if (Object.values(vault.agent.capabilities).some(Boolean)) {
      throw new Error("Agent-disabled vaults must not declare agent capabilities");
    }
    if (vault.agent.harnesses.length > 0) {
      throw new Error("Agent-disabled vaults must not declare agent harnesses");
    }
  }

  if (vault.userProfile.ssh.mode === "provided-key") {
    const sshPrivateKey = vault.runtime.authFiles.find((entry) => {
      return entry.mountPath.startsWith(`${vault.runtime.home}/.ssh/`) && !entry.mountPath.endsWith(".pub");
    });
    const sshPublicKey = vault.runtime.authFiles.find((entry) => {
      return entry.mountPath.startsWith(`${vault.runtime.home}/.ssh/`) && entry.mountPath.endsWith(".pub");
    });
    if (!sshPrivateKey) {
      throw new Error("User profile SSH mode 'provided-key' requires staged private-key material");
    }
    if (!sshPublicKey?.content) {
      throw new Error("User profile SSH mode 'provided-key' requires staged public-key material");
    }
    const publicKeyComment = parsePublicKeyComment(sshPublicKey.content);
    if (publicKeyComment !== vault.userProfile.ssh.comment) {
      throw new Error(
        `User profile SSH mode 'provided-key' requires public-key comment '${vault.userProfile.ssh.comment}', got '${publicKeyComment || "missing"}'`,
      );
    }
  }

  if (vault.backend.kind === "pod") {
    if (!POD_PROFILES.has(vault.backend.profile)) {
      throw new Error(`Vault backend 'pod' requires a supported profile; got ${vault.backend.profile}`);
    }
    for (const envVar of vault.runtime.plainEnvVars) {
      if (envVar.value.includes("/vault/")) {
        throw new Error(`Vault backend 'pod' cannot set env var ${envVar.name} to a /vault path`);
      }
    }
  }

  if (vault.health.requiresDaemon !== vault.agent.capabilities.requiresDaemon) {
    throw new Error("Vault health daemon requirement must match manager capabilities");
  }
}
