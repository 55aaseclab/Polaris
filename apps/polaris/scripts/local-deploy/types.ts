export const LOCAL_DEPLOY_ACTIONS = [
  "install",
  "start",
  "stop",
  "restart",
  "status",
  "open",
  "logs",
  "doctor",
  "upgrade",
  "uninstall",
  "desktop",
] as const;

export type LocalDeployAction = typeof LOCAL_DEPLOY_ACTIONS[number];

export interface LocalDeployConfig {
  bundleRoot: string;
  composeFile: string;
  dataRoot: string;
  envFile: string;
  gatewayPort: number;
  gatewayUrl: string;
  projectName: string;
  releaseManifestPath: string;
  stateRoot: string;
}

export interface LocalDeployActionResult {
  action: LocalDeployAction;
  message: string;
  details?: string[];
}
