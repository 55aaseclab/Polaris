export type BackendKind = "pod" | "kubevirt-vm" | "docker";
export type PodProfile = "gvisor" | "kata-qemu" | "kata-clh" | "kata-qemu-tdx";
export type LifecycleAction = "create" | "start" | "stop" | "restart" | "rebuild" | "status" | "reconcile" | "render" | "apply" | "logs";
export type DurableAttachmentKind = "workspace-data" | "workspace-runtime-state" | "user-identity-state" | "user-ssh-state";
export type AttachmentScope = "workspace" | "user";
export type AttachmentSharing = "exclusive" | "cross-workspace";
export type AttachmentSourceKind = "persistent-volume" | "secret-material" | "generated-material" | "legacy-backend";
export type DirectAttachmentConfigKey = "workspace-data" | "workspace-runtime-state" | "user-identity-state" | "user-ssh-state";

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

export interface WorkspaceIdentity {
  projectName: string;
}

export interface WorkspaceProfile {
  name: string;
  assetBaseName: string;
  workspaceAlias?: string;
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
  workspaces: string[];
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

export interface WorkspaceCredentialBinding {
  purpose: string;
  credentialId: string;
  required: boolean;
}

export interface ResolvedWorkspaceCredentialBinding
  extends WorkspaceCredentialBinding {
  source: "registry" | "compatibility";
  credential: Credential;
  attachmentKind: "user-identity-state" | "user-ssh-state";
  authFiles: AuthFile[];
}

export interface WorkspaceBackend {
  kind: BackendKind;
  profile: string;
  specFiles: string[];
  dockerRuntimeMode: "disabled" | "legacy";
}

export interface WorkspaceStorage {
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
    description?: string;
  };
}

export interface DirectEphemeralRuntimeConfig {
  mountRoot: string;
  paths: string[];
  staleArtifacts: string[];
}

export interface DirectAttachmentConfig {
  "workspace-data": DirectDurableAttachmentConfig;
  "workspace-runtime-state": DirectDurableAttachmentConfig;
  "user-identity-state": DirectDurableAttachmentConfig;
  "user-ssh-state": DirectDurableAttachmentConfig;
  "ephemeral-runtime": DirectEphemeralRuntimeConfig;
}

export interface EphemeralRuntimeState {
  mountRoot: string;
  paths: string[];
  staleArtifacts: string[];
}

export interface WorkspaceAttachments {
  workspaceData: DurableAttachment;
  workspaceRuntimeState: DurableAttachment;
  userIdentityState: DurableAttachment;
  userSshState: DurableAttachment;
  ephemeralRuntime: EphemeralRuntimeState;
}

export interface WorkspaceResources {
  cpu: string;
  memory: string;
  ephemeralStorage: string;
  cpuRequest?: string;
  memoryRequest?: string;
  storageRequest?: string;
  unbounded: boolean;
}

export interface WorkspaceRuntime {
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

export interface WorkspaceAgentContract {
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
  harnesses: Array<"codex" | "claude">;
  runtime: {
    stateRoot: string;
    evolutionRoot: string;
    readyFile?: string;
    pairingFile?: string;
    staleRuntimeArtifacts: string[];
  };
}

export interface WorkspaceConnectivity {
  exposeService: boolean;
  serviceMode: "nodeport" | "ingress";
  servicePorts: ServicePort[];
  serviceHost?: string;
  servicePath: string;
}

export interface WorkspaceRuntimeContract {
  minimalInvariants: string[];
  staleRuntimeArtifacts: string[];
}

export interface WorkspaceHealthPolicy {
  readinessMode: "ready-file" | "daemon-port";
  requiresDaemon: boolean;
}

export interface WorkspaceLifecycle {
  actions: LifecycleAction[];
}

export interface WorkspaceSpec {
  identity: WorkspaceIdentity;
  profile: WorkspaceProfile;
  userProfile: UserProfile;
  credentials: Credential[];
  credentialBindings: WorkspaceCredentialBinding[];
  resolvedCredentialBindings: ResolvedWorkspaceCredentialBinding[];
  backend: WorkspaceBackend;
  storage: WorkspaceStorage;
  attachments: WorkspaceAttachments;
  resources: WorkspaceResources;
  runtime: WorkspaceRuntime;
  agent: WorkspaceAgentContract;
  connectivity: WorkspaceConnectivity;
  lifecycle: WorkspaceLifecycle;
  runtimeContract: WorkspaceRuntimeContract;
  health: WorkspaceHealthPolicy;
  evolution?: {
    bootstrapContextFile: string;
    bootstrapContextContent: string;
    controlPlaneSnapshotPath?: string;
    artifactCount: number;
  };
}

export interface WorkspaceStatus {
  project: string;
  backend: {
    kind: string;
    profile: string;
    instanceState?: "missing" | "created" | "running" | "stopped" | "degraded" | "unsupported";
  };
  lifecycleAction: LifecycleAction;
  state: "saved" | "not-applied" | "degraded" | "ready" | "unsupported";
  health: {
    backendLiveness: string;
    workspaceReadiness: string;
    daemonReadiness: string;
    reason?: string;
  };
  details: Record<string, string | undefined>;
  evolution?: {
    artifactCount: number;
    activeWorkspaceArtifacts: number;
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
    lastSessionId?: string;
  };
  ssh?: {
    mode: "managed-key" | "provided-key";
    githubAccount?: string;
    selfCheck: {
      state: "ready" | "warning" | "error" | "not-configured";
      message: string;
    };
  };
  drift?: WorkspaceDrift;
  attachments?: Record<string, CheckStatus>;
  runtimeAssembly?: Record<string, CheckStatus>;
  daemon?: Record<string, CheckStatus>;
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
    workspaceData?: ObservationItem;
    workspaceRuntimeState?: ObservationItem;
    userIdentityState?: ObservationItem;
    userSshState?: ObservationItem;
  };
  runtimeAssembly: {
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

export interface WorkspaceDrift {
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
