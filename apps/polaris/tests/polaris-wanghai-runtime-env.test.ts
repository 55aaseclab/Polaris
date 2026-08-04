import assert from "node:assert/strict";
import test from "node:test";
import { renderDockerVault } from "../scripts/backends/docker/render.js";
import { renderKubevirtVault } from "../scripts/backends/kubevirt/render.js";
import { renderPodVault } from "../scripts/backends/pod/render.js";
import type { VaultSpec } from "../scripts/core/vault.js";
import {
  filterIntegratedWanghaiPlainEnvVars,
  sanitizeIntegratedWanghaiEnv,
} from "../scripts/security/wanghai-runtime-env.js";

test("integrated Wanghai receives neither standalone delivery credentials nor runtime overrides", () => {
  const input = [
    "# Shared standalone configuration",
    "SAFE_TOOL_TOKEN=keep",
    "SMTP_HOST=smtp.example.test",
    'SMTP_PASSWORD="first line',
    'second line"',
    "OUTREACH_FROM_EMAIL=operator@example.test",
    "WANGHAI_DATA_ROOT=/standalone/wanghai",
    "WANGHAI_GATEWAY_ASSERTION_SECRET=not-a-gateway-secret",
    "PORTAL_PROFILE_AUTH=1",
    "export CUSTOM_SURFACE_SETTING=keep",
    "",
  ].join("\n");

  assert.equal(
    sanitizeIntegratedWanghaiEnv(input),
    [
      "# Shared standalone configuration",
      "SAFE_TOOL_TOKEN=keep",
      "export CUSTOM_SURFACE_SETTING=keep",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    filterIntegratedWanghaiPlainEnvVars([
      { name: "SAFE_TOOL_TOKEN", value: "keep" },
      { name: "SMTP_PASSWORD", value: "secret" },
      { name: "OUTREACH_FROM_EMAIL", value: "operator@example.test" },
      { name: "WANGHAI_MAX_UPLOAD_BYTES", value: "999999999" },
      { name: "CUSTOM_SURFACE_SETTING", value: "keep" },
    ]),
    [
      { name: "SAFE_TOOL_TOKEN", value: "keep" },
      { name: "CUSTOM_SURFACE_SETTING", value: "keep" },
    ],
  );
});

test("all integrated renderers remove standalone Wanghai environment values", () => {
  const profileEnv = [
    "SMTP_HOST=smtp.example.test",
    "SMTP_PASSWORD=synthetic-password",
    "OUTREACH_FROM_EMAIL=operator@example.test",
    "WANGHAI_DATA_ROOT=/standalone/wanghai",
    "SAFE_SURFACE_SETTING=keep",
    "",
  ].join("\n");
  const previousMasterSecret = process.env.POLARIS_WANGHAI_GATEWAY_MASTER_SECRET;
  const previousOrigins = process.env.POLARIS_PORTAL_ALLOWED_ORIGINS;
  process.env.POLARIS_WANGHAI_GATEWAY_MASTER_SECRET = "0123456789abcdef0123456789abcdef";
  process.env.POLARIS_PORTAL_ALLOWED_ORIGINS = "https://polaris.example.test";
  try {
    const vault = verticalVault(profileEnv);
    const sanitized = Buffer.from("SAFE_SURFACE_SETTING=keep\n", "utf8").toString("base64");
    const unsanitized = Buffer.from(profileEnv, "utf8").toString("base64");
    const renderedByBackend = [
      ["docker", renderDockerVault(vault)],
      ["pod", renderPodVault(vault)],
      ["kubevirt", renderKubevirtVault(vault)],
    ] as const;
    for (const [backend, rendered] of renderedByBackend) {
      assert.match(rendered, new RegExp(sanitized));
      assert.doesNotMatch(rendered, new RegExp(unsanitized));
      assert.doesNotMatch(rendered, /SMTP_PASSWORD/);
      assert.doesNotMatch(rendered, /OUTREACH_FROM_EMAIL/);
      assert.doesNotMatch(rendered, /WANGHAI_DATA_ROOT=\/standalone\/wanghai/);
      if (backend !== "kubevirt") {
        assert.match(rendered, /SAFE_PLAIN_SETTING/);
      }
    }
  } finally {
    if (previousMasterSecret === undefined) delete process.env.POLARIS_WANGHAI_GATEWAY_MASTER_SECRET;
    else process.env.POLARIS_WANGHAI_GATEWAY_MASTER_SECRET = previousMasterSecret;
    if (previousOrigins === undefined) delete process.env.POLARIS_PORTAL_ALLOWED_ORIGINS;
    else process.env.POLARIS_PORTAL_ALLOWED_ORIGINS = previousOrigins;
  }
});

function verticalVault(profileEnv: string): VaultSpec {
  return {
    identity: { projectName: "synthetic-vault" },
    profile: {
      name: "Morpheus",
      assetBaseName: "morpheus",
      defaults: {},
    },
    userProfile: {
      id: "synthetic-tenant",
      name: "Synthetic Tenant",
      email: "tenant@example.test",
      secretsRoot: "config/users/synthetic-tenant",
      vaults: [],
      github: {},
      ssh: { mode: "managed-key", comment: "synthetic@example.test" },
      agentIdentity: { codex: "default", claude: "default" },
      authFiles: [],
    },
    credentials: [],
    credentialBindings: [],
    resolvedCredentialBindings: [],
    backend: {
      kind: "docker",
      profile: "gvisor",
      specFiles: [],
      dockerRuntimeMode: "disabled",
    },
    storage: {
      persistState: true,
      claimName: "synthetic-vault-data",
      durablePaths: [],
    },
    attachments: {
      vaultData: {
        kind: "vault-data",
        scope: "vault",
        sharing: "exclusive",
        mountRoot: "/vault/project",
        durablePaths: [],
        source: { kind: "persistent-volume", volumeRef: "synthetic-vault-data", volumeSize: "1Gi" },
      },
      vaultRuntimeState: {
        kind: "vault-runtime-state",
        scope: "vault",
        sharing: "exclusive",
        mountRoot: "/vault/state",
        durablePaths: [],
        source: { kind: "persistent-volume", volumeRef: "synthetic-vault-state", volumeSize: "128Mi" },
      },
      userIdentityState: {
        kind: "user-identity-state",
        scope: "user",
        sharing: "cross-vault",
        mountRoot: "/identity",
        durablePaths: [],
        source: { kind: "persistent-volume", volumeRef: "synthetic-identity", volumeSize: "64Mi" },
      },
      ephemeralRuntime: {
        mountRoot: "/run/vault",
        paths: [],
        staleArtifacts: [],
      },
    },
    resources: {
      cpu: "1",
      memory: "512Mi",
      ephemeralStorage: "512Mi",
      cpuRequest: "250m",
      memoryRequest: "128Mi",
      storageRequest: "128Mi",
      unbounded: false,
    },
    runtime: {
      baseImage: "example.test/wanghai@sha256:synthetic",
      rootdiskImage: "example.test/vm@sha256:synthetic",
      user: "root",
      home: "/root",
      privileged: false,
      agentLabel: "synthetic-agent",
      agentCmd: "",
      agentArgs: [],
      bootstrapProfile: "prebuilt",
      aptPackages: [],
      installRustup: false,
      plainEnvVars: [
        { name: "SMTP_PASSWORD", value: "synthetic-password" },
        { name: "SAFE_PLAIN_SETTING", value: "keep" },
      ],
      authFiles: [
        {
          key: "wanghai-root-env",
          mountPath: "/opt/wanghai/.env",
          content: profileEnv,
        },
      ],
    },
    agent: {
      enabled: false,
      managerId: "none",
      contractVersion: "v1",
      capabilities: {
        supportsEventStream: false,
        supportsTranscriptReplay: false,
        supportsStructuredArtifacts: false,
        supportsReview: false,
        supportsRetrieval: false,
        supportsCuration: false,
        requiresDaemon: false,
        supportsPairing: false,
      },
      harnesses: [],
      runtime: {
        stateRoot: "/vault/state",
        evolutionRoot: "/vault/state/evolution",
        daemonAddress: "",
        staleRuntimeArtifacts: [],
      },
    },
    connectivity: {
      exposeService: false,
      serviceMode: "nodeport",
      servicePorts: [{ name: "wanghai", containerPort: "9090" }],
      servicePath: "/",
    },
    lifecycle: { actions: [] },
    runtimeContract: { minimalInvariants: [], staleRuntimeArtifacts: [] },
    health: { readinessMode: "ready-file", requiresDaemon: false },
  };
}
