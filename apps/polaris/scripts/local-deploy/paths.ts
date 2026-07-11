import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "../utils/paths.js";
import type { LocalDeployConfig } from "./types.js";

function expandHome(rawPath: string): string {
  if (!rawPath.startsWith("~")) {
    return rawPath;
  }
  return path.join(os.homedir(), rawPath.slice(1));
}

export function resolveDefaultLocalDeployDataRoot(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.POLARIS_LOCAL_DEPLOY_DATA_ROOT?.trim();
  if (configured) {
    return path.resolve(expandHome(configured));
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Polaris");
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) {
      return path.join(localAppData, "Polaris");
    }
    return path.join(os.homedir(), "AppData", "Local", "Polaris");
  }
  return path.join(os.homedir(), ".local", "share", "polaris");
}

export function resolveLocalDeployConfig(
  importMetaUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): LocalDeployConfig {
  let root = "";
  try {
    root = repoRoot(importMetaUrl);
  } catch {
    root = process.cwd();
  }
  const executableDir = path.dirname(fs.realpathSync(process.execPath));
  const configuredBundleRoot = env.POLARIS_LOCAL_DEPLOY_BUNDLE_ROOT?.trim();
  const bundleCandidates = [
    configuredBundleRoot ? path.resolve(expandHome(configuredBundleRoot)) : null,
    path.join(executableDir, "bundle"),
    path.resolve(executableDir, "..", "bundle"),
    path.join(root, "deploy", "local-deploy"),
  ].filter(Boolean) as string[];
  const bundleRoot = bundleCandidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "docker-compose.yml"))
  );
  if (!bundleRoot) {
    throw new Error("Polaris local deployment bundle is missing");
  }
  const dataRoot = resolveDefaultLocalDeployDataRoot(process.platform, env);
  const stateRoot = path.join(dataRoot, "local-deploy");
  const gatewayPort = Number.parseInt(env.POLARIS_LOCAL_DEPLOY_PORT?.trim() || "18081", 10);
  const projectName = env.POLARIS_LOCAL_DEPLOY_PROJECT?.trim() || "polaris-local";
  return {
    bundleRoot,
    composeFile: path.join(bundleRoot, "docker-compose.yml"),
    dataRoot,
    envFile: path.join(stateRoot, "polaris-local.env"),
    gatewayPort: Number.isInteger(gatewayPort) && gatewayPort > 0 ? gatewayPort : 18081,
    gatewayUrl: `http://127.0.0.1:${Number.isInteger(gatewayPort) && gatewayPort > 0 ? gatewayPort : 18081}`,
    projectName,
    releaseManifestPath: path.join(bundleRoot, "release.json"),
    stateRoot,
  };
}

export function ensureLocalDeployDirs(config: LocalDeployConfig): void {
  fs.mkdirSync(config.dataRoot, { recursive: true });
  fs.mkdirSync(config.stateRoot, { recursive: true });
}
