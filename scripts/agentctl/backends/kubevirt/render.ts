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
  const cloudinitPath = path.join(REPO_ROOT, "config", "kubevirt", "generated", "morpheus-vm-cloudinit-secret.yaml");
  const vmPath = path.join(REPO_ROOT, "config", "kubevirt", "generated", "morpheus.yaml");
  const cloudinitTemplate = fs.readFileSync(cloudinitPath, "utf8");
  const vmTemplate = fs.readFileSync(vmPath, "utf8");
  const codexAuth = workspace.runtime.authFiles.find((item) => item.key === "codex-auth.json")?.content;
  const claudeSettings = workspace.runtime.authFiles.find((item) => item.key === "claude-settings.json")?.content;
  if (!codexAuth || !claudeSettings) {
    throw new Error("KubeVirt render requires codex-auth.json and claude-settings.json");
  }
  const renderedCloudinit = cloudinitTemplate
    .replace("        __CODEX_AUTH_JSON__", indentBlock(codexAuth, 8))
    .replace("        __CLAUDE_SETTINGS_JSON__", indentBlock(claudeSettings, 8));
  return `${renderedCloudinit.trimEnd()}\n---\n${vmTemplate.trimEnd()}\n`;
}

export function renderAndWriteKubevirtWorkspace(workspace: WorkspaceSpec): string {
  return writeGeneratedManifest(workspace, renderKubevirtWorkspace(workspace));
}
