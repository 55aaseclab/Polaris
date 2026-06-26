import type { WorkspaceSpec } from "./workspace.js";

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

export function validateWorkspace(workspace: WorkspaceSpec): void {
  if (!workspace.identity.projectName) {
    throw new Error("Workspace project name is required");
  }
  if (!workspace.userProfile.id) {
    throw new Error("Workspace user profile id is required");
  }
  if (!workspace.userProfile.name) {
    throw new Error("Workspace user profile name is required");
  }
  if (!workspace.userProfile.email) {
    throw new Error("Workspace user profile email is required");
  }
  for (const binding of workspace.credentialBindings) {
    const resolvedBinding = workspace.resolvedCredentialBindings.find((entry) => {
      return entry.purpose === binding.purpose && entry.credentialId === binding.credentialId;
    });
    if (!resolvedBinding && binding.required) {
      throw new Error(`Required credential binding '${binding.purpose}' could not be resolved`);
    }
  }
  for (const binding of workspace.resolvedCredentialBindings) {
    if (binding.credential.userId !== workspace.userProfile.id) {
      throw new Error(
        `Credential '${binding.credential.id}' must belong to workspace user '${workspace.userProfile.id}'`,
      );
    }
    if (binding.authFiles.length === 0 && binding.required) {
      throw new Error(
        `Credential '${binding.credential.id}' must resolve at least one auth file`,
      );
    }
  }

  if (!workspace.attachments.workspaceData.mountRoot) {
    throw new Error("workspace-data must declare a mount root");
  }
  if (!workspace.attachments.workspaceRuntimeState.mountRoot) {
    throw new Error("workspace-runtime-state must declare a mount root");
  }
  if (!workspace.attachments.userIdentityState.mountRoot) {
    throw new Error("user-identity-state must declare a mount root");
  }
  if (!workspace.attachments.userSshState.mountRoot) {
    throw new Error("user-ssh-state must declare a mount root");
  }
  if (!workspace.attachments.ephemeralRuntime.mountRoot) {
    throw new Error("ephemeral-runtime must declare a mount root");
  }

  if (workspace.attachments.workspaceData.scope !== "workspace" || workspace.attachments.workspaceData.sharing !== "exclusive") {
    throw new Error("workspace-data must remain workspace-scoped and non-shared");
  }
  if (workspace.attachments.workspaceRuntimeState.scope !== "workspace" || workspace.attachments.workspaceRuntimeState.sharing !== "exclusive") {
    throw new Error("workspace-runtime-state must remain workspace-scoped and non-shared");
  }
  if (workspace.attachments.userIdentityState.scope !== "user" || workspace.attachments.userIdentityState.sharing !== "cross-workspace") {
    throw new Error("user-identity-state must remain user-scoped and cross-workspace");
  }
  if (workspace.attachments.userSshState.scope !== "user" || workspace.attachments.userSshState.sharing !== "cross-workspace") {
    throw new Error("user-ssh-state must remain user-scoped and cross-workspace");
  }
  if (workspace.attachments.workspaceRuntimeState.source.kind === "netfs") {
    throw new Error("workspace-runtime-state must not use a netfs source");
  }
  if (workspace.attachments.userIdentityState.source.kind === "netfs") {
    throw new Error("user-identity-state must not use a netfs source");
  }
  if (workspace.attachments.userSshState.source.kind === "netfs") {
    throw new Error("user-ssh-state must not use a netfs source");
  }
  if (workspace.attachments.workspaceData.source.kind === "netfs") {
    if (!workspace.attachments.workspaceData.source.server?.trim()) {
      throw new Error("workspace-data netfs source requires a server");
    }
    if (!workspace.attachments.workspaceData.source.exportPath?.trim()) {
      throw new Error("workspace-data netfs source requires an export path");
    }
  }
  const managerStateToken = terminalPathToken(workspace.agent.runtime.stateRoot);
  const evolutionStateToken = terminalPathToken(workspace.agent.runtime.evolutionRoot);
  if (
    workspace.agent.enabled &&
    workspace.attachments.workspaceRuntimeState.durablePaths.some((entry) => entry.includes(managerStateToken)) === false
  ) {
    throw new Error("workspace-runtime-state must contain the durable manager state path");
  }
  if (
    workspace.agent.enabled &&
    workspace.attachments.workspaceRuntimeState.durablePaths.some((entry) => entry.includes(evolutionStateToken)) === false
  ) {
    throw new Error("workspace-runtime-state must contain the durable evolution state path");
  }
  if (workspace.attachments.userIdentityState.durablePaths.some((entry) => entry.includes("/identity/")) === false) {
    throw new Error("user-identity-state must expose identity attachment roots");
  }
  if (workspace.attachments.userSshState.durablePaths.some((entry) => entry === "/ssh") === false) {
    throw new Error("user-ssh-state must expose the shared SSH attachment root");
  }
  if (workspace.attachments.ephemeralRuntime.staleArtifacts.length === 0) {
    throw new Error("ephemeral-runtime must define stale artifact cleanup targets");
  }
  for (const authFile of workspace.runtime.authFiles) {
    if (!authFile.content && !authFile.sourcePath) {
      throw new Error(`Auth file '${authFile.key}' must define inline content or a source path`);
    }
    if (authFile.sourcePath && !authFile.content) {
      throw new Error(`Auth file '${authFile.key}' source path is missing or unreadable: ${authFile.sourcePath}`);
    }
  }

  if (workspace.agent.enabled) {
    if (workspace.agent.managerId === "none") {
      throw new Error("Agent-enabled workspaces require a manager id");
    }
    if (!workspace.agent.capabilities.supportsEventStream) {
      throw new Error("Agent-enabled workspaces require manager event stream support");
    }
    if (!workspace.agent.capabilities.supportsTranscriptReplay) {
      throw new Error("Agent-enabled workspaces require transcript replay support");
    }
    const requiredFiles = ["codex-auth.json", "codex-config.toml"];
    for (const key of requiredFiles) {
      const authFile = workspace.runtime.authFiles.find((entry) => entry.key === key);
      if (!authFile) {
        throw new Error(`Agent-enabled workspaces require auth file '${key}'`);
      }
      if (!authFile.content && !authFile.sourcePath) {
        throw new Error(`Auth file '${key}' must define inline content or a source path`);
      }
    }
  }

  if (workspace.userProfile.ssh.mode === "provided-key") {
    const sshPrivateKey = workspace.runtime.authFiles.find((entry) => {
      return entry.mountPath.startsWith(`${workspace.runtime.home}/.ssh/`) && !entry.mountPath.endsWith(".pub");
    });
    const sshPublicKey = workspace.runtime.authFiles.find((entry) => {
      return entry.mountPath.startsWith(`${workspace.runtime.home}/.ssh/`) && entry.mountPath.endsWith(".pub");
    });
    if (!sshPrivateKey) {
      throw new Error("User profile SSH mode 'provided-key' requires staged private-key material");
    }
    if (!sshPublicKey?.content) {
      throw new Error("User profile SSH mode 'provided-key' requires staged public-key material");
    }
    const publicKeyComment = parsePublicKeyComment(sshPublicKey.content);
    if (publicKeyComment !== workspace.userProfile.ssh.comment) {
      throw new Error(
        `User profile SSH mode 'provided-key' requires public-key comment '${workspace.userProfile.ssh.comment}', got '${publicKeyComment || "missing"}'`,
      );
    }
  }

  if (workspace.backend.kind === "pod") {
    if (!POD_PROFILES.has(workspace.backend.profile)) {
      throw new Error(`Workspace backend 'pod' requires a supported profile; got ${workspace.backend.profile}`);
    }
    for (const envVar of workspace.runtime.plainEnvVars) {
      if (envVar.value.includes("/workspace/")) {
        throw new Error(`Workspace backend 'pod' cannot set env var ${envVar.name} to a /workspace path`);
      }
    }
  }

  if (workspace.health.requiresDaemon !== workspace.agent.capabilities.requiresDaemon) {
    throw new Error("Workspace health daemon requirement must match manager capabilities");
  }
}
