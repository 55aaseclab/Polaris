import fs from "node:fs";
import path from "node:path";
import type { WorkspaceSpec } from "../../core/workspace.js";
import { writeGeneratedManifest } from "../../output/write-generated.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..");

function indentBlock(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split(/\r?\n/)
    .filter((line, index, arr) => !(index === arr.length - 1 && line === ""))
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export function renderKubevirtWorkspace(workspace: WorkspaceSpec): string {
  if (workspace.identity.projectName !== "morpheus") {
    throw new Error("Workspace backend 'kubevirt-vm' is currently supported only for project 'morpheus'");
  }
  const cloudinitPath = path.join(REPO_ROOT, "config", "generated", "kubevirt", "morpheus-vm-cloudinit-secret.yaml");
  const vmPath = path.join(REPO_ROOT, "config", "generated", "kubevirt", "morpheus.yaml");
  const cloudinitTemplate = fs.readFileSync(cloudinitPath, "utf8");
  const vmTemplate = fs.readFileSync(vmPath, "utf8");
  const codexAuth = workspace.runtime.authFiles.find((item) => item.key === "codex-auth.json")?.content;
  const claudeSettings = workspace.runtime.authFiles.find((item) => item.key === "claude-settings.json")?.content;
  if (!codexAuth || !claudeSettings) {
    throw new Error("KubeVirt render requires codex-auth.json and claude-settings.json");
  }
  let renderedCloudinit = cloudinitTemplate
    .replace("        __CODEX_AUTH_JSON__", indentBlock(codexAuth, 8))
    .replace("        __CLAUDE_SETTINGS_JSON__", indentBlock(claudeSettings, 8));
  renderedCloudinit = renderedCloudinit
    .replace(
      "mkdir -p /workspace/.cache /workspace/.codex /workspace/.claude /workspace/.paseo /workspace/.ssh /workspace/.cargo /workspace/.rustup /workspace/.npm /workspace/.local/agent-cli /workspace/.tmp",
      "mkdir -p /workspace/project /workspace/state/paseo /identity/codex /identity/claude /ssh /workspace/.cache /workspace/.cargo /workspace/.rustup /workspace/.npm /workspace/.local/agent-cli /run/workspace/tmp",
    )
    .replace(
      `/bin/sh -lc 'for p in .cache .codex .claude .paseo .ssh .cargo .rustup .npm .tmp; do rm -rf "/root/$p"; ln -s "/workspace/$p" "/root/$p"; done'`,
      `/bin/sh -lc 'rm -rf /root/.codex /root/.claude /root/.paseo /root/.ssh /root/workspace; ln -sfn /identity/codex /root/.codex; ln -sfn /identity/claude /root/.claude; ln -sfn /workspace/state/paseo /root/.paseo; ln -sfn /ssh /root/.ssh; ln -sfn /workspace/project /root/workspace'`,
    )
    .replace("chmod 700 /workspace/.ssh", "chmod 700 /ssh")
    .replace("chmod 1777 /workspace/.tmp", "chmod 1777 /run/workspace/tmp")
    .replace("rm -f /workspace/.paseo/paseo.pid", "rm -f /workspace/state/paseo/paseo.pid")
    .replace("cat >/workspace/.codex/auth.json", "cat >/identity/codex/auth.json")
    .replace("cat >/workspace/.codex/config.toml", "cat >/identity/codex/config.toml")
    .replace("cat >/workspace/.claude/settings.json", "cat >/identity/claude/settings.json");
  return `${renderedCloudinit.trimEnd()}\n---\n${vmTemplate.trimEnd()}\n`;
}

export function renderAndWriteKubevirtWorkspace(workspace: WorkspaceSpec): string {
  return writeGeneratedManifest(workspace, renderKubevirtWorkspace(workspace));
}
