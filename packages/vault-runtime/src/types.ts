export type BackendKind = "pod" | "kubevirt-vm" | "docker";

export type RuntimeBackendProfile = string;

export interface PlainEnvVar {
  name: string;
  value: string;
}

export interface AuthFile {
  key: string;
  mountPath: string;
  content?: string;
  sourcePath?: string;
}

export interface ServicePort {
  containerPort: string;
  nodePort?: string;
  name?: string;
}

export interface RuntimeProfile {
  name: string;
  assetBaseName: string;
  vaultAlias?: string;
}

export interface RuntimeOwner {
  id: string;
  name: string;
  email: string;
  githubAccount?: string;
  sshMode: "managed-key" | "provided-key";
}

/**
 * Runtime-only owner projection. It intentionally excludes Polaris identity
 * mappings, roles, credentials, and ownership records.
 */
export interface RuntimeUserProfile {
  id: string;
  name: string;
  email: string;
  github: {
    account?: string;
  };
  ssh: {
    mode: "managed-key" | "provided-key";
  };
}

export type AttachmentScope = "vault" | "user";
export type AttachmentSharing = "exclusive" | "cross-vault";
export type AttachmentSourceKind =
  | "persistent-volume"
  | "secret-material"
  | "generated-material"
  | "legacy-backend"
  | "netfs";

export interface AttachmentSource {
  kind: AttachmentSourceKind;
  volumeRef?: string;
  volumeSize?: string;
  subPath?: string;
  server?: string;
  exportPath?: string;
  mountOptions?: string[];
  description?: string;
}

export interface DurableAttachment {
  kind: "vault-data" | "vault-runtime-state" | "user-identity-state";
  scope: AttachmentScope;
  sharing: AttachmentSharing;
  mountRoot: string;
  durablePaths: string[];
  source: AttachmentSource;
}

export interface EphemeralRuntimeState {
  mountRoot: string;
  paths: string[];
  staleArtifacts: string[];
}

export interface RuntimeAttachments {
  vaultData: DurableAttachment;
  vaultRuntimeState: DurableAttachment;
  userIdentityState: DurableAttachment;
  ephemeralRuntime: EphemeralRuntimeState;
}

export interface RuntimeResources {
  cpu: string;
  memory: string;
  ephemeralStorage: string;
  cpuRequest?: string;
  memoryRequest?: string;
  storageRequest?: string;
  unbounded: boolean;
}

export interface RuntimeRuntime {
  baseImage: string;
  rootdiskImage?: string;
  user: string;
  home: string;
  privileged: boolean;
  agentLabel: string;
  agentCmd: string;
  agentArgs: string[];
  bootstrapProfile: string;
  aptPackages: string[];
  installRustup: boolean;
  gitCoreEditor?: string;
  gitUserName?: string;
  gitUserEmail?: string;
  plainEnvVars: PlainEnvVar[];
  authFiles: AuthFile[];
}

export interface RuntimeTooling {
  nonPaseoPackageSpecs: string[];
  paseoPackageSpec: string;
  binaries: string[];
}

export interface RuntimeAgent {
  enabled: boolean;
  managerId: "none" | "paseo" | "generic-daemon";
  capabilities: {
    requiresDaemon: boolean;
  };
  runtime: {
    stateRoot: string;
    evolutionRoot: string;
    daemonAddress: string;
    readyFile?: string;
    pairingFile?: string;
    staleRuntimeArtifacts: string[];
  };
}

export interface RuntimeConnectivity {
  exposeService: boolean;
  serviceMode: "nodeport" | "ingress";
  servicePorts: ServicePort[];
  serviceHost?: string;
  servicePath: string;
}

export interface RuntimeHealth {
  readinessMode: "ready-file" | "daemon-port";
  requiresDaemon: boolean;
}

export interface PrivateSurface {
  id: string;
  /** Complete shell command used to run the private surface in the foreground. */
  command: string;
  image?: string;
  port: ServicePort;
  readyPath: string;
  healthPath: string;
  env: PlainEnvVar[];
  envFile?: AuthFile;
  secretEnv?: {
    name: string;
    value: string;
    resourceSuffix: string;
    key: string;
  };
  resources: {
    cpuRequest: string;
    memoryRequest: string;
    ephemeralStorageRequest: string;
    cpuLimit: string;
    memoryLimit: string;
    ephemeralStorageLimit: string;
    pidLimit: number;
  };
  networkPolicy?: {
    dns: boolean;
    web: boolean;
  };
}

export interface KubevirtTemplatePaths {
  generatedDir?: string;
  fallbackDir: string;
}

export interface RuntimeIntegration {
  paseoAppBaseUrl?: string;
  runtimeObserverScript?: string;
  kubevirtProbePassword: string;
  kubevirtTemplates: KubevirtTemplatePaths;
  privateSurface?: PrivateSurface;
}

export interface VaultRuntimeSpec {
  identity: {
    projectName: string;
  };
  userProfile: RuntimeUserProfile;
  profile: RuntimeProfile;
  backend: {
    kind: BackendKind;
    profile: RuntimeBackendProfile;
    dockerRuntimeMode: "disabled" | "legacy";
  };
  storage: {
    persistState: boolean;
    claimName: string;
  };
  attachments: RuntimeAttachments;
  resources: RuntimeResources;
  runtime: RuntimeRuntime;
  tooling: RuntimeTooling;
  agent: RuntimeAgent;
  connectivity: RuntimeConnectivity;
  health: RuntimeHealth;
  integration: RuntimeIntegration;
  manifestPath?: string;
  evolution?: {
    vaultMemoryFile: string;
    vaultMemoryContent: string;
    userMemoryFile: string;
    userMemoryContent: string;
    sessionSnapshotFile: string;
    sessionSnapshotContent: string;
  };
}

export interface ObservationItem {
  observed: boolean;
  detail?: string;
  url?: string;
}

export interface BackendObservation {
  backend: {
    kind: BackendKind;
    exists: boolean;
    running: boolean;
    detail?: string;
  };
  attachments: {
    vaultData?: ObservationItem;
    vaultRuntimeState?: ObservationItem;
    userIdentityState?: ObservationItem;
  };
  vaultAssembly: {
    home?: ObservationItem;
    projectRoot?: ObservationItem;
    managerState?: ObservationItem;
    evolutionState?: ObservationItem;
    codex?: ObservationItem;
    claude?: ObservationItem;
    ssh?: ObservationItem;
    githubAuth?: ObservationItem;
  };
  daemon: {
    manager?: ObservationItem;
    pairing?: ObservationItem;
  };
  services: {
    declared?: number;
    observed?: number;
    detail?: string;
  };
}

export interface ReconcileAction {
  kind:
    | "render"
    | "apply"
    | "restart-runtime"
    | "repair-runtime-assembly"
    | "clean-ephemeral-runtime"
    | "report-unrecoverable-drift";
  target?: string;
  reason?: string;
}

export interface ReconcilePlan {
  project: string;
  backend: string;
  safe: boolean;
  requiresRestart: boolean;
  destructive: boolean;
  actions: ReconcileAction[];
}

export interface RuntimeDriverDependencies {
  writeManifest(spec: VaultRuntimeSpec, yamlText: string): string;
  runCommand(command: string, args: string[]): void;
  logInfo(scope: string, message: string, details?: Record<string, unknown>): void;
  withDockerCapacity<T>(
    spec: VaultRuntimeSpec,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export interface BackendDriver {
  readonly kind: BackendKind;
  create(spec: VaultRuntimeSpec): Promise<void>;
  start(spec: VaultRuntimeSpec): Promise<void>;
  stop(spec: VaultRuntimeSpec): Promise<void>;
  restart(spec: VaultRuntimeSpec): Promise<void>;
  rebuild(spec: VaultRuntimeSpec): Promise<void>;
  render(spec: VaultRuntimeSpec): Promise<void>;
  apply(spec: VaultRuntimeSpec): Promise<void>;
  logs(spec: VaultRuntimeSpec): Promise<void>;
  inspect(spec: VaultRuntimeSpec): Promise<BackendObservation>;
  executeReconcilePlan(spec: VaultRuntimeSpec, plan: ReconcilePlan): Promise<void>;
}
