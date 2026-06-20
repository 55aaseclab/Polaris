export type BackendKind = "pod" | "kubevirt-vm" | "docker";
export type PodProfile = "gvisor" | "kata-qemu" | "kata-clh" | "kata-qemu-tdx";
export type LifecycleAction = "create" | "start" | "stop" | "restart" | "rebuild" | "status" | "reconcile" | "render" | "apply";

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

export interface WorkspaceConnectivity {
  exposeService: boolean;
  serviceMode: "nodeport" | "ingress";
  servicePorts: ServicePort[];
  serviceHost?: string;
  servicePath: string;
}

export interface WorkspaceRuntimeContract {
  durableState: string[];
  staleRuntimeArtifacts: string[];
  structuralInvariants: string[];
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
  backend: WorkspaceBackend;
  storage: WorkspaceStorage;
  resources: WorkspaceResources;
  runtime: WorkspaceRuntime;
  connectivity: WorkspaceConnectivity;
  lifecycle: WorkspaceLifecycle;
  runtimeContract: WorkspaceRuntimeContract;
  health: WorkspaceHealthPolicy;
}

export interface WorkspaceStatus {
  project: string;
  backend: {
    kind: string;
    profile: string;
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
}
