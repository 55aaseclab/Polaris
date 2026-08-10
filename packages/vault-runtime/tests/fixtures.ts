import type {
  BackendKind,
  PrivateSurface,
  VaultRuntimeSpec,
} from "../src/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SYNTHETIC_OWNER_ID = "tenant-a";
export const SYNTHETIC_PROJECT = "synthetic-vault";

export function createPrivateSurface(): PrivateSurface {
  return {
    id: "surface",
    command: "exec /usr/local/bin/surface --port 9090",
    image: "example/surface:synthetic",
    port: {
      name: "surface",
      containerPort: "9090",
    },
    readyPath: "/readyz",
    healthPath: "/healthz",
    env: [
      { name: "SURFACE_MODE", value: "private" },
    ],
    secretEnv: {
      name: "SURFACE_ASSERTION_SECRET",
      value: "synthetic-secret",
      resourceSuffix: "surface-gateway",
      key: "assertion-secret",
    },
    resources: {
      cpuRequest: "100m",
      memoryRequest: "128Mi",
      ephemeralStorageRequest: "128Mi",
      cpuLimit: "500m",
      memoryLimit: "512Mi",
      ephemeralStorageLimit: "512Mi",
      pidLimit: 128,
    },
    networkPolicy: {
      dns: true,
      web: true,
    },
  };
}

export function createKubevirtTemplateDirectory(): {
  directory: string;
  cleanup: () => void;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vault-runtime-templates-"));
  fs.writeFileSync(
    path.join(directory, "vm.yaml"),
    [
      "name: __PROJECT__-vm",
      "cloudinit: __PROJECT__-vm-cloudinit",
      "claims: __PERSISTENT_VOLUME_CLAIMS__",
      "service: __SERVICE_PORTS__",
      "interfaces: __INTERFACE_PORTS__",
      "private: __PRIVATE_SURFACE_SERVICE__",
      "rootdisk: __ROOTDISK_IMAGE__",
      "guest: __MEMORY_GUEST__",
      "request: __MEMORY_REQUEST__",
      "data: __VAULT_DATA_VOLUME__",
      "state: __VAULT_RUNTIME_STATE_VOLUME__",
      "identity: __USER_IDENTITY_STATE_VOLUME__",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(directory, "vm-cloudinit-secret.yaml"),
    [
      "password: __PROBE_PASSWORD__",
      "auth: __CODEX_AUTH_JSON_B64__",
      "config: __CODEX_CONFIG_TOML_B64__",
      "assignment: __PASEO_APP_BASE_URL_ASSIGNMENT__",
      "      - chmod 1777 /run/vault/tmp",
    ].join("\n"),
    "utf8",
  );
  return {
    directory,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

export function createRuntimeSpec(options: {
  backendKind?: BackendKind;
  privateSurface?: PrivateSurface;
} = {}): VaultRuntimeSpec {
  const backendKind = options.backendKind ?? "docker";
  const profile = backendKind === "docker"
    ? "legacy"
    : backendKind === "pod"
      ? "gvisor"
      : "vm";

  return {
    identity: {
      projectName: SYNTHETIC_PROJECT,
    },
    userProfile: {
      id: SYNTHETIC_OWNER_ID,
      name: "Synthetic Tenant",
      email: "tenant-a@example.test",
      github: {},
      ssh: { mode: "managed-key" },
    },
    profile: {
      name: "morpheus",
      assetBaseName: "morpheus",
      vaultAlias: "vault",
    },
    backend: {
      kind: backendKind,
      profile,
      dockerRuntimeMode: "legacy",
    },
    storage: {
      persistState: true,
      claimName: "synthetic-runtime-state",
    },
    attachments: {
      vaultData: {
        kind: "vault-data",
        scope: "vault",
        sharing: "exclusive",
        mountRoot: "/vault/project",
        durablePaths: ["/vault/project"],
        source: {
          kind: "persistent-volume",
          volumeRef: "synthetic-vault-data",
          volumeSize: "20Gi",
        },
      },
      vaultRuntimeState: {
        kind: "vault-runtime-state",
        scope: "vault",
        sharing: "exclusive",
        mountRoot: "/vault/state",
        durablePaths: ["/vault/state/paseo"],
        source: {
          kind: "persistent-volume",
          volumeRef: "synthetic-runtime-state",
          volumeSize: "20Gi",
        },
      },
      userIdentityState: {
        kind: "user-identity-state",
        scope: "user",
        sharing: "cross-vault",
        mountRoot: "/identity",
        durablePaths: ["/identity/codex", "/identity/ssh"],
        source: {
          kind: "persistent-volume",
          volumeRef: "synthetic-user-identity",
          volumeSize: "5Gi",
        },
      },
      ephemeralRuntime: {
        mountRoot: "/run/vault/tmp",
        paths: ["/run/vault/tmp"],
        staleArtifacts: ["/root/.paseo/paseo.pid"],
      },
    },
    resources: {
      cpu: "1",
      memory: "512Mi",
      ephemeralStorage: "512Mi",
      cpuRequest: "100m",
      memoryRequest: "128Mi",
      storageRequest: "128Mi",
      unbounded: false,
    },
    runtime: {
      baseImage: "example/runtime:synthetic",
      rootdiskImage: "example/rootdisk:synthetic",
      user: "root",
      home: "/root",
      privileged: false,
      agentLabel: "synthetic-agent",
      agentCmd: "",
      agentArgs: [],
      bootstrapProfile: "prebuilt",
      aptPackages: [],
      installRustup: false,
      plainEnvVars: [],
      authFiles: [],
    },
    tooling: {
      nonPaseoPackageSpecs: [],
      paseoPackageSpec: "",
      binaries: ["codex", "claude"],
    },
    agent: {
      enabled: false,
      managerId: "none",
      capabilities: {
        requiresDaemon: false,
      },
      runtime: {
        stateRoot: "/root/.paseo",
        evolutionRoot: "/root/.paseo/evolution",
        daemonAddress: "127.0.0.1:6767",
        staleRuntimeArtifacts: ["/root/.paseo/paseo.pid"],
      },
    },
    connectivity: {
      exposeService: true,
      serviceMode: "nodeport",
      servicePorts: [
        {
          name: "http",
          containerPort: "8080",
          nodePort: "30080",
        },
        ...(options.privateSurface ? [options.privateSurface.port] : []),
      ],
      servicePath: "/",
    },
    health: {
      readinessMode: "ready-file",
      requiresDaemon: false,
    },
    integration: {
      kubevirtProbePassword: "synthetic-probe-password",
      kubevirtTemplates: {
        fallbackDir: "",
      },
      privateSurface: options.privateSurface,
    },
  };
}
