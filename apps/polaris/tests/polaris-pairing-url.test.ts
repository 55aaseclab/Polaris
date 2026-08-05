import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { loadVaultFromConfigPath, resolveVaultConfigPath } from "../scripts/config/load.js";
import {
  scaffoldDockerVault,
  verticalVaultBaseImage,
  vaultConfigPath,
} from "../scripts/config/scaffold.js";
import { ensureVaultConfig } from "../scripts/config/provision.js";
import { generatedOutputPath } from "../scripts/output/write-generated.js";
import { renderAndWriteDockerVault, renderDockerVault } from "../scripts/backends/docker/render.js";
import { renderAndWritePodVault, renderPodVault } from "../scripts/backends/pod/render.js";
import { renderKubevirtVault } from "../scripts/backends/kubevirt/render.js";
import { createCommand } from "../scripts/cli/commands/create.js";
import { vaultRuntimeResourceName } from "../scripts/core/vault-name.js";
import {
  applyPairingUrlScope,
  extractOfferFragment,
  normalizePairingUrl,
} from "../scripts/core/pairing-url.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const DEMO_USER_PROFILE_ID = "100000000000000001";

function loadVaultFromRefForTest(projectRef: string) {
  const resolved = resolveVaultConfigPath(projectRef);
  return loadVaultFromConfigPath(
    resolved.configPath,
    resolved.project,
    resolved.backendHint,
    resolved.profileHint,
  );
}

async function withTempVaultSpec(
  project: string,
  backendKind: "docker" | "pod" | "kubevirt-vm",
  fn: () => Promise<void> | void,
): Promise<void> {
  const outputPath = vaultConfigPath(project, backendKind, DEMO_USER_PROFILE_ID);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const sourcePath = vaultConfigPath("demo", backendKind, DEMO_USER_PROFILE_ID);
  const doc = (yaml.load(fs.readFileSync(sourcePath, "utf8")) ?? {}) as Record<string, unknown>;
  doc.project = project;
  doc.backend = {
    ...(typeof doc.backend === "object" && doc.backend ? doc.backend as Record<string, unknown> : {}),
    kind: backendKind,
  };

  fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
  const generatedPath = generatedOutputPath(loadVaultFromRefForTest(`${project}@${backendKind}`));
  try {
    await fn();
  } finally {
    fs.rmSync(outputPath, { force: true });
    fs.rmSync(generatedPath, { force: true });
  }
}

test("normalizePairingUrl rewrites the offer onto the configured Paseo app base URL", () => {
  const raw = "https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kZW1vIn0";
  assert.equal(extractOfferFragment(raw), "eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kZW1vIn0");
  assert.equal(
    normalizePairingUrl(raw, {
      POLARIS_PASEO_APP_BASE_URL: "http://portal.example.test:8082/",
    }),
    "http://portal.example.test:8082/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kZW1vIn0",
  );
});

test("vertical docker scaffold selects the Wanghai image, surfaces, and dual ports", () => {
  const project = `vertical-scaffold-${process.pid}-${Date.now()}`;
  const outputPath = scaffoldDockerVault(project, DEMO_USER_PROFILE_ID, {
    line: "vertical",
  });
  try {
    const doc = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as {
      env?: { plain?: Record<string, unknown> };
      runtime?: { base_image?: unknown };
      surfaces?: unknown;
      service?: {
        ports?: Array<{
          container_port?: unknown;
          name?: unknown;
        }>;
      };
    };

    assert.equal(doc.runtime?.base_image, verticalVaultBaseImage());
    assert.deepEqual(doc.surfaces, ["paseo", "wanghai"]);
    assert.deepEqual(doc.env?.plain, {
      WANGHAI_REPO_ROOT: "/opt/wanghai",
      WANGHAI_RUNTIME_MODE: "polaris",
    });
    assert.deepEqual(
      (doc.service?.ports ?? []).map((entry) => ({
        containerPort: String(entry.container_port ?? ""),
        name: String(entry.name ?? ""),
      })),
      [
        { containerPort: "6767", name: "paseo" },
        { containerPort: "9090", name: "wanghai" },
      ],
    );
  } finally {
    fs.rmSync(path.dirname(outputPath), { recursive: true, force: true });
  }
});

test("Paseo-free Wanghai test vaults render only a private portal surface", () => {
  const project = `wanghai-only-${process.pid}-${Date.now()}`;
  const previousMasterSecret = process.env.POLARIS_WANGHAI_GATEWAY_MASTER_SECRET;
  const previousPortalOrigins = process.env.POLARIS_PORTAL_ALLOWED_ORIGINS;
  process.env.POLARIS_WANGHAI_GATEWAY_MASTER_SECRET = "0123456789abcdef0123456789abcdef";
  process.env.POLARIS_PORTAL_ALLOWED_ORIGINS = "https://polaris.example.test";
  const outputPath = scaffoldDockerVault(project, DEMO_USER_PROFILE_ID, {
    line: "vertical",
    paseoFreeWanghaiTest: true,
  });
  try {
    const doc = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as {
      agent?: { kind?: unknown };
      service?: { ports?: Array<{ container_port?: unknown; name?: unknown }> };
      surfaces?: unknown;
      testing?: { paseo_free_wanghai?: unknown };
    };
    assert.equal(doc.testing?.paseo_free_wanghai, true);
    assert.equal(doc.agent?.kind, "none");
    assert.deepEqual(doc.surfaces, ["wanghai"]);
    assert.deepEqual(
      (doc.service?.ports ?? []).map((entry) => ({
        containerPort: String(entry.container_port ?? ""),
        name: String(entry.name ?? ""),
      })),
      [{ containerPort: "9090", name: "wanghai" }],
    );

    const vault = loadVaultFromRefForTest(`${project}@docker`);
    assert.equal(vault.agent.enabled, false);
    assert.equal(vault.agent.managerId, "none");
    const wanghaiPort = vault.connectivity.servicePorts[0]?.nodePort;
    assert.ok(wanghaiPort);
    const rendered = renderDockerVault(vault);
    assert.match(rendered, new RegExp(`127\\.0\\.0\\.1:${wanghaiPort}:9090`));
    assert.doesNotMatch(rendered, new RegExp(`- "${wanghaiPort}:9090"`));
    assert.doesNotMatch(rendered, /6767/);
    assert.doesNotMatch(rendered, /PASEO_HOME/);
    assert.doesNotMatch(rendered, /paseo daemon/);
    assert.doesNotMatch(rendered, /paseo daemon pair/);
    assert.match(rendered, /WANGHAI_RUNTIME_MODE: "polaris"/);

    const unmarked = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as Record<string, unknown>;
    delete unmarked.testing;
    fs.writeFileSync(outputPath, yaml.dump(unmarked, { lineWidth: 120, noRefs: true }), "utf8");
    assert.throws(
      () => loadVaultFromRefForTest(`${project}@docker`),
      /agent\.kind 'none' is reserved for testing\.paseo_free_wanghai Docker vaults/,
    );
  } finally {
    if (previousMasterSecret === undefined) delete process.env.POLARIS_WANGHAI_GATEWAY_MASTER_SECRET;
    else process.env.POLARIS_WANGHAI_GATEWAY_MASTER_SECRET = previousMasterSecret;
    if (previousPortalOrigins === undefined) delete process.env.POLARIS_PORTAL_ALLOWED_ORIGINS;
    else process.env.POLARIS_PORTAL_ALLOWED_ORIGINS = previousPortalOrigins;
    fs.rmSync(path.dirname(outputPath), { recursive: true, force: true });
  }
});

test("create --test-wanghai-only scaffolds the relay-safe Wanghai fixture", async () => {
  const project = `wanghai-only-create-${process.pid}-${Date.now()}`;
  const outputPath = vaultConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
  try {
    await createCommand([project, "--user", DEMO_USER_PROFILE_ID, "--test-wanghai-only"]);
    const doc = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as {
      agent?: { kind?: unknown };
      surfaces?: unknown;
      testing?: { paseo_free_wanghai?: unknown };
    };
    assert.equal(doc.testing?.paseo_free_wanghai, true);
    assert.equal(doc.agent?.kind, "none");
    assert.deepEqual(doc.surfaces, ["wanghai"]);
  } finally {
    fs.rmSync(path.dirname(outputPath), { recursive: true, force: true });
  }
});

test("vertical renders keep Wanghai private and tenant-vault qualified", () => {
  const project = `vertical-private-${process.pid}-${Date.now()}`;
  const previousMasterSecret = process.env.POLARIS_WANGHAI_GATEWAY_MASTER_SECRET;
  const previousPortalOrigins = process.env.POLARIS_PORTAL_ALLOWED_ORIGINS;
  process.env.POLARIS_WANGHAI_GATEWAY_MASTER_SECRET = "0123456789abcdef0123456789abcdef";
  process.env.POLARIS_PORTAL_ALLOWED_ORIGINS = "https://polaris.example.test";
  const outputPath = scaffoldDockerVault(project, DEMO_USER_PROFILE_ID, { line: "vertical" });
  try {
    const vault = loadVaultFromRefForTest(`${project}@docker`);
    const rendered = fs.readFileSync(renderAndWriteDockerVault(vault), "utf8");
    const wanghaiPort = vault.connectivity.servicePorts.find((port) => port.name === "wanghai");
    assert.ok(wanghaiPort?.nodePort);
    assert.match(rendered, new RegExp(`127\\.0\\.0\\.1:${wanghaiPort?.nodePort}:9090`));
    assert.doesNotMatch(rendered, new RegExp(`- "${wanghaiPort?.nodePort}:9090"`));
    assert.match(rendered, /tenants\/.+\/vaults\/.+/);
    assert.doesNotMatch(rendered, /export WANGHAI_GATEWAY_/);
    assert.match(rendered, /WANGHAI_RUNTIME_MODE: "polaris"/);
    assert.match(rendered, /WANGHAI_GATEWAY_ASSERTION_SECRET:/);
    assert.match(rendered, /WANGHAI_GATEWAY_FRAME_ANCESTORS:/);
    assert.match(rendered, /https:\/\/polaris\.example\.test/);

    const commandSecret = "synthetic-command-secret";
    const renderedWithCredentials = renderDockerVault({
      ...vault,
      runtime: {
        ...vault.runtime,
        plainEnvVars: [{ name: "SYNTHETIC_TOKEN", value: commandSecret }],
        authFiles: [
          ...vault.runtime.authFiles,
          {
            key: "synthetic-command-secret",
            mountPath: "/root/.config/synthetic-auth.json",
            content: commandSecret,
          },
        ],
      },
    });
    const command = renderedWithCredentials.slice(
      renderedWithCredentials.indexOf("    command:"),
      renderedWithCredentials.indexOf("    ports:"),
    );
    assert.doesNotMatch(command, /set -x/);
    assert.doesNotMatch(command, new RegExp(commandSecret));
    assert.doesNotMatch(command, new RegExp(Buffer.from(commandSecret, "utf8").toString("base64")));
    assert.match(renderedWithCredentials, /SYNTHETIC_TOKEN: "synthetic-command-secret"/);
    assert.match(renderedWithCredentials, /POLARIS_BOOTSTRAP_AUTH_FILE_\d+_B64:/);

    const podRendered = renderPodVault({
      ...vault,
      backend: { ...vault.backend, kind: "pod", profile: "gvisor" },
    });
    assert.doesNotMatch(podRendered, /export WANGHAI_GATEWAY_/);
    assert.match(podRendered, /type: ClusterIP[\s\S]+name: wanghai-private/);
    assert.doesNotMatch(podRendered, new RegExp(`nodePort: ${wanghaiPort?.nodePort}`));
    assert.match(podRendered, /startupProbe:[\s\S]+path: \/wanghai\/readyz/);
    assert.match(podRendered, /livenessProbe:[\s\S]+path: \/wanghai\/healthz/);
    assert.match(podRendered, /exec env WANGHAI_SUPERVISE_PORTAL=1/);
    assert.doesNotMatch(podRendered, /touch \/tmp\/.ready && sleep infinity/);

    ensureVaultConfig(`${project}@kubevirt-vm`, DEMO_USER_PROFILE_ID);
    const kubevirtVault = loadVaultFromRefForTest(`${project}@kubevirt-vm`);
    const kubevirtRendered = renderKubevirtVault(kubevirtVault);
    const privateServiceName = vaultRuntimeResourceName(
      DEMO_USER_PROFILE_ID,
      project,
      "wanghai",
    );
    const kubevirtDocs = yaml.loadAll(kubevirtRendered) as Array<Record<string, unknown>>;
    const wanghaiDeployment = kubevirtDocs.find(
      (document) => document.kind === "Deployment"
        && (document.metadata as Record<string, unknown> | undefined)?.name === privateServiceName,
    );
    assert.ok(wanghaiDeployment);
    const wanghaiPodSpec = (
      (wanghaiDeployment.spec as Record<string, unknown>).template as Record<string, unknown>
    ).spec as Record<string, unknown>;
    const wanghaiContainer = (
      wanghaiPodSpec.containers as Array<Record<string, unknown>>
    )[0];
    assert.ok(wanghaiContainer);
    assert.equal(wanghaiPodSpec.automountServiceAccountToken, false);
    assert.deepEqual(wanghaiPodSpec.securityContext, {
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      fsGroupChangePolicy: "OnRootMismatch",
      seccompProfile: { type: "RuntimeDefault" },
    });
    assert.deepEqual(wanghaiContainer.securityContext, {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    assert.deepEqual(wanghaiContainer.resources, {
      requests: {
        cpu: "100m",
        memory: "128Mi",
        "ephemeral-storage": "128Mi",
      },
      limits: {
        cpu: "500m",
        memory: "512Mi",
        "ephemeral-storage": "512Mi",
      },
    });
    assert.match(String((wanghaiContainer.args as string[])[0]), /ulimit -u 128/u);
    const gatewaySecretName = vaultRuntimeResourceName(
      DEMO_USER_PROFILE_ID,
      project,
      "wanghai-gateway",
    );
    const gatewaySecret = kubevirtDocs.find(
      (document) => document.kind === "Secret"
        && (document.metadata as Record<string, unknown> | undefined)?.name === gatewaySecretName,
    );
    assert.ok(gatewaySecret);
    assert.match(
      String((gatewaySecret.data as Record<string, unknown>)["assertion-secret"]),
      /^[A-Za-z0-9+/=]+$/u,
    );
    assert.deepEqual(
      (wanghaiContainer.env as Array<Record<string, unknown>>).find(
        (entry) => entry.name === "WANGHAI_GATEWAY_ASSERTION_SECRET",
      )?.valueFrom,
      { secretKeyRef: { name: gatewaySecretName, key: "assertion-secret" } },
    );
    const wanghaiEgressPolicy = kubevirtDocs.find(
      (document) => document.kind === "NetworkPolicy"
        && (document.metadata as Record<string, unknown> | undefined)?.name
          === vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "wanghai-egress"),
    );
    assert.ok(wanghaiEgressPolicy);
    assert.deepEqual(
      (wanghaiEgressPolicy.spec as Record<string, unknown>).egress,
      [
        {
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
        {
          ports: [
            { protocol: "TCP", port: 80 },
            { protocol: "TCP", port: 443 },
          ],
        },
      ],
    );
    assert.match(kubevirtRendered, new RegExp(`kind: Deployment[\\s\\S]+name: ${privateServiceName}`));
    assert.match(kubevirtRendered, /WANGHAI_GATEWAY_ASSERTION_SECRET/);
    assert.match(kubevirtRendered, new RegExp(`kind: Service[\\s\\S]+type: ClusterIP[\\s\\S]+app: ${privateServiceName}`));
    assert.doesNotMatch(kubevirtRendered, /containerPort: 9090[\\s\\S]+name: .*vm/);
    assert.doesNotMatch(
      kubevirtRendered,
      /claimRef:\n\s+namespace: .+\n\s+name: .+\n\s+name:/u,
    );
  } finally {
    fs.rmSync(path.dirname(outputPath), { recursive: true, force: true });
    fs.rmSync(vaultConfigPath(project, "kubevirt-vm", DEMO_USER_PROFILE_ID), { force: true });
    if (previousMasterSecret === undefined) delete process.env.POLARIS_WANGHAI_GATEWAY_MASTER_SECRET;
    else process.env.POLARIS_WANGHAI_GATEWAY_MASTER_SECRET = previousMasterSecret;
    if (previousPortalOrigins === undefined) delete process.env.POLARIS_PORTAL_ALLOWED_ORIGINS;
    else process.env.POLARIS_PORTAL_ALLOWED_ORIGINS = previousPortalOrigins;
  }
});

test("normalizePairingUrl preserves a user scope on the rewritten Paseo URL", () => {
  const raw = "https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9zY29wZWQifQ";
  assert.equal(
    normalizePairingUrl(
      raw,
      {
        POLARIS_PASEO_APP_BASE_URL: "https://portal.example.test/paseo/",
      },
      DEMO_USER_PROFILE_ID,
    ),
    `https://portal.example.test/paseo?scope=${DEMO_USER_PROFILE_ID}#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9zY29wZWQifQ`,
  );
});

test("applyPairingUrlScope appends scope when the pairing URL is already normalized", () => {
  assert.equal(
    applyPairingUrlScope("https://portal.example.test/paseo/#offer=demo", DEMO_USER_PROFILE_ID),
    `https://portal.example.test/paseo/?scope=${DEMO_USER_PROFILE_ID}#offer=demo`,
  );
});

test("docker render persists the configured Paseo app base URL into the runtime config bootstrap", async () => {
  const previous = process.env.POLARIS_PASEO_APP_BASE_URL;
  process.env.POLARIS_PASEO_APP_BASE_URL = "http://portal.example.test:8082";
  const project = `pairing-docker-${process.pid}-${Date.now()}`;
  try {
    await withTempVaultSpec(project, "docker", async () => {
      const vault = loadVaultFromRefForTest(`${project}@docker`);
      const rendered = fs.readFileSync(renderAndWriteDockerVault(vault), "utf8");
      assert.match(rendered, /baseUrl\\"\] = \\"http:\/\/portal\.example\.test:8082\\"/);
    });
  } finally {
    if (previous === undefined) {
      delete process.env.POLARIS_PASEO_APP_BASE_URL;
    } else {
      process.env.POLARIS_PASEO_APP_BASE_URL = previous;
    }
  }
});

test("docker render disables default Paseo voice features in the runtime config bootstrap", async () => {
  const project = `pairing-docker-voice-${process.pid}-${Date.now()}`;
  await withTempVaultSpec(project, "docker", async () => {
    const vault = loadVaultFromRefForTest(`${project}@docker`);
    const rendered = fs.readFileSync(renderAndWriteDockerVault(vault), "utf8");
    assert.ok(
      rendered.includes('data.setdefault(\\"features\\", {}).setdefault(\\"dictation\\", {})[\\"enabled\\"] = False'),
    );
    assert.ok(
      rendered.includes('data.setdefault(\\"features\\", {}).setdefault(\\"voiceMode\\", {})[\\"enabled\\"] = False'),
    );
  });
});

test("pod render persists the configured Paseo app base URL into the runtime config bootstrap", async () => {
  const previous = process.env.POLARIS_PASEO_APP_BASE_URL;
  process.env.POLARIS_PASEO_APP_BASE_URL = "http://portal.example.test:8082";
  const project = `pairing-pod-${process.pid}-${Date.now()}`;
  try {
    await withTempVaultSpec(project, "pod", async () => {
      const vault = loadVaultFromRefForTest(`${project}@pod`);
      const rendered = fs.readFileSync(renderAndWritePodVault(vault), "utf8");
      assert.match(rendered, /baseUrl\\"\] = \\"http:\/\/portal\.example\.test:8082\\"/);
    });
  } finally {
    if (previous === undefined) {
      delete process.env.POLARIS_PASEO_APP_BASE_URL;
    } else {
      process.env.POLARIS_PASEO_APP_BASE_URL = previous;
    }
  }
});

test("pod render disables default Paseo voice features in the runtime config bootstrap", async () => {
  const project = `pairing-pod-voice-${process.pid}-${Date.now()}`;
  await withTempVaultSpec(project, "pod", async () => {
    const vault = loadVaultFromRefForTest(`${project}@pod`);
    const rendered = fs.readFileSync(renderAndWritePodVault(vault), "utf8");
    assert.ok(
      rendered.includes('data.setdefault(\\"features\\", {}).setdefault(\\"dictation\\", {})[\\"enabled\\"] = False'),
    );
    assert.ok(
      rendered.includes('data.setdefault(\\"features\\", {}).setdefault(\\"voiceMode\\", {})[\\"enabled\\"] = False'),
    );
  });
});

test("kubevirt render persists the configured Paseo app base URL into cloud-init bootstrap", async () => {
  const previous = process.env.POLARIS_PASEO_APP_BASE_URL;
  process.env.POLARIS_PASEO_APP_BASE_URL = "http://portal.example.test:8082";
  const project = `pairing-vm-${process.pid}-${Date.now()}`;
  try {
    await withTempVaultSpec(project, "kubevirt-vm", async () => {
      const vault = loadVaultFromRefForTest(`${project}@kubevirt-vm`);
      const rendered = renderKubevirtVault(vault);
      assert.match(rendered, /data\.setdefault\("app", \{\}\)\["baseUrl"\] = "http:\/\/portal\.example\.test:8082";/);
    });
  } finally {
    if (previous === undefined) {
      delete process.env.POLARIS_PASEO_APP_BASE_URL;
    } else {
      process.env.POLARIS_PASEO_APP_BASE_URL = previous;
    }
  }
});

test("kubevirt render disables default Paseo voice features in cloud-init bootstrap", async () => {
  const project = `pairing-vm-voice-${process.pid}-${Date.now()}`;
  await withTempVaultSpec(project, "kubevirt-vm", async () => {
    const vault = loadVaultFromRefForTest(`${project}@kubevirt-vm`);
    const rendered = renderKubevirtVault(vault);
    assert.ok(
      rendered.includes('data.setdefault(\\"features\\", {}).setdefault(\\"dictation\\", {})[\\"enabled\\"] = False'),
    );
    assert.ok(
      rendered.includes('data.setdefault(\\"features\\", {}).setdefault(\\"voiceMode\\", {})[\\"enabled\\"] = False'),
    );
  });
});
