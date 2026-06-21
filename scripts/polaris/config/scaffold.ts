import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

export function workspaceConfigPath(project: string, backendKind: "docker" | "pod" | "kubevirt-vm" = "docker"): string {
  const backendDir = backendKind === "kubevirt-vm" ? "kubevirt" : backendKind;
  return path.join(REPO_ROOT, "config", "specs", backendDir, "projects", `${project}.agent.yaml`);
}

export function workspaceConfigExists(project: string): boolean {
  return [
    workspaceConfigPath(project, "docker"),
    workspaceConfigPath(project, "pod"),
    workspaceConfigPath(project, "kubevirt-vm"),
    path.join(REPO_ROOT, "agents", `${project}.agent.yaml`),
  ].some((candidate) => fs.existsSync(candidate));
}

export function scaffoldDockerWorkspace(project: string): string {
  const outputPath = workspaceConfigPath(project, "docker");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const doc = {
    project,
    user_profile: "100000000000000001",
    backend: {
      kind: "docker",
      spec_files: null,
    },
    runtime: {
      class: "docker",
      base_image: "ttl.sh/morpheus-prebuilt-1781875178:24h",
      user: "root",
      storage_claim_name: null,
      privileged: null,
      docker_enabled: true,
    },
    resources: {
      cpu: "8",
      memory: "16Gi",
      ephemeral_storage: "120Gi",
      cpu_request: "2",
      memory_request: "4Gi",
      ephemeral_storage_request: "20Gi",
      unbounded: true,
    },
    agent: {
      kind: "multi",
      label: "Codex + Claude Code",
      args: [],
      persist_state: true,
    },
    tooling: {
      bootstrap_profile: "prebuilt",
      install_rustup: true,
      git_core_editor: "vi",
    },
    env: {
      plain: {},
    },
    service: {
      enabled: true,
      mode: "nodeport",
      ports: [
        {
          container_port: "6767",
          node_port: "6767",
          name: "paseo",
        },
      ],
      host: null,
      path: "/",
    },
    attachments: {
      "workspace-data": {
        scope: "workspace",
        sharing: "exclusive",
        mount_root: "/workspace/project",
        durable_paths: ["/workspace/project"],
        source: {
          kind: "generated-material",
          description: `docker workspace data for ${project}`,
        },
      },
      "workspace-runtime-state": {
        scope: "workspace",
        sharing: "exclusive",
        mount_root: "/workspace/state",
        durable_paths: ["/workspace/state/paseo", "/workspace/state/paseo/evolution"],
        source: {
          kind: "generated-material",
          description: `docker workspace runtime state for ${project}`,
        },
      },
      "user-identity-state": {
        scope: "user",
        sharing: "cross-workspace",
        mount_root: "/identity",
        durable_paths: ["/identity/codex", "/identity/claude"],
        source: {
          kind: "secret-material",
          description: "user identity material sourced from spec auth files",
        },
      },
      "user-ssh-state": {
        scope: "user",
        sharing: "cross-workspace",
        mount_root: "/ssh",
        durable_paths: ["/ssh"],
        source: {
          kind: "generated-material",
          description: "user SSH material",
        },
      },
      "ephemeral-runtime": {
        mount_root: "/run/workspace",
        paths: ["/run/workspace/tmp", "/run/workspace/pids", "/run/workspace/sockets"],
        stale_artifacts: ["/root/.paseo/paseo.pid", "/run/workspace/pids/paseo.pid"],
      },
    },
    profile: "morpheus",
  };

  fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
  return outputPath;
}
