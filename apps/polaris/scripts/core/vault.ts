export type BackendKind = "pod" | "kubevirt-vm" | "docker";
export type PodProfile = "gvisor" | "kata-qemu" | "kata-clh" | "kata-qemu-tdx";
export type VaultCommandKind =
  | "create"
  | "start"
  | "stop"
  | "restart"
  | "rebuild"
  | "status"
  | "reconcile"
  | "render"
  | "apply"
  | "logs";
export type VaultOperationKind =
  | "create"
  | "start"
  | "stop"
  | "rebuild"
  | "delete";
export type DurableAttachmentKind = "vault-data" | "vault-runtime-state" | "user-identity-state";
export type AttachmentScope = "vault" | "user";
export type AttachmentSharing = "exclusive" | "cross-vault";
export type AttachmentSourceKind =
  | "persistent-volume"
  | "secret-material"
  | "generated-material"
  | "legacy-backend"
  | "netfs";
export type DirectAttachmentConfigKey = "vault-data" | "vault-runtime-state" | "user-identity-state";

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

export interface VaultIdentity {
  projectName: string;
}

export interface VaultProfile {
  name: string;
  assetBaseName: string;
  vaultAlias?: string;
  defaults: {
    runtime?: {
      baseImage?: string;
      bootstrapProfile?: string;
      user?: string;
    };
    service?: {
      host?: string;
      path?: string;
    };
  };
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  secretsRoot: string;
  vaults: string[];
  github: {
    account?: string;
  };
  ssh: {
    mode: "managed-key" | "provided-key";
    comment: string;
  };
  agentIdentity: {
    codex: string;
    claude: string;
  };
  authFiles: AuthFile[];
}

export type CredentialKind =
  | "ssh-key"
  | "api-key"
  | "codex-auth"
  | "git-https-token"
  | "kubeconfig"
  | "cloud-token";

export interface CredentialMaterialFile {
  key: string;
  sourcePath: string;
  mountPath: string;
  content?: string;
}

export interface CredentialMaterialRef {
  type: "file";
  key: string;
  files: CredentialMaterialFile[];
}

export interface CredentialMetadata {
  [key: string]: boolean | number | string | string[] | null | undefined;
}

export interface Credential {
  id: string;
  userId: string;
  kind: CredentialKind;
  label: string;
  purposes: string[];
  materialRef: CredentialMaterialRef;
  metadata: CredentialMetadata;
  status: string;
}

export interface VaultCredentialBinding {
  purpose: string;
  credentialId: string;
  required: boolean;
}

export interface ResolvedVaultCredentialBinding
  extends VaultCredentialBinding {
  source: "registry" | "compatibility";
  credential: Credential;
  attachmentKind: "user-identity-state";
  authFiles: AuthFile[];
}

export interface VaultBackend {
  kind: BackendKind;
  profile: string;
  specFiles: string[];
  dockerRuntimeMode: "disabled" | "legacy";
}

export interface VaultStorage {
  persistState: boolean;
  claimName: string;
  durablePaths: string[];
}

export interface DurableAttachment {
  kind: DurableAttachmentKind;
  scope: AttachmentScope;
  sharing: AttachmentSharing;
  mountRoot: string;
  durablePaths: string[];
  source: {
    kind: AttachmentSourceKind;
    volumeRef?: string;
    volumeSize?: string;
    subPath?: string;
    server?: string;
    exportPath?: string;
    mountOptions?: string[];
    description?: string;
  };
}

export interface DirectDurableAttachmentConfig {
  scope: AttachmentScope;
  sharing: AttachmentSharing;
  mountRoot: string;
  durablePaths: string[];
  source: {
    kind: AttachmentSourceKind;
    volumeRef?: string;
    volumeSize?: string;
    subPath?: string;
    server?: string;
    exportPath?: string;
    mountOptions?: string[];
    description?: string;
  };
}

export interface DirectEphemeralRuntimeConfig {
  mountRoot: string;
  paths: string[];
  staleArtifacts: string[];
}

export interface DirectAttachmentConfig {
  "vault-data": DirectDurableAttachmentConfig;
  "vault-runtime-state": DirectDurableAttachmentConfig;
  "user-identity-state": DirectDurableAttachmentConfig;
  "ephemeral-runtime": DirectEphemeralRuntimeConfig;
}

export interface EphemeralRuntimeState {
  mountRoot: string;
  paths: string[];
  staleArtifacts: string[];
}

export interface VaultAttachments {
  vaultData: DurableAttachment;
  vaultRuntimeState: DurableAttachment;
  userIdentityState: DurableAttachment;
  ephemeralRuntime: EphemeralRuntimeState;
}

export interface VaultResources {
  cpu: string;
  memory: string;
  ephemeralStorage: string;
  cpuRequest?: string;
  memoryRequest?: string;
  storageRequest?: string;
  unbounded: boolean;
}

export interface VaultRuntime {
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

export interface VaultAgentContract {
  enabled: boolean;
  managerId: "none" | "paseo" | "generic-daemon";
  contractVersion: "v1";
  capabilities: {
    supportsEventStream: boolean;
    supportsTranscriptReplay: boolean;
    supportsStructuredArtifacts: boolean;
    supportsReview: boolean;
    supportsRetrieval: boolean;
    supportsCuration: boolean;
    requiresDaemon: boolean;
    supportsPairing: boolean;
  };
  harnesses: Array<"codex" | "claude" | "copilot" | "opencode" | "pi">;
  runtime: {
    stateRoot: string;
    evolutionRoot: string;
    daemonAddress: string;
    readyFile?: string;
    pairingFile?: string;
    staleRuntimeArtifacts: string[];
  };
}

export interface VaultConnectivity {
  exposeService: boolean;
  serviceMode: "nodeport" | "ingress";
  servicePorts: ServicePort[];
  serviceHost?: string;
  servicePath: string;
}

export interface VaultRuntimeContract {
  minimalInvariants: string[];
  staleRuntimeArtifacts: string[];
}

export interface VaultHealthPolicy {
  readinessMode: "ready-file" | "daemon-port";
  requiresDaemon: boolean;
}

export interface VaultLifecycle {
  actions: VaultCommandKind[];
}

export interface VaultSpec {
  identity: VaultIdentity;
  profile: VaultProfile;
  userProfile: UserProfile;
  credentials: Credential[];
  credentialBindings: VaultCredentialBinding[];
  resolvedCredentialBindings: ResolvedVaultCredentialBinding[];
  backend: VaultBackend;
  storage: VaultStorage;
  attachments: VaultAttachments;
  resources: VaultResources;
  runtime: VaultRuntime;
  agent: VaultAgentContract;
  connectivity: VaultConnectivity;
  lifecycle: VaultLifecycle;
  runtimeContract: VaultRuntimeContract;
  health: VaultHealthPolicy;
  evolution?: {
    vaultMemoryFile: string;
    vaultMemoryContent: string;
    userMemoryFile: string;
    userMemoryContent: string;
    sessionSnapshotFile: string;
    sessionSnapshotContent: string;
    controlPlaneVaultMemoryPath?: string;
    controlPlaneUserMemoryPath?: string;
    controlPlaneSessionSnapshotPath?: string;
    controlPlanePendingMemoryPath?: string;
    artifactCount: number;
  };
}

export const VAULT_STATUS_SCHEMA_VERSION_V1 = 1 as const;
export const VAULT_STATUS_SCHEMA_VERSION_V1_1 = 1.1 as const;
export const VAULT_STATUS_SCHEMA_VERSION = VAULT_STATUS_SCHEMA_VERSION_V1_1;
export type VaultStatusSchemaVersion =
  | typeof VAULT_STATUS_SCHEMA_VERSION_V1
  | typeof VAULT_STATUS_SCHEMA_VERSION_V1_1;

export interface VaultStatusDriverTarget {
  backend: "docker" | "pod" | "kubevirt-vm";
  profile?: string;
}

export type VaultDriverStatus =
  | "absent"
  | "creating"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "rebuilding"
  | "archiving"
  | "deleting"
  | "failed"
  | "unknown";

export interface VaultStatus {
  schemaVersion?: VaultStatusSchemaVersion;
  project: string;
  driver?: {
    selected: VaultStatusDriverTarget | null;
    status: VaultDriverStatus;
    reason?: string;
    baseImage?: string;
    runtimeKind?: "docker-container" | "kubernetes-pod" | "kubevirt-vm";
    runtimeRef?: string;
    rootdiskImage?: string;
  };
  paseo: {
    daemon: "absent" | "pending" | "ready" | "unknown";
    web: "unavailable" | "pairing-required" | "connectable";
    reconnectMode: "reconnectable" | "needs-pairing" | "unknown";
    liveTarget: string | null;
    reconnectTarget: string | null;
    reason?: string;
  };
  credentials?: {
    ssh?: {
      mode: "managed-key" | "provided-key";
      githubAccount?: string;
      selfCheck: {
        state: "ready" | "warning" | "error" | "not-configured";
        message: string;
      };
    };
    codex?: {
      state: "selected" | "not-selected";
      credentialId?: string;
      label?: string;
      source?: "vault-binding" | "user-active" | "compatibility";
    };
    live?: {
      supportedHarnesses: string[];
      switchableHarnesses: string[];
      selectedHarness?: string;
      selectedCredentialId?: string;
      selectedCredentialLabel?: string;
      source?: "runtime-state" | "vault-binding" | "user-active" | "compatibility";
      selectedByHarness?: Record<string, {
        credentialId: string;
        label: string;
        source: "runtime-state" | "vault-binding" | "user-active" | "compatibility";
      }>;
    };
  };
  skills?: {
    installedByHarness?: Record<string, string[]>;
    source?: string;
  };
  details: Record<string, string | undefined>;
  evolution?: {
    artifactCount: number;
    activeVaultArtifacts: number;
    activeUserArtifacts: number;
    latestTitles: string[];
    latestArtifacts?: Array<{
      title: string;
      kind: string;
      status: string;
      whyExists?: string;
      whyRetrieved?: string[];
      curatorAction?: string;
      curatorReason?: string;
      suppressedBecause?: string;
    }>;
    pendingMemoryChanges?: number;
    lastSessionId?: string;
  };
  assets?: {
    dockerfile: {
      file: string;
      path: string;
      exists?: boolean;
    };
    specs: Array<{
      driver: string;
      file: string;
      path: string;
      exists?: boolean;
    }>;
    generatedManifests: Array<{
      driver: string;
      file: string;
      path: string;
      exists?: boolean;
    }>;
    imageTags: Array<{
      name: string;
      tag: string;
    }>;
    evolutionFiles: Array<{
      name: string;
      path: string;
      scope: "runtime" | "control-plane";
      exists?: boolean;
    }>;
    persistentVolumes: Array<{
      name: string;
      sourceKind: string;
      sourceRef?: string;
      mountRoot: string;
      durablePaths: string[];
    }>;
  };
  attachments?: Record<string, CheckStatus>;
  vaultAssembly?: Record<string, CheckStatus>;
}

export interface ObservationItem {
  observed: boolean;
  detail?: string;
  url?: string;
}

export interface CheckStatus {
  state: "ok" | "missing" | "drifted" | "unknown";
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

export interface DriftItem {
  kind: "backend" | "attachment" | "runtime-assembly" | "daemon" | "service";
  target: string;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface VaultDrift {
  items: DriftItem[];
  hasErrors: boolean;
  hasWarnings: boolean;
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
