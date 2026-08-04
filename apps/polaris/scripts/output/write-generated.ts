import fs from "node:fs";
import path from "node:path";
import type { VaultSpec } from "../core/vault.js";
import { polarisUsersRoot } from "../utils/paths.js";

export function generatedOutputPath(vault: VaultSpec): string {
  const backendFile =
    vault.backend.kind === "pod"
      ? "pod.yaml"
      : vault.backend.kind === "kubevirt-vm"
        ? "kubevirt.yaml"
        : "docker.yaml";
  return path.join(
    polarisUsersRoot(import.meta.url),
    vault.userProfile.id,
    "vaults",
    vault.identity.projectName,
    "generated",
    backendFile,
  );
}

export function writeGeneratedManifest(vault: VaultSpec, yamlText: string): string {
  const outputPath = generatedOutputPath(vault);
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(outputDir, 0o700);
  fs.writeFileSync(outputPath, yamlText, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(outputPath, 0o600);
  return outputPath;
}
