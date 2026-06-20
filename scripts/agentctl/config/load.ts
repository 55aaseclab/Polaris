import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { WorkspaceSpec, PlainEnvVar, AuthFile, ServicePort, WorkspaceAttachments, DurableAttachment } from "../core/workspace.js";
import { validateWorkspace } from "../core/capabilities.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

function specCandidates(project: string): string[] {
  return [
    path.join(REPO_ROOT, "config", "specs", "pod", "projects", `${project}.agent.yaml`),
    path.join(REPO_ROOT, "config", "specs", "kubevirt", "projects", `${project}.agent.yaml`),
    path.join(REPO_ROOT, "config", "specs", "docker", "projects", `${project}.agent.yaml`),
    path.join(REPO_ROOT, "config", "gvisor", "specs", `${project}.agent.yaml`),
    path.join(REPO_ROOT, "config", "kubevirt", "specs", `${project}.agent.yaml`),
    path.join(REPO_ROOT, "agents", `${project}.agent.yaml`)
  ];
}

function canonicalHome(user: string, projectName: string): string {
  return user === "root" ? "/root" : `/home/${user || projectName}`;
}

function authFileKind(file: AuthFile, home: string): "identity" | "ssh" {
  const normalizedHome = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^${normalizedHome}/\\.ssh/`).test(file.mountPath) || file.key.includes("ssh")) {
    return "ssh";
  }
  return "identity";
}

function buildAttachment(
  kind: DurableAttachment["kind"],
  scope: DurableAttachment["scope"],
  sharing: DurableAttachment["sharing"],
  mountRoot: string,
  durablePaths: string[],
  source: DurableAttachment["source"],
): DurableAttachment {
  return {
    kind,
    scope,
    sharing,
    mountRoot,
    durablePaths,
    source,
  };
}

function translateLegacyAttachments(args: {
  projectName: string;
  home: string;
  persistState: boolean;
  claimName: string;
  authFiles: AuthFile[];
  backendKind: WorkspaceSpec["backend"]["kind"];
}): WorkspaceAttachments {
  const workspaceVolumeSource = args.persistState
    ? {
        kind: "persistent-volume" as const,
        volumeRef: args.claimName,
        description: `workspace-scoped persistent storage for ${args.projectName}`,
      }
    : {
        kind: "generated-material" as const,
        description: `ephemeral workspace storage for ${args.projectName}`,
      };
  const identityFiles = args.authFiles.filter((file) => authFileKind(file, args.home) === "identity");
  const sshFiles = args.authFiles.filter((file) => authFileKind(file, args.home) === "ssh");

  return {
    workspaceData: buildAttachment(
      "workspace-data",
      "workspace",
      "exclusive",
      "/workspace/project",
      ["/workspace/project"],
      workspaceVolumeSource,
    ),
    workspaceRuntimeState: buildAttachment(
      "workspace-runtime-state",
      "workspace",
      "exclusive",
      "/workspace/state",
      ["/workspace/state/paseo"],
      {
        ...workspaceVolumeSource,
        subPath: "state",
        description: `workspace runtime state for ${args.projectName}`,
      },
    ),
    userIdentityState: buildAttachment(
      "user-identity-state",
      "user",
      "cross-workspace",
      "/identity",
      ["/identity/codex", "/identity/claude"],
      {
        kind: "secret-material",
        description: identityFiles.length
          ? `user identity material sourced from ${identityFiles.map((file) => file.key).join(", ")}`
          : "user identity material",
      },
    ),
    userSshState: buildAttachment(
      "user-ssh-state",
      "user",
      "cross-workspace",
      "/ssh",
      ["/ssh"],
      {
        kind: sshFiles.length ? "secret-material" : "generated-material",
        description: sshFiles.length ? `user SSH material sourced from ${sshFiles.map((file) => file.key).join(", ")}` : "user SSH material",
      },
    ),
    ephemeralRuntime: {
      mountRoot: "/run/workspace",
      paths: ["/run/workspace/tmp", "/run/workspace/pids", "/run/workspace/sockets"],
      staleArtifacts: ["/run/workspace/pids/paseo.pid"],
    },
  };
}

function normalizeAuthFiles(rawFiles: unknown): AuthFile[] {
  const files = Array.isArray(rawFiles) ? rawFiles : [];
  return files
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    .map((entry) => ({
      key: String(entry.key ?? ""),
      mountPath: String(entry.mount_path ?? ""),
      content:
        entry.content
          ? String(entry.content)
          : entry.source_path && fs.existsSync(String(entry.source_path))
            ? fs.readFileSync(String(entry.source_path), "utf8")
            : undefined,
      sourcePath: entry.source_path ? String(entry.source_path) : undefined
    }))
    .filter((entry) => entry.key && entry.mountPath);
}

function normalizePlainEnv(rawPlain: unknown): PlainEnvVar[] {
  if (!rawPlain || typeof rawPlain !== "object") {
    return [];
  }
  return Object.entries(rawPlain as Record<string, unknown>).map(([name, value]) => ({
    name,
    value: String(value ?? "")
  }));
}

function normalizeServicePorts(service: Record<string, unknown>): ServicePort[] {
  const ports = Array.isArray(service.ports) ? service.ports : [];
  if (ports.length > 0) {
    return ports
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
      .map((entry) => ({
        containerPort: String(entry.container_port ?? ""),
        nodePort: entry.node_port ? String(entry.node_port) : undefined,
        name: entry.name ? String(entry.name) : undefined
      }))
      .filter((entry) => entry.containerPort);
  }
  if (service.container_port) {
    return [
      {
        containerPort: String(service.container_port),
        nodePort: service.node_port ? String(service.node_port) : undefined
      }
    ];
  }
  return [];
}

export function loadWorkspace(project: string): WorkspaceSpec {
  const configPath = specCandidates(project).find((candidate) => fs.existsSync(candidate));
  if (!configPath) {
    throw new Error(`Config not found for project '${project}'`);
  }

  const data = (yaml.load(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<string, any>;
  const backend = (data.backend ?? {}) as Record<string, unknown>;
  const runtime = (data.runtime ?? {}) as Record<string, unknown>;
  const resources = (data.resources ?? {}) as Record<string, unknown>;
  const agent = (data.agent ?? {}) as Record<string, unknown>;
  const tooling = (data.tooling ?? {}) as Record<string, unknown>;
  const auth = (data.auth ?? {}) as Record<string, unknown>;
  const env = (data.env ?? {}) as Record<string, unknown>;
  const service = (data.service ?? {}) as Record<string, unknown>;

  const projectName = String(data.project ?? project);
  const runtimeUser = String(runtime.user ?? "");
  const home = canonicalHome(runtimeUser || projectName, projectName);
  const backendKind = String(backend.kind ?? "pod") as WorkspaceSpec["backend"]["kind"];
  const authFiles = normalizeAuthFiles(auth.files);
  const plainEnvVars = normalizePlainEnv((env.plain ?? {}) as Record<string, unknown>);
  const persistState = Boolean(agent.persist_state ?? true);
  const claimName = String(runtime.storage_claim_name ?? `${projectName}-project`);
  const attachments = translateLegacyAttachments({
    projectName,
    home,
    persistState,
    claimName,
    authFiles,
    backendKind,
  });

  const workspace: WorkspaceSpec = {
    identity: { projectName },
    backend: {
      kind: backendKind,
      profile: backendKind === "pod" ? String(runtime.class ?? "kata-qemu") : backendKind === "docker" ? "legacy" : "vm",
      specFiles: Array.isArray(backend.spec_files) ? backend.spec_files.map((item) => String(item)) : [],
      dockerRuntimeMode: runtime.docker_enabled ? "legacy" : "disabled"
    },
    storage: {
      persistState,
      claimName,
      durablePaths: [
        ...attachments.workspaceData.durablePaths,
        ...attachments.workspaceRuntimeState.durablePaths,
        ...attachments.userIdentityState.durablePaths,
        ...attachments.userSshState.durablePaths,
      ]
    },
    attachments,
    resources: {
      cpu: String(resources.cpu ?? "2"),
      memory: String(resources.memory ?? "4Gi"),
      ephemeralStorage: String(resources.ephemeral_storage ?? "20Gi"),
      cpuRequest: resources.cpu_request ? String(resources.cpu_request) : undefined,
      memoryRequest: resources.memory_request ? String(resources.memory_request) : undefined,
      storageRequest: resources.ephemeral_storage_request ? String(resources.ephemeral_storage_request) : undefined,
      unbounded: Boolean(resources.unbounded ?? false)
    },
    runtime: {
      baseImage: String(runtime.base_image ?? "debian:trixie-slim"),
      user: runtimeUser || projectName,
      home,
      privileged: Boolean(runtime.privileged ?? false),
      agentLabel: String(agent.label ?? "None"),
      agentCmd: String(agent.kind ?? ""),
      agentArgs: Array.isArray(agent.args) ? agent.args.map((item) => String(item)) : [],
      bootstrapProfile: String(tooling.bootstrap_profile ?? "full"),
      aptPackages: Array.isArray(tooling.apt_packages) ? tooling.apt_packages.map((item) => String(item)) : [],
      installRustup: Boolean(tooling.install_rustup ?? false),
      gitCoreEditor: tooling.git_core_editor ? String(tooling.git_core_editor) : undefined,
      gitUserName: tooling.git_user_name ? String(tooling.git_user_name) : undefined,
      gitUserEmail: tooling.git_user_email ? String(tooling.git_user_email) : undefined,
      plainEnvVars,
      authFiles
    },
    connectivity: {
      exposeService: Boolean(service.enabled ?? false),
      serviceMode: String(service.mode ?? "nodeport") === "ingress" ? "ingress" : "nodeport",
      servicePorts: normalizeServicePorts(service),
      serviceHost: service.host ? String(service.host) : undefined,
      servicePath: String(service.path ?? "/")
    },
    lifecycle: {
      actions: ["create", "start", "stop", "restart", "rebuild", "status", "reconcile", "render", "apply"]
    },
    runtimeContract: {
      minimalInvariants: [
        `runtime home SHALL resolve to ${home}`,
        `${home}/.paseo SHALL assemble from workspace-runtime-state`,
        `${home}/.codex and ${home}/.claude SHALL assemble from user-identity-state`,
        `${home}/.ssh SHALL assemble from user-ssh-state with strict key permissions`,
      ],
      staleRuntimeArtifacts: [`${home}/.paseo/paseo.pid`, ...attachments.ephemeralRuntime.staleArtifacts],
    },
    health: {
      readinessMode: backendKind === "pod" && String(runtime.class ?? "") === "gvisor" && agent.kind ? "daemon-port" : "ready-file",
      requiresDaemon: Boolean(agent.kind)
    }
  };

  validateWorkspace(workspace);
  return workspace;
}
