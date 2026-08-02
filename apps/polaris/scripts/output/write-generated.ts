import fs from "node:fs";
import path from "node:path";
import type { VaultSpec } from "../core/vault.js";
import { polarisUsersRoot } from "../utils/paths.js";

const USER_ROOT = polarisUsersRoot(import.meta.url);

export function generatedOutputPath(vault: VaultSpec): string {
  const backendFile =
    vault.backend.kind === "pod"
      ? "pod.yaml"
      : vault.backend.kind === "kubevirt-vm"
        ? "kubevirt.yaml"
        : "docker.yaml";
  return path.join(
    USER_ROOT,
    vault.userProfile.id,
    "vaults",
    vault.identity.projectName,
    "generated",
    backendFile,
  );
}

export function writeGeneratedManifest(vault: VaultSpec, yamlText: string): string {
  const outputPath = generatedOutputPath(vault);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, yamlText, "utf8");
  return outputPath;
}
